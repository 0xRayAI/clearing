import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CDP_VERIFY_URL, CDP_SETTLE_URL } from '../mcp/src/cdp-auth.js';
import { VORTEX_TREASURY, facilitatorPayToAllowlist, handleFacilitator } from '../mcp/src/facilitator-http.js';
import { USDC_BASE } from '../mcp/src/types.js';
import { PAY_TO, makeCtx } from './helpers.js';

const OTHER = '0x1111111111111111111111111111111111111111' as const;
const TX = `0x${'cd'.repeat(32)}`;

function ed25519Secret(): { id: string; secret: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) throw new Error('ed25519 jwk missing d/x');
  return {
    id: '00000000-0000-4000-8000-000000000034',
    secret: Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64'),
  };
}

function withCdpEnv(run: () => Promise<void>): Promise<void> {
  const prevId = process.env.CDP_API_KEY_ID;
  const prevSecret = process.env.CDP_API_KEY_SECRET;
  const keys = ed25519Secret();
  process.env.CDP_API_KEY_ID = keys.id;
  process.env.CDP_API_KEY_SECRET = keys.secret;
  return run().finally(() => {
    if (prevId === undefined) delete process.env.CDP_API_KEY_ID;
    else process.env.CDP_API_KEY_ID = prevId;
    if (prevSecret === undefined) delete process.env.CDP_API_KEY_SECRET;
    else process.env.CDP_API_KEY_SECRET = prevSecret;
  });
}

function body(payTo: string) {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      payload: {
        signature: `0x${'aa'.repeat(65)}`,
        authorization: {
          from: '0x234a4B961908b20114980AF00c0974123763b48C',
          to: payTo,
          value: '10000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: `0x${'ab'.repeat(32)}`,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: USDC_BASE,
      amount: '10000',
      payTo,
    },
  };
}

function post(path: '/verify' | '/settle', payload: unknown) {
  return new Request(`https://clearing.rippel.ai${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

  it('rejects a payTo outside the treasury allowlist and does not call CDP', async () => {
    const urls: string[] = [];
    const ctx = makeCtx({}, { config: { payTo: PAY_TO } });
    const fetchFn = async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response('{}');
    };
    const verified = await handleFacilitator(post('/verify', body(OTHER)), ctx, { fetchFn });
    const verdict = (await verified!.json()) as { isValid: boolean; invalidReason?: string };
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toMatch(/treasury/);
    const settled = await handleFacilitator(post('/settle', body(OTHER)), ctx, { fetchFn });
    const paid = (await settled!.json()) as { success: boolean; errorReason?: string };
    expect(paid.success).toBe(false);
    expect(paid.errorReason).toMatch(/treasury/);
    expect(urls).toEqual([]);
  });

  it('returns 503 when CDP keys are absent', async () => {
    const prevId = process.env.CDP_API_KEY_ID;
    const prevSecret = process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    try {
      const ctx = makeCtx({}, { config: { payTo: PAY_TO } });
      const res = await handleFacilitator(post('/verify', body(VORTEX_TREASURY)), ctx);
      expect(res?.status).toBe(503);
      const err = (await res!.json()) as { error?: string };
      expect(err.error).toMatch(/CDP_API_KEY_ID/);
      expect(err.error).toMatch(/CDP_API_KEY_SECRET/);
      expect(err.error).not.toMatch(/[A-Za-z0-9+/]{40,}/);
    } finally {
      if (prevId === undefined) delete process.env.CDP_API_KEY_ID;
      else process.env.CDP_API_KEY_ID = prevId;
      if (prevSecret === undefined) delete process.env.CDP_API_KEY_SECRET;
      else process.env.CDP_API_KEY_SECRET = prevSecret;
    }
  });

  it('passes the x402 body through to CDP verify, then settle only after verify', async () => {
    await withCdpEnv(async () => {
      const seen: Array<{ url: string; body: unknown }> = [];
      const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
        if (String(input).endsWith('/verify')) return new Response(JSON.stringify({ isValid: true }));
        return new Response(JSON.stringify({ success: true, transaction: TX }));
      };
      const ctx = makeCtx({}, { config: { payTo: PAY_TO } });
      const payload = body(PAY_TO);
      const verified = await handleFacilitator(post('/verify', payload), ctx, { fetchFn });
      expect(await verified!.json()).toEqual({ isValid: true });
      expect(seen.map((row) => row.url)).toEqual([CDP_VERIFY_URL]);
      expect(seen[0]?.body).toEqual(payload);
      const settled = await handleFacilitator(post('/settle', payload), ctx, { fetchFn });
      expect(await settled.json()).toEqual({ success: true, transaction: TX });
      expect(seen.map((row) => row.url)).toEqual([CDP_VERIFY_URL, CDP_VERIFY_URL, CDP_SETTLE_URL]);
      expect(seen.some((row) => row.url.includes('zigzag'))).toBe(false);
    });
  });

  it('does not settle when CDP verify rejects', async () => {
    await withCdpEnv(async () => {
      const urls: string[] = [];
      const fetchFn = async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ isValid: false, invalidReason: 'bad sig' }));
      };
      const ctx = makeCtx({}, { config: { payTo: VORTEX_TREASURY } });
      const settled = await handleFacilitator(post('/settle', body(VORTEX_TREASURY)), ctx, { fetchFn });
      const paid = (await settled!.json()) as { success: boolean; errorReason?: string };
      expect(paid.success).toBe(false);
      expect(paid.errorReason).toBe('bad sig');
      expect(urls).toEqual([CDP_VERIFY_URL]);
    });
  });
});
