import { decodeFunctionData, pad, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  USDC_TRANSFER_TOPIC,
  createBaseSettler,
  createCdpSigner,
  createSelfSigner,
  createZigzagSigner,
  encodeTransferWithAuthorization,
  type AdvertisedExact,
  type BaseChain,
  type Eip3009Authorization,
  type SelfGasGuard,
  type TxLog,
  type TxReceipt,
} from '../mcp/src/base-settle.js';
import { USDC_BASE, USDC_EIP712_NAME, USDC_EIP712_VERSION } from '../mcp/src/types.js';

const PAYTO = '0xc9cd4e19e8ffabfc479352680295ba12e454462d' as `0x${string}`;
const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const FROM = payer.address;
const NONCE = '0xabababababababababababababababababababababababababababababababab' as `0x${string}`;
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

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

async function signAuth(over: Partial<Eip3009Authorization> = {}, chainId = 84532): Promise<Eip3009Authorization> {
  const draft = {
    from: FROM,
    to: PAYTO,
    value: '10000',
    validAfter: String(NOW - 10n),
    validBefore: String(NOW + 10n),
    nonce: NONCE,
    ...over,
  };
  const signature = await payer.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId,
      verifyingContract: USDC_BASE,
    },
    types: AUTH_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: draft.from,
      to: draft.to,
      value: BigInt(draft.value),
      validAfter: BigInt(draft.validAfter),
      validBefore: BigInt(draft.validBefore),
      nonce: draft.nonce,
    },
  });
  return { ...draft, signature };
}

function transferLog(over: { token?: `0x${string}`; from?: `0x${string}`; to?: `0x${string}`; value?: string } = {}): TxLog {
  const value = BigInt(over.value ?? '10000');
  return {
    address: over.token ?? USDC_BASE,
    topics: [
      USDC_TRANSFER_TOPIC,
      pad(over.from ?? FROM, { size: 32 }),
      pad(over.to ?? PAYTO, { size: 32 }),
    ],
    data: pad(toHex(value), { size: 32 }),
  };
}

function receipt(over: { status?: TxReceipt['status']; token?: `0x${string}`; from?: `0x${string}`; to?: `0x${string}`; value?: string; logs?: TxLog[] } = {}): TxReceipt {
  if (over.status === 'missing' || over.status === 'reverted') return { status: over.status, logs: over.logs ?? [] };
  return { status: 'success', logs: over.logs ?? [transferLog(over)] };
}

function chain(row: TxReceipt | 'throw' = receipt(), used = false): BaseChain {
  return {
    authorizationState: async () => used,
    receipt: async () => {
      if (row === 'throw') throw new Error('rpc down');
      return row;
    },
  };
}

function guard(balance = 10n ** 18n): SelfGasGuard {
  return {
    nativeBalance: async () => balance,
    estimateGas: async () => 21_000n,
    gasPrice: async () => 1n,
  };
}

function self(submit: (call: { data: `0x${string}`; to: `0x${string}` }) => Promise<`0x${string}`>, balance?: bigint) {
  return createSelfSigner(USDC_BASE, submit, guard(balance));
}

async function body(over: { amount?: string; payTo?: string; network?: string; asset?: string; value?: string; signature?: `0x${string}` } = {}) {
  const authorization = await signAuth({
    to: (over.payTo ?? PAYTO) as `0x${string}`,
    value: over.value ?? over.amount ?? '10000',
    ...(over.signature ? { signature: over.signature } : {}),
  });
  if (over.signature) authorization.signature = over.signature;
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

describe('embeddable base settler', () => {
  it('self-settles only after the chain confirms the exact transfer', async () => {
    const calls: string[] = [];
    const signer = self(async (call) => {
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
    const settled = await settler.settle(await body());
    expect(settled).toEqual({ success: true, transaction: TX });
    expect(calls).toHaveLength(1);
    const again = await settler.settle(await body());
    expect(again).toEqual({ success: true, transaction: TX, replayed: true });
    expect(calls).toHaveLength(1);
  });

  it('does not report success when the receipt is missing or the amount differs', async () => {
    const missing = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(receipt({ status: 'missing' })),
    });
    expect(await missing.settle(await body())).toEqual({
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
    expect(await wrong.settle(await body())).toEqual({
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
    expect(await cdp.settle(await body())).toEqual({
      success: false,
      errorReason: 'chain has not confirmed the transfer',
    });
  });

  it('refuses a payload that is not the foundry advertisement or an allowed payTo', async () => {
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(),
    });
    expect((await settler.verify(await body({ amount: '1', value: '1' }))).isValid).toBe(false);
    expect((await settler.verify(await body({ network: 'eip155:1' }))).isValid).toBe(false);
    expect((await settler.verify(await body({ asset: '0x0000000000000000000000000000000000000001' }))).isValid).toBe(false);
    const other = '0x1111111111111111111111111111111111111111';
    expect((await settler.verify(await body({ payTo: other }))).isValid).toBe(false);
    const closed = createBaseSettler({
      allowPayTo: [],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(),
    });
    expect(await closed.settle(await body())).toEqual({ success: false, errorReason: 'payTo is not an allowed treasury' });
  });

  it('encodes the buyer authorization without treating the calldata as a receipt', async () => {
    const data = encodeTransferWithAuthorization(await signAuth());
    expect(data.startsWith('0x')).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });

  it('recovers the TransferWithAuthorization signer and requires it to be from', async () => {
    let submits = 0;
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => {
        submits += 1;
        return TX;
      }),
      chain: chain(),
    });
    const forged = await body({ signature: `0x${'cc'.repeat(65)}` });
    expect(await settler.settle(forged)).toEqual({
      success: false,
      errorReason: 'authorization signature does not recover',
    });
    const otherKey = privateKeyToAccount(generatePrivateKey());
    const signedByOther = await otherKey.signTypedData({
      domain: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId: 84532,
        verifyingContract: USDC_BASE,
      },
      types: AUTH_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: FROM,
        to: PAYTO,
        value: 10000n,
        validAfter: NOW - 10n,
        validBefore: NOW + 10n,
        nonce: NONCE,
      },
    });
    expect(await settler.settle(await body({ signature: signedByOther }))).toEqual({
      success: false,
      errorReason: 'authorization signer is not the payer',
    });
    expect(submits).toBe(0);
  });

  it('reads authorizationState and holds a from+nonce lock before submit', async () => {
    let submits = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => {
        submits += 1;
        await held;
        return TX;
      }),
      chain: chain(),
    });
    const payload = await body();
    const first = settler.settle(payload);
    await new Promise((resolve) => setImmediate(resolve));
    expect(submits).toBe(1);
    expect(await settler.settle(payload)).toEqual({
      success: false,
      errorReason: 'authorization is already being submitted',
    });
    expect(submits).toBe(1);
    release();
    expect(await first).toEqual({ success: true, transaction: TX });
    const used = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => {
        submits += 1;
        return TX;
      }),
      chain: chain(receipt(), true),
    });
    expect(await used.settle(await body())).toEqual({
      success: false,
      errorReason: 'authorization nonce is already used',
    });
    expect(submits).toBe(1);
  });

  it('requires a USDC Transfer log from the payer to payTo for the exact amount', async () => {
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(receipt({ logs: [] })),
    });
    expect(await settler.settle(await body())).toEqual({
      success: false,
      errorReason: 'receipt asset does not match the advertised 402',
    });
    const otherToken = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(receipt({ token: '0x0000000000000000000000000000000000000001' })),
    });
    expect(await otherToken.settle(await body())).toEqual({
      success: false,
      errorReason: 'receipt asset does not match the advertised 402',
    });
    const exact = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(receipt()),
    });
    expect(await exact.settle(await body())).toEqual({ success: true, transaction: TX });
  });

  it('keeps mainnet off and the 60 second cap fixed', async () => {
    let submits = 0;
    const mainnet = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised: { ...advertised, network: BASE_MAINNET },
      nowSec: () => NOW,
      signer: self(async () => {
        submits += 1;
        return TX;
      }),
      chain: chain(),
    });
    expect(await mainnet.settle(await body())).toEqual({
      success: false,
      errorReason: 'mainnet settlement requires an explicit opt-in',
    });
    expect(submits).toBe(0);
    const opened = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised: { ...advertised, network: BASE_MAINNET },
      allowMainnet: true,
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(),
    });
    const mainAuth = await signAuth({}, 8453);
    const mainBody = {
      x402Version: 2,
      payload: { signature: mainAuth.signature, authorization: mainAuth },
      accepted: { ...advertised, network: BASE_MAINNET, maxTimeoutSeconds: 60 },
    };
    expect(await opened.settle(mainBody)).toEqual({ success: true, transaction: TX });
    const wideAuth = await signAuth({
      validAfter: String(NOW),
      validBefore: String(NOW + 90n),
    });
    const capped = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised: { ...advertised, maxTimeoutSeconds: 3600 },
      nowSec: () => NOW,
      signer: self(async () => TX),
      chain: chain(),
    });
    expect(await capped.verify({
      x402Version: 2,
      payload: { signature: wideAuth.signature, authorization: wideAuth },
      accepted: { ...advertised, maxTimeoutSeconds: 3600 },
    })).toEqual({ isValid: false, invalidReason: 'authorization window is longer than 60 seconds' });
  });

  it('refuses to send when the native balance cannot cover gas', async () => {
    let submits = 0;
    const settler = createBaseSettler({
      allowPayTo: [PAYTO],
      advertised,
      nowSec: () => NOW,
      signer: self(async () => {
        submits += 1;
        return TX;
      }, 0n),
      chain: chain(),
    });
    expect(await settler.settle(await body())).toEqual({
      success: false,
      errorReason: 'foundry native balance is too low for gas',
    });
    expect(submits).toBe(0);
  });
});
