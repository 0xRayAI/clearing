import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { MemoryFacilitator } from '../mcp/src/facilitator.js';
import {
  VORTEX_TREASURY,
  facilitatorPayToAllowlist,
  handleFacilitator,
  transferWithAuthorizationTypes,
  usdcAuthDomain,
} from '../mcp/src/facilitator-http.js';
import { handleHangar } from '../mcp/src/http.js';
import { USDC_BASE } from '../mcp/src/types.js';
import { PAY_TO, makeCtx } from './helpers.js';

const OTHER = '0x1111111111111111111111111111111111111111' as const;
const NOW = 1_700_000_000n;

async function signedBody(opts: {
  payTo?: string;
  to?: string;
  value?: string;
  amount?: string;
  asset?: string;
  validAfter?: string;
  validBefore?: string;
  from?: `0x${string}`;
  signer?: `0x${string}`;
}) {
  const key = opts.signer ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const from = opts.from ?? account.address;
  const to = (opts.to ?? opts.payTo ?? VORTEX_TREASURY) as `0x${string}`;
  const value = opts.value ?? '10000';
  const validAfter = opts.validAfter ?? '0';
  const validBefore = opts.validBefore ?? '9999999999';
  const nonce = `0x${'ab'.repeat(32)}` as const;
  const signature = await account.signTypedData({
    domain: usdcAuthDomain(),
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value: BigInt(value),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      payload: {
        signature,
        authorization: { from, to, value, validAfter, validBefore, nonce },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: opts.asset ?? USDC_BASE,
      amount: opts.amount ?? '10000',
      payTo: opts.payTo ?? VORTEX_TREASURY,
      maxTimeoutSeconds: 60,
    },
  };
}

function post(path: '/verify' | '/settle', body: unknown) {
  return new Request(`https://clearing.rippel.ai${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('x402 facilitator routes', () => {
  it('allowlist is vortex, configured payTo, and CLEARING_FACILITATOR_PAYTOS', () => {
    const prev = process.env.CLEARING_FACILITATOR_PAYTOS;
    process.env.CLEARING_FACILITATOR_PAYTOS = OTHER;
    try {
      const allow = facilitatorPayToAllowlist(PAY_TO);
      expect(allow.has(VORTEX_TREASURY.toLowerCase())).toBe(true);
      expect(allow.has(PAY_TO.toLowerCase())).toBe(true);
      expect(allow.has(OTHER.toLowerCase())).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLEARING_FACILITATOR_PAYTOS;
      else process.env.CLEARING_FACILITATOR_PAYTOS = prev;
    }
  });

  it('verifies a vortex payment and settles it once', async () => {
    const facilitator = new MemoryFacilitator();
    const ctx = makeCtx({}, { facilitator, config: { payTo: PAY_TO } });
    const body = await signedBody({});
    const verified = await handleFacilitator(post('/verify', body), ctx);
    expect(verified?.status).toBe(200);
    expect(await verified!.json()).toEqual({ isValid: true });
    const settled = await handleHangar(post('/settle', body), ctx);
    const paid = (await settled.json()) as { success: boolean; transaction?: string };
    expect(paid.success).toBe(true);
    expect(paid.transaction?.startsWith('0x')).toBe(true);
    expect(facilitator.debitCount()).toBe(1);
    const again = await handleFacilitator(post('/settle', body), ctx);
    const replay = (await again!.json()) as { success: boolean };
    expect(replay.success).toBe(true);
    expect(facilitator.debitCount()).toBe(1);
  });

  it('rejects a signature that does not recover from', async () => {
    const ctx = makeCtx();
    const stranger = generatePrivateKey();
    const body = await signedBody({ from: privateKeyToAccount(stranger).address });
    const res = await handleFacilitator(post('/verify', body), ctx);
    const verdict = (await res!.json()) as { isValid: boolean; invalidReason?: string };
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toMatch(/from/);
  });

  it('rejects value below amount, the wrong asset, a mismatched to, and a closed window', async () => {
    const ctx = makeCtx();
    const low = await signedBody({ value: '1', amount: '10000' });
    const asset = await signedBody({ asset: OTHER });
    const to = await signedBody({ to: OTHER });
    const expired = await signedBody({ validAfter: '0', validBefore: '1' });
    for (const body of [low, asset, to, expired]) {
      const res = await handleFacilitator(post('/verify', body), ctx);
      const verdict = (await res!.json()) as { isValid: boolean };
      expect(verdict.isValid).toBe(false);
    }
  });

  it('rejects a payTo outside the treasury allowlist and does not settle', async () => {
    const facilitator = new MemoryFacilitator();
    const ctx = makeCtx({}, { facilitator, config: { payTo: PAY_TO } });
    const body = await signedBody({ payTo: OTHER, to: OTHER });
    const verified = await handleFacilitator(post('/verify', body), ctx);
    const verdict = (await verified!.json()) as { isValid: boolean; invalidReason?: string };
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toMatch(/treasury/);
    const settled = await handleFacilitator(post('/settle', body), ctx);
    const paid = (await settled!.json()) as { success: boolean; errorReason?: string };
    expect(paid.success).toBe(false);
    expect(paid.errorReason).toMatch(/treasury/);
    expect(facilitator.debitCount()).toBe(0);
  });

  it('accepts the configured CLEARING payTo', async () => {
    const ctx = makeCtx({}, { config: { payTo: PAY_TO } });
    const body = await signedBody({ payTo: PAY_TO, to: PAY_TO });
    const res = await handleFacilitator(post('/verify', body), ctx);
    expect(await res!.json()).toEqual({ isValid: true });
  });
});
