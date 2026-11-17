import { describe, expect, it } from 'vitest';
import { handleFacilitator } from '../mcp/src/facilitator-http.js';
import { CIRCLE_USDC_NEAR_TESTNET, NEAR_TESTNET_RPC, type NearTransferView } from '../mcp/src/near-rail.js';
import {
  NEAR_TESTNET_INDEXER,
  createNearSettler,
  loadTestnetMemoRows,
  selectPaidMemo,
  type NearDelegate,
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

function delegateBody(delegate: NearDelegate, over: { amount?: string; payTo?: string; memo?: string } = {}) {
  const memo = over.memo ?? delegate.memo;
  return {
    x402Version: 2,
    paymentPayload: {
      network: 'near:testnet',
      payload: {
        signedDelegate: {
          delegateAction: {
            senderId: delegate.senderId,
            receiverId: delegate.receiverId,
            actions: [{
              methodName: delegate.methodName,
              deposit: delegate.deposit,
              args: { receiver_id: delegate.receiver_id, amount: delegate.amount, memo: delegate.memo },
            }],
          },
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'near:testnet',
      amount: over.amount ?? delegate.amount,
      asset: CIRCLE_USDC_NEAR_TESTNET,
      payTo: over.payTo ?? delegate.receiver_id,
      validAfter: String(NOW - 10n),
      validBefore: String(NOW + 10n),
      extra: { method: 'ft_transfer', memo },
    },
  };
}

function settler(opts: {
  rows?: ReturnType<typeof view>[];
  find?: (signerId: string) => Promise<readonly { hash?: string; memo?: string | null; delta?: string | null; token?: string | null; receiver?: string | null; amount?: string | null }[]>;
  relay?: (delegate: NearDelegate) => Promise<{ txHash: string; senderAccountId: string }>;
  allow?: readonly string[];
  seen?: string[];
} = {}) {
  return createNearSettler({
    allowPayTo: opts.allow ?? [PAYEE],
    nowSec: () => NOW,
    readReceipt: async (txHash, sender) => {
      opts.seen?.push(`${sender}:${txHash}`);
      const row = opts.rows?.find((item) => item.memo && txHash) ?? view();
      return { ...row, senderAccountId: sender };
    },
    findRows: opts.find,
    relay: opts.relay,
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
    expect(result).toEqual({ isValid: false, invalidReason: 'network is not near testnet' });
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

  it('verifies a delegate locally and settles it only through the foundry relayer', async () => {
    const delegate: NearDelegate = {
      senderId: BUYER,
      receiverId: CIRCLE_USDC_NEAR_TESTNET,
      methodName: 'ft_transfer',
      deposit: '1',
      receiver_id: PAYEE,
      amount: '10000',
      memo: 'memo-1',
    };
    const calls: string[] = [];
    const bare = settler();
    expect(await bare.verify(delegateBody(delegate))).toEqual({ isValid: true });
    expect(await bare.settle(delegateBody(delegate))).toEqual({ success: false, errorReason: 'relayer is not configured' });
    const relayed = settler({
      relay: async () => {
        calls.push('relay');
        return { txHash: HASH, senderAccountId: BUYER };
      },
      rows: [view()],
    });
    expect(await relayed.settle(delegateBody(delegate))).toEqual({ success: true, transaction: HASH });
    expect(await relayed.settle(delegateBody(delegate))).toEqual({ success: true, transaction: HASH, replayed: true });
    expect(calls).toEqual(['relay']);
  });

  it('rejects a delegate whose deposit is not 1 yocto', async () => {
    const delegate: NearDelegate = {
      senderId: BUYER,
      receiverId: CIRCLE_USDC_NEAR_TESTNET,
      methodName: 'ft_transfer',
      deposit: '0',
      receiver_id: PAYEE,
      amount: '10000',
      memo: 'memo-1',
    };
    const result = await settler().verify(delegateBody(delegate));
    expect(result).toEqual({ isValid: false, invalidReason: 'delegate deposit is not 1 yocto' });
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
  it('settles near:testnet without calling Coinbase', async () => {
    const prev = process.env.CLEARING_FACILITATOR_TOKEN;
    process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
    const urls: string[] = [];
    const args = Buffer.from(JSON.stringify({ amount: '10000', memo: 'hosted-memo', receiver_id: PAYEE })).toString('base64');
    const fetchFn = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url !== NEAR_TESTNET_RPC) return new Response('unexpected', { status: 500 });
      return new Response(JSON.stringify({
        result: {
          final_execution_status: 'FINAL',
          status: { SuccessValue: '' },
          transaction: {
            signer_id: BUYER,
            receiver_id: CIRCLE_USDC_NEAR_TESTNET,
            actions: [{ FunctionCall: { method_name: 'ft_transfer', args } }],
          },
          receipts_outcome: [{
            outcome: {
              executor_id: CIRCLE_USDC_NEAR_TESTNET,
              logs: [`EVENT_JSON:${JSON.stringify({
                standard: 'nep141',
                event: 'ft_transfer',
                data: [{ old_owner_id: BUYER, new_owner_id: PAYEE, amount: '10000', memo: 'hosted-memo' }],
              })}`],
            },
          }],
        },
      }));
    };
    try {
      const ctx = makeCtx({}, { config: { nearPayTo: PAYEE } });
      const res = await handleFacilitator(
        new Request('https://clearing.test/settle', {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(directBody({ memo: 'hosted-memo', txHash: HASH })),
        }),
        ctx,
        { fetchFn: fetchFn as typeof fetch, nowSec: NOW },
      );
      expect(res?.status).toBe(200);
      expect(await res?.json()).toEqual({ success: true, transaction: HASH });
      expect(urls).toEqual([NEAR_TESTNET_RPC]);
      expect(urls.some((url) => url.includes('coinbase'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
      else process.env.CLEARING_FACILITATOR_TOKEN = prev;
    }
  });
});
