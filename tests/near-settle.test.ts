import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HOSTED_NEAR_PAYEES, handleFacilitator } from '../mcp/src/facilitator-http.js';
import { CIRCLE_USDC_NEAR_TESTNET, NEAR_TESTNET_RPC, type NearTransferView } from '../mcp/src/near-rail.js';
import {
  DELEGATE_ATTEMPT_CAP,
  NEAR_TESTNET_INDEXER,
  NEAR_VALIDITY_CAP_SECONDS,
  createNearSettler,
  encodeBase58,
  encodeDelegateAction,
  loadTestnetMemoRows,
  readNearTestnetAccessKey,
  readNearTestnetBlock,
  selectPaidMemo,
  type NearChain,
} from '../mcp/src/near-settle.js';
import { makeCtx } from './helpers.js';

const PAYEE = 'foundry.testnet';
const BUYER = 'buyer.testnet';
const OTHER = 'other.testnet';
const HASH = '7vSXp7gSz7DDdikV7UgwodzPYQ4FNFeCSuGdU3So8yEE';
const OTHER_HASH = '53LCBQv92Fp2h19FAnpx1Ng4NacFz1Ncxf3dbnZf47C';
const NOW = 1_700_000_000n;
const TOKEN = 'facilitator-test-token';

function view(over: Partial<NearTransferView> = {}): NearTransferView {
  return {
    finalExecutionStatus: 'FINAL',
    executionSucceeded: true,
    senderAccountId: BUYER,
    tokenContract: CIRCLE_USDC_NEAR_TESTNET,
    receiverId: PAYEE,
    amount: '10000',
    memo: 'memo-1',
    ...over,
  };
}

function directBody(over: {
  payTo?: string;
  amount?: string;
  network?: string;
  asset?: string;
  memo?: string;
  signerId?: string;
  txHash?: string;
  validAfter?: string;
  validBefore?: string;
} = {}) {
  const memo = over.memo ?? 'memo-1';
  return {
    x402Version: 2,
    paymentPayload: {
      network: 'near:testnet',
      payload: {
        signerId: over.signerId ?? BUYER,
        memo,
        ...(over.txHash ? { txHash: over.txHash } : {}),
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: over.network ?? 'near:testnet',
      amount: over.amount ?? '10000',
      asset: over.asset ?? CIRCLE_USDC_NEAR_TESTNET,
      payTo: over.payTo ?? PAYEE,
      validAfter: over.validAfter ?? String(NOW - 10n),
      validBefore: over.validBefore ?? String(NOW + 10n),
      extra: { method: 'ft_transfer', memo },
    },
  };
}

function chain(over: { height?: bigint; nonce?: bigint; fullAccess?: boolean; missing?: boolean } = {}): NearChain {
  return {
    blockHeight: async () => over.height ?? 1000n,
    accessKey: async () => (over.missing ? undefined : { nonce: over.nonce ?? 5n, fullAccess: over.fullAccess ?? true }),
  };
}

function signedDelegate(over: {
  deposit?: string;
  gas?: string;
  nonce?: string;
  maxBlockHeight?: string;
  amount?: string;
  memo?: string;
  payTo?: string;
  extraAction?: boolean;
  badSig?: boolean;
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const memo = over.memo ?? 'memo-1';
  const args = Buffer.from(JSON.stringify({
    receiver_id: over.payTo ?? PAYEE,
    amount: over.amount ?? '10000',
    memo,
  }));
  const message = encodeDelegateAction({
    senderId: BUYER,
    receiverId: CIRCLE_USDC_NEAR_TESTNET,
    methodName: 'ft_transfer',
    args,
    gas: BigInt(over.gas ?? '30000000000000'),
    deposit: BigInt(over.deposit ?? '1'),
    nonce: BigInt(over.nonce ?? '6'),
    maxBlockHeight: BigInt(over.maxBlockHeight ?? '1010'),
    publicKey: rawPub,
  });
  const digest = createHash('sha256').update(message).digest();
  const sig = sign(null, digest, privateKey);
  if (over.badSig) sig[0] = sig[0] === 0 ? 1 : 0;
  const action = {
    methodName: 'ft_transfer',
    deposit: over.deposit ?? '1',
    gas: over.gas ?? '30000000000000',
    args: args.toString('base64'),
  };
  return {
    delegateAction: {
      senderId: BUYER,
      receiverId: CIRCLE_USDC_NEAR_TESTNET,
      actions: over.extraAction ? [action, { ...action, methodName: 'ft_transfer_call' }] : [action],
      nonce: over.nonce ?? '6',
      maxBlockHeight: over.maxBlockHeight ?? '1010',
      publicKey: `ed25519:${encodeBase58(rawPub)}`,
    },
    signature: `ed25519:${encodeBase58(sig)}`,
  };
}

function delegateBody(signed: ReturnType<typeof signedDelegate>, over: { amount?: string; payTo?: string; memo?: string } = {}) {
  const memo = over.memo ?? 'memo-1';
  return {
    x402Version: 2,
    paymentPayload: { network: 'near:testnet', payload: { signedDelegate: signed } },
    paymentRequirements: {
      scheme: 'exact',
      network: 'near:testnet',
      amount: over.amount ?? '10000',
      asset: CIRCLE_USDC_NEAR_TESTNET,
      payTo: over.payTo ?? PAYEE,
      validAfter: String(NOW - 10n),
      validBefore: String(NOW + 10n),
      extra: { method: 'ft_transfer', memo },
    },
  };
}

function settler(opts: {
  rows?: ReturnType<typeof view>[];
  find?: (signerId: string) => Promise<readonly { hash?: string; memo?: string | null; delta?: string | null; token?: string | null; receiver?: string | null; amount?: string | null }[]>;
  relay?: (delegate: unknown) => Promise<{ txHash: string; senderAccountId: string }>;
  chain?: NearChain;
  allow?: readonly string[];
  seen?: string[];
} = {}) {
  return createNearSettler({
    allowPayTo: opts.allow ?? [PAYEE],
    nowSec: () => NOW,
    readReceipt: async (txHash, txSigner, tokenSender) => {
      opts.seen?.push(`${txSigner}:${tokenSender ?? txSigner}:${txHash}`);
      const row = opts.rows?.find((item) => item.memo && txHash) ?? view();
      return { ...row, senderAccountId: tokenSender ?? txSigner };
    },
    findRows: opts.find,
    relay: opts.relay,
    chain: opts.chain,
  });
}

describe('near settler module', () => {
  it('selects the outgoing memo the way findPaidMemo does', () => {
    const found = selectPaidMemo(
      [
        { memo: 'other', hash: HASH, delta: '-10000', token: CIRCLE_USDC_NEAR_TESTNET, receiver: PAYEE, amount: '10000' },
        { memo: 'memo-1', hash: HASH, delta: '-10000', token: CIRCLE_USDC_NEAR_TESTNET, receiver: PAYEE, amount: '10000' },
      ],
      { nonce: 'memo-1', payTo: PAYEE, amount: '10000', asset: CIRCLE_USDC_NEAR_TESTNET },
    );
    expect(found.hash).toBe(HASH);
  });

  it('rejects a memo that hit the wrong receiver', () => {
    const found = selectPaidMemo(
      [{ memo: 'memo-1', hash: HASH, delta: '-10000', token: CIRCLE_USDC_NEAR_TESTNET, receiver: OTHER, amount: '10000' }],
      { nonce: 'memo-1', payTo: PAYEE, amount: '10000', asset: CIRCLE_USDC_NEAR_TESTNET },
    );
    expect(found.hash).toBeUndefined();
    expect(found.mismatch).toContain('memo matched');
  });

  it('does not read the environment when the payee is off the foundry list', async () => {
    const prev = process.env.CLEARING_NEAR_PAY_TO;
    const extra = process.env.CLEARING_FACILITATOR_PAYTOS;
    process.env.CLEARING_NEAR_PAY_TO = OTHER;
    process.env.CLEARING_FACILITATOR_PAYTOS = OTHER;
    const reads: string[] = [];
    try {
      const result = await settler({ seen: reads }).verify(directBody({ payTo: OTHER, txHash: HASH }));
      expect(result).toEqual({ isValid: false, invalidReason: 'payTo is not an allowed treasury' });
      expect(reads).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLEARING_NEAR_PAY_TO;
      else process.env.CLEARING_NEAR_PAY_TO = prev;
      if (extra === undefined) delete process.env.CLEARING_FACILITATOR_PAYTOS;
      else process.env.CLEARING_FACILITATOR_PAYTOS = extra;
    }
  });

  it('rejects mainnet before any chain read', async () => {
    const reads: string[] = [];
    const result = await settler({ seen: reads }).verify(directBody({ network: 'near:mainnet', txHash: HASH }));
    expect(result).toEqual({ isValid: false, invalidReason: 'mainnet cannot accept a testnet payee' });
    expect(reads).toEqual([]);
  });

  it('rejects an amount that is not the quote', async () => {
    const reads: string[] = [];
    const result = await settler({ seen: reads, rows: [view({ amount: '10001' })] }).settle(directBody({ txHash: HASH }));
    expect(result).toEqual({ success: false, errorReason: 'amount does not match requirements' });
  });

  it('accepts the window at validAfter and rejects it at validBefore', async () => {
    const open = await settler({ rows: [view()] }).verify(directBody({ txHash: HASH, validAfter: String(NOW) }));
    expect(open).toEqual({ isValid: true });
    const closed = await settler().verify(directBody({ txHash: HASH, validBefore: String(NOW) }));
    expect(closed).toEqual({ isValid: false, invalidReason: 'authorization is outside validAfter/validBefore' });
  });

  it('settles a direct ft_transfer once and returns the same hash', async () => {
    const foundry = settler({ rows: [view()] });
    const body = directBody({ txHash: HASH });
    expect(await foundry.settle(body)).toEqual({ success: true, transaction: HASH });
    expect(await foundry.settle(body)).toEqual({ success: true, transaction: HASH, replayed: true });
    const other = await foundry.settle(directBody({ txHash: OTHER_HASH }));
    expect(other).toEqual({ success: false, errorReason: 'payment already used' });
  });

  it('finds a paid memo when the payload has no tx hash', async () => {
    const foundry = settler({
      find: async () => [{ memo: 'memo-1', hash: HASH, delta: '-10000', token: CIRCLE_USDC_NEAR_TESTNET, receiver: PAYEE, amount: '10000' }],
      rows: [view()],
    });
    expect(await foundry.settle(directBody())).toEqual({ success: true, transaction: HASH });
  });

  it('rejects a validity window longer than the Base cap', async () => {
    const open = await settler({ rows: [view()] }).verify(directBody({
      txHash: HASH,
      validAfter: String(NOW),
      validBefore: String(NOW + NEAR_VALIDITY_CAP_SECONDS),
    }));
    expect(open).toEqual({ isValid: true });
    const wide = await settler().verify(directBody({
      txHash: HASH,
      validAfter: String(NOW),
      validBefore: String(NOW + NEAR_VALIDITY_CAP_SECONDS + 1n),
    }));
    expect(wide).toEqual({ isValid: false, invalidReason: 'validity window exceeds 60 seconds' });
  });

  it('verifies a signed delegate against the access key and relays it once', async () => {
    const calls: string[] = [];
    const bare = settler({ chain: chain() });
    const body = delegateBody(signedDelegate());
    expect(await bare.verify(body)).toEqual({ isValid: true });
    expect(await bare.settle(body)).toEqual({ success: false, errorReason: 'relayer is not configured' });
    const relayed = settler({
      chain: chain(),
      relay: async () => {
        calls.push('relay');
        return { txHash: HASH, senderAccountId: BUYER };
      },
      rows: [view()],
    });
    expect(await relayed.settle(body)).toEqual({ success: true, transaction: HASH });
    expect(await relayed.settle(body)).toEqual({ success: true, transaction: HASH, replayed: true });
    expect(calls).toEqual(['relay']);
  });

  it('rejects a bad signature, an extra action, a stale nonce, and a short block height before relay', async () => {
    const calls: string[] = [];
    const foundry = settler({
      chain: chain(),
      relay: async () => {
        calls.push('relay');
        return { txHash: HASH, senderAccountId: BUYER };
      },
    });
    expect(await foundry.verify(delegateBody(signedDelegate({ badSig: true })))).toEqual({
      isValid: false,
      invalidReason: 'delegate signature does not match the public key',
    });
    expect(await foundry.verify(delegateBody(signedDelegate({ extraAction: true })))).toEqual({
      isValid: false,
      invalidReason: 'delegate must contain exactly one action',
    });
    expect(await foundry.verify(delegateBody(signedDelegate({ nonce: '5' })))).toEqual({
      isValid: false,
      invalidReason: 'delegate nonce is not above the access key nonce',
    });
    expect(await foundry.verify(delegateBody(signedDelegate({ maxBlockHeight: '1000' })))).toEqual({
      isValid: false,
      invalidReason: 'delegate max_block_height is not above the current block',
    });
    expect(calls).toEqual([]);
  });

  it('queries a relayed transfer with the relayer and matches the payer', async () => {
    const calls: string[] = [];
    const foundry = settler({
      chain: chain(),
      seen: calls,
      relay: async () => ({ txHash: HASH, senderAccountId: 'relayer.testnet' }),
      rows: [view()],
    });
    expect(await foundry.settle(delegateBody(signedDelegate()))).toEqual({ success: true, transaction: HASH });
    expect(calls).toEqual([`relayer.testnet:${BUYER}:${HASH}`]);
  });

  it('rejects a key that is missing or not full access', async () => {
    const missing = settler({ chain: chain({ missing: true }) });
    expect(await missing.verify(delegateBody(signedDelegate()))).toEqual({
      isValid: false,
      invalidReason: 'delegate public key is not an access key',
    });
    const limited = settler({ chain: chain({ fullAccess: false }) });
    expect(await limited.verify(delegateBody(signedDelegate()))).toEqual({
      isValid: false,
      invalidReason: 'delegate public key is not a full access key',
    });
  });

  it('locks a delegate before relay and does not relay a failed one again', async () => {
    expect(DELEGATE_ATTEMPT_CAP).toBe(1);
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const overlapping = settler({
      chain: chain(),
      relay: async () => {
        calls += 1;
        await hold;
        return { txHash: HASH, senderAccountId: BUYER };
      },
      rows: [view()],
    });
    const body = delegateBody(signedDelegate());
    const first = overlapping.settle(body);
    const second = overlapping.settle(body);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    release();
    const settled = await Promise.all([first, second]);
    expect(settled.filter((row) => row.success && !('replayed' in row && row.replayed))).toHaveLength(1);
    expect(settled.some((row) => !row.success && row.errorReason === 'delegate is already settling')).toBe(true);

    let failedCalls = 0;
    const failed = settler({
      chain: chain(),
      relay: async () => {
        failedCalls += 1;
        throw new Error('relay down');
      },
    });
    const failedBody = delegateBody(signedDelegate({ memo: 'memo-fail' }), { memo: 'memo-fail' });
    expect(await failed.settle(failedBody)).toEqual({ success: false, errorReason: 'relayer did not return a tx hash' });
    expect(await failed.settle(failedBody)).toEqual({ success: false, errorReason: 'delegate relay attempt cap reached' });
    expect(failedCalls).toBe(1);
  });

  it('rejects a delegate whose deposit is not 1 yocto', async () => {
    const result = await settler().verify(delegateBody(signedDelegate({ deposit: '0' })));
    expect(result).toEqual({ isValid: false, invalidReason: 'delegate deposit is not 1 yocto' });
  });

  it('reads the access key and the block from testnet RPC only', async () => {
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === 'block') return new Response(JSON.stringify({ result: { header: { height: 1000 } } }));
      return new Response(JSON.stringify({ result: { nonce: 5, permission: 'FullAccess' } }));
    };
    expect(await readNearTestnetBlock(fetchFn as typeof fetch)).toBe(1000n);
    expect(await readNearTestnetAccessKey(BUYER, 'ed25519:key', fetchFn as typeof fetch)).toEqual({ nonce: 5n, fullAccess: true });
    expect(urls).toEqual([NEAR_TESTNET_RPC, NEAR_TESTNET_RPC]);
  });

  it('loads memo rows from the testnet indexer only', async () => {
    const urls: string[] = [];
    const hash = HASH;
    const fetchFn = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url.includes('/ft-txns')) {
        return new Response(JSON.stringify({ txns: [{ transaction_hash: hash, delta_amount: '-10000' }] }));
      }
      return new Response(JSON.stringify({
        txns: [{
          actions: [{ method: 'ft_transfer', args: JSON.stringify({ receiver_id: PAYEE, amount: '10000', memo: 'memo-1' }) }],
        }],
      }));
    };
    const rows = await loadTestnetMemoRows(BUYER, fetchFn as typeof fetch);
    expect(rows[0]?.hash).toBe(hash);
    expect(rows[0]?.memo).toBe('memo-1');
    expect(urls.every((url) => url.startsWith(NEAR_TESTNET_INDEXER))).toBe(true);
    expect(urls.some((url) => url.includes('mainnet'))).toBe(false);
  });
});

describe('hosted near route', () => {
  it('does not take a hosted payee from the environment', async () => {
    const prevToken = process.env.CLEARING_FACILITATOR_TOKEN;
    const prevNear = process.env.CLEARING_NEAR_PAY_TO;
    const prevExtra = process.env.CLEARING_FACILITATOR_PAYTOS;
    process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
    process.env.CLEARING_NEAR_PAY_TO = PAYEE;
    process.env.CLEARING_FACILITATOR_PAYTOS = PAYEE;
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      return new Response('unexpected', { status: 500 });
    };
    try {
      expect(HOSTED_NEAR_PAYEES).toEqual(['clearing-treasury-0xray.testnet']);
      expect(HOSTED_NEAR_PAYEES.every((id) => id.endsWith('.testnet'))).toBe(true);
      const ctx = makeCtx({}, { config: { nearPayTo: PAYEE } });
      const res = await handleFacilitator(
        new Request('https://clearing.test/settle', {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(directBody({ txHash: HASH })),
        }),
        ctx,
        { fetchFn: fetchFn as typeof fetch, nowSec: NOW },
      );
      expect(res?.status).toBe(200);
      expect(await res?.json()).toEqual({ success: false, errorReason: 'payTo is not an allowed treasury' });
      expect(urls).toEqual([]);
    } finally {
      if (prevToken === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
      else process.env.CLEARING_FACILITATOR_TOKEN = prevToken;
      if (prevNear === undefined) delete process.env.CLEARING_NEAR_PAY_TO;
      else process.env.CLEARING_NEAR_PAY_TO = prevNear;
      if (prevExtra === undefined) delete process.env.CLEARING_FACILITATOR_PAYTOS;
      else process.env.CLEARING_FACILITATOR_PAYTOS = prevExtra;
    }
  });

  it('rejects a testnet payee on near:mainnet before any RPC', async () => {
    const prev = process.env.CLEARING_FACILITATOR_TOKEN;
    process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      return new Response('unexpected', { status: 500 });
    };
    try {
      const res = await handleFacilitator(
        new Request('https://clearing.test/verify', {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(directBody({
            payTo: 'clearing-treasury-0xray.testnet',
            network: 'near:mainnet',
            txHash: HASH,
          })),
        }),
        makeCtx(),
        { fetchFn: fetchFn as typeof fetch, nowSec: NOW },
      );
      expect(await res?.json()).toEqual({ isValid: false, invalidReason: 'mainnet cannot accept a testnet payee' });
      expect(urls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
      else process.env.CLEARING_FACILITATOR_TOKEN = prev;
    }
  });
});
