import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BASE_SEPOLIA,
  createBaseSettler,
  createCdpSigner,
  createSelfSigner,
  createZigzagSigner,
  encodeTransferWithAuthorization,
  type AdvertisedExact,
  type BaseChain,
  type Eip3009Authorization,
  type TxReceipt,
} from '../mcp/src/base-settle.js';
import { USDC_BASE } from '../mcp/src/types.js';

const PAYTO = '0xc9cd4e19e8ffabfc479352680295ba12e454462d';
const FROM = '0x234a4b961908b20114980af00c0974123763b48c';
const NONCE = '0xabababababababababababababababababababababababababababababababab';
const SIG = `0x${'cc'.repeat(65)}` as `0x${string}`;
const NOW = 1_700_000_000n;
const TX = `0x${'ab'.repeat(32)}` as `0x${string}`;

const advertised: AdvertisedExact = {
  scheme: 'exact',
  network: BASE_SEPOLIA,
  asset: USDC_BASE,
  amount: '10000',
  payTo: PAYTO,
  maxTimeoutSeconds: 60,
};

function auth(over: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return {
    from: FROM,
    to: PAYTO,
    value: '10000',
    validAfter: String(NOW - 10n),
    validBefore: String(NOW + 10n),
    nonce: NONCE,
    signature: SIG,
    ...over,
  };
}

function body(over: { amount?: string; payTo?: string; network?: string; asset?: string; value?: string } = {}) {
  const authorization = auth({
    to: (over.payTo ?? PAYTO) as `0x${string}`,
    value: over.value ?? over.amount ?? '10000',
  });
  return {
    x402Version: 2,
    payload: { signature: authorization.signature, authorization },
    accepted: {
      scheme: 'exact',
      network: over.network ?? BASE_SEPOLIA,
      amount: over.amount ?? '10000',
      asset: over.asset ?? USDC_BASE,
      payTo: over.payTo ?? PAYTO,
      maxTimeoutSeconds: 60,
    },
  };
}

function receipt(over: Partial<TxReceipt> = {}): TxReceipt {
  return {
    status: 'success',
    token: USDC_BASE,
    from: FROM,
    to: PAYTO,
    value: '10000',
    ...over,
  };
}

function chain(row: TxReceipt | 'throw' = receipt()): BaseChain {
  return {
    receipt: async () => {
      if (row === 'throw') throw new Error('rpc down');
      return row;
    },
  };
}

describe('embeddable base settler', () => {
  it('self-settles only after the chain confirms the exact transfer', async () => {
    const calls: string[] = [];
    const signer = createSelfSigner(USDC_BASE, async (call) => {
      calls.push(call.data);
      const decoded = decodeFunctionData({
        abi: [{
          name: 'transferWithAuthorization',
          type: 'function',
          inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
            { name: 'signature', type: 'bytes' },
          ],
        }],
        data: call.data,
      });
      expect(decoded.functionName).toBe('transferWithAuthorization');
      expect(String(decoded.args[1]).toLowerCase()).toBe(PAYTO);
      expect(decoded.args[2]).toBe(10000n);
      expect(call.to).toBe(USDC_BASE);
      return TX;
    });
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer,
      chain: chain(),
    });
    const settled = await settler.settle(body());
    expect(settled).toEqual({ success: true, transaction: TX });
    expect(calls).toHaveLength(1);
    const again = await settler.settle(body());
    expect(again).toEqual({ success: true, transaction: TX, replayed: true });
    expect(calls).toHaveLength(1);
  });

  it('does not report success when the receipt is missing or the amount differs', async () => {
    const missing = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: createSelfSigner(USDC_BASE, async () => TX),
      chain: chain(receipt({ status: 'missing' })),
    });
    expect(await missing.settle(body())).toEqual({
      success: false,
      errorReason: 'chain has not confirmed the transfer',
    });
    const wrong = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: createZigzagSigner({
        settleUrl: 'https://zigzag.example/settle',
        fetchFn: async () => new Response(JSON.stringify({ txHash: TX }), { status: 200 }),
      }),
      chain: chain(receipt({ value: '1' })),
    });
    expect(await wrong.settle(body())).toEqual({
      success: false,
      errorReason: 'receipt amount does not match the advertised 402',
    });
    const cdp = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: createCdpSigner(async () => ({ success: true, transaction: TX })),
      chain: chain('throw'),
    });
    expect(await cdp.settle(body())).toEqual({
      success: false,
      errorReason: 'chain has not confirmed the transfer',
    });
  });

  it('refuses a payload that is not the foundry advertisement or an allowed payTo', async () => {
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: createSelfSigner(USDC_BASE, async () => TX),
      chain: chain(),
    });
    expect((await settler.verify(body({ amount: '1', value: '1' }))).isValid).toBe(false);
    expect((await settler.verify(body({ network: 'eip155:1' }))).isValid).toBe(false);
    expect((await settler.verify(body({ asset: '0x0000000000000000000000000000000000000001' }))).isValid).toBe(false);
    const other = '0x1111111111111111111111111111111111111111';
    expect((await settler.verify(body({ payTo: other }))).isValid).toBe(false);
    const closed = createBaseSettler({
      allowPayTo: [],
      advertised,
      nowSec: () => NOW,
      signer: createSelfSigner(USDC_BASE, async () => TX),
      chain: chain(),
    });
    expect(await closed.settle(body())).toEqual({ success: false, errorReason: 'payTo is not an allowed treasury' });
  });

  it('encodes the buyer authorization without treating the calldata as a receipt', () => {
    const data = encodeTransferWithAuthorization(auth());
    expect(data.startsWith('0x')).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});
