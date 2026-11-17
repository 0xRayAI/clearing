/**
 * Live NEAR testnet walk. Skipped unless NEAR_TESTNET_WALK=1.
 * Keys stay in NEAR_WALK_KEYS (default /tmp/clearing-near-keys/accounts.json).
 * This file never prints a key, a seed, or a mnemonic.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOSTED_NEAR_PAYEES, handleFacilitator } from '../mcp/src/facilitator-http.js';
import { CIRCLE_USDC_NEAR_TESTNET, NEAR_TESTNET_RPC, readNearTestnetReceipt } from '../mcp/src/near-rail.js';
import {
  createNearSettler,
  decodeBase58,
  encodeBase58,
  encodeDelegateAction,
  readNearTestnetAccessKey,
  readNearTestnetBlock,
} from '../mcp/src/near-settle.js';
import { makeCtx } from './helpers.js';

const WALK = process.env.NEAR_TESTNET_WALK === '1';
const KEYS = process.env.NEAR_WALK_KEYS || '/tmp/clearing-near-keys/accounts.json';
const TREASURY = 'clearing-treasury-0xray.testnet';
const PAYER = 'clearing-payer-0xray.testnet';
const AMOUNT = '10000';
const TOKEN = 'near-walk-token';

type Account = { accountId: string; publicKey: string; secretKey: string };

function redact(value: string): string {
  return value.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, 'ed25519:[redacted]');
}

function loadAccounts(): { treasury: Account; payer: Account } {
  const parsed = JSON.parse(readFileSync(KEYS, 'utf8')) as { treasury?: Account; payer?: Account };
  if (parsed.treasury?.accountId !== TREASURY || parsed.payer?.accountId !== PAYER) {
    throw new Error('walk keys file is missing the treasury or payer account id');
  }
  if (!parsed.treasury.secretKey.startsWith('ed25519:') || !parsed.payer.secretKey.startsWith('ed25519:')) {
    throw new Error('walk keys file is missing an ed25519 key');
  }
  return { treasury: parsed.treasury, payer: parsed.payer };
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function borshStr(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

function rawKey(account: Account): { seed: Buffer; publicKey: Buffer } {
  const secret = decodeBase58(account.secretKey.slice('ed25519:'.length));
  if (!secret || secret.length !== 64) throw new Error(`walk key for ${account.accountId} is not 64 bytes`);
  return { seed: secret.subarray(0, 32), publicKey: secret.subarray(32) };
}

function signDigest(seed: Buffer, digest: Buffer): Buffer {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return sign(null, digest, key);
}

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(NEAR_TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'walk', method, params }),
  });
  return await res.json() as Record<string, unknown>;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const body = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: CIRCLE_USDC_NEAR_TESTNET,
    method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64'),
  });
  const result = body.result as { result?: number[] } | undefined;
  if (!result?.result) throw new Error(`balance read failed for ${accountId}`);
  return BigInt(JSON.parse(Buffer.from(result.result).toString('utf8')) as string);
}

async function relayDelegate(relayer: Account, payerId: string, message: Buffer, signature: Buffer): Promise<string> {
  const { seed, publicKey } = rawKey(relayer);
  const block = await rpc('block', { finality: 'final' });
  const header = (block.result as { header?: { hash?: string } } | undefined)?.header;
  if (!header?.hash) throw new Error('testnet block hash missing');
  const blockHash = decodeBase58(header.hash);
  if (!blockHash) throw new Error('testnet block hash is not base58');
  const access = await readNearTestnetAccessKey(relayer.accountId, relayer.publicKey, fetch);
  if (!access) throw new Error(`no access key for ${relayer.accountId}`);
  const action = Buffer.concat([Buffer.from([8]), message.subarray(4), Buffer.from([0]), signature]);
  const tx = Buffer.concat([
    borshStr(relayer.accountId),
    Buffer.from([0]),
    publicKey,
    u64(access.nonce + 1n),
    borshStr(payerId),
    blockHash,
    u32(1),
    action,
  ]);
  const digest = createHash('sha256').update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), signDigest(seed, digest)]);
  const sent = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'FINAL' });
  const result = sent.result as { final_execution_status?: string; status?: { Failure?: unknown } } | undefined;
  if (!result || result.status?.Failure || result.final_execution_status !== 'FINAL') {
    const detail = redact(JSON.stringify(result?.status?.Failure ?? sent.error ?? 'no-result')).slice(0, 400);
    throw new Error(`relay was not final for ${relayer.accountId}: ${detail}`);
  }
  return encodeBase58(digest);
}

describe.skipIf(!WALK)('NEAR testnet walk', () => {
  it('relays one delegate and the hosted route accepts the treasury', async () => {
    const { treasury, payer } = loadAccounts();
    const beforePayer = await balanceOf(PAYER);
    const beforeTreasury = await balanceOf(TREASURY);
    expect(beforePayer > BigInt(AMOUNT)).toBe(true);
    const memo = `walk39-${Date.now()}`;
    const height = await readNearTestnetBlock(fetch);
    const payerKey = await readNearTestnetAccessKey(payer.accountId, payer.publicKey, fetch);
    if (!payerKey?.fullAccess) throw new Error(`payer ${PAYER} has no full access key`);
    const { seed, publicKey } = rawKey(payer);
    const args = Buffer.from(JSON.stringify({ receiver_id: TREASURY, amount: AMOUNT, memo }));
    const message = encodeDelegateAction({
      senderId: PAYER,
      receiverId: CIRCLE_USDC_NEAR_TESTNET,
      methodName: 'ft_transfer',
      args,
      gas: 30_000_000_000_000n,
      deposit: 1n,
      nonce: payerKey.nonce + 1n,
      maxBlockHeight: height + 59n,
      publicKey,
    });
    const signature = signDigest(seed, createHash('sha256').update(message).digest());
    const signedDelegate = {
      delegateAction: {
        senderId: PAYER,
        receiverId: CIRCLE_USDC_NEAR_TESTNET,
        actions: [{
          methodName: 'ft_transfer',
          deposit: '1',
          gas: '30000000000000',
          args: args.toString('base64'),
        }],
        nonce: (payerKey.nonce + 1n).toString(),
        maxBlockHeight: (height + 59n).toString(),
        publicKey: payer.publicKey,
      },
      signature: `ed25519:${encodeBase58(signature)}`,
    };
    const now = BigInt(Math.floor(Date.now() / 1000));
    const body = {
      x402Version: 2,
      paymentPayload: { network: 'near:testnet', payload: { signedDelegate } },
      paymentRequirements: {
        scheme: 'exact',
        network: 'near:testnet',
        amount: AMOUNT,
        asset: CIRCLE_USDC_NEAR_TESTNET,
        payTo: TREASURY,
        validAfter: (now - 5n).toString(),
        validBefore: (now + 55n).toString(),
        extra: { method: 'ft_transfer', memo },
      },
    };
    let relays = 0;
    const settler = createNearSettler({
      allowPayTo: [TREASURY],
      nowSec: () => BigInt(Math.floor(Date.now() / 1000)),
      readReceipt: (txHash, txSigner, tokenSender) => readNearTestnetReceipt(txHash, txSigner, fetch, tokenSender),
      chain: {
        blockHeight: () => readNearTestnetBlock(fetch),
        accessKey: (accountId, key) => readNearTestnetAccessKey(accountId, key, fetch),
      },
      relay: async () => {
        relays += 1;
        const txHash = await relayDelegate(treasury, PAYER, message, signature);
        return { txHash, senderAccountId: TREASURY };
      },
    });
    const verified = await settler.verify(body);
    expect(verified).toEqual({ isValid: true });
    const settled = await settler.settle(body);
    if (!settled.success) throw new Error(redact(settled.errorReason));
    const again = await settler.settle(body);
    expect(again).toEqual({ success: true, transaction: settled.transaction, replayed: true });
    expect(relays).toBe(1);
    const afterPayer = await balanceOf(PAYER);
    const afterTreasury = await balanceOf(TREASURY);
    expect(afterTreasury - beforeTreasury).toBe(BigInt(AMOUNT));
    expect(beforePayer - afterPayer).toBe(BigInt(AMOUNT));

    process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
    const direct = {
      ...body,
      paymentPayload: {
        network: 'near:testnet',
        payload: { signerId: PAYER, txSigner: TREASURY, memo, txHash: settled.transaction },
      },
    };
    const hosted = await handleFacilitator(
      new Request('https://clearing.test/settle', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(direct),
      }),
      makeCtx(),
    );
    expect(await hosted?.json()).toEqual({ success: true, transaction: settled.transaction });
    expect(relays).toBe(1);
    const mainnet = await handleFacilitator(
      new Request('https://clearing.test/verify', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...direct,
          paymentRequirements: { ...direct.paymentRequirements, network: 'near:mainnet' },
        }),
      }),
      makeCtx(),
    );
    expect(await mainnet?.json()).toEqual({ isValid: false, invalidReason: 'mainnet cannot accept a testnet payee' });
    expect(HOSTED_NEAR_PAYEES).toContain(TREASURY);

    const receiptPath = new URL('../scripts/near-testnet-receipt.md', import.meta.url);
    const header = [
      '# NEAR testnet walk',
      '',
      'Network: NEAR testnet. No mainnet call.',
      '',
      'Each walk is a new memo and its own relay. The in-process replay is a second settle of that same memo in the same process.',
      '',
      `| Role | Account |`,
      `| --- | --- |`,
      `| Treasury payee | ${TREASURY} |`,
      `| Payer | ${PAYER} |`,
      `| Relayer | ${TREASURY} |`,
      '',
    ].join('\n');
    const walk = [
      `## Walk ${memo}`,
      '',
      `Relay [${settled.transaction}](https://testnet.nearblocks.io/txns/${settled.transaction}) moved ${AMOUNT} testnet USDC.`,
      `In-process replay held: the second settle of memo ${memo} returned ${settled.transaction} and the relay count stayed ${relays}.`,
      `Treasury USDC before this relay: ${beforeTreasury.toString()}. After: ${afterTreasury.toString()}.`,
      `Payer USDC before this relay: ${beforePayer.toString()}. After: ${afterPayer.toString()}.`,
      '',
    ].join('\n');
    const prior = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : '';
    const receipt = prior.includes(`## Walk ${memo}`) ? prior : (prior.startsWith('# NEAR testnet walk') ? `${prior.trim()}\n\n${walk}` : `${header}\n${walk}`);
    writeFileSync(receiptPath, receipt);
    expect(redact(receipt).includes('ed25519:')).toBe(false);
  }, 180_000);
});
