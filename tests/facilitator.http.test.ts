import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CDP_VERIFY_URL, CDP_SETTLE_URL } from '../mcp/src/cdp-auth.js';
import { HANGAR_TREASURY, VORTEX_TREASURY, facilitatorPayToAllowlist, handleFacilitator } from '../mcp/src/facilitator-http.js';
import { USDC_BASE } from '../mcp/src/types.js';
import { makeCtx } from './helpers.js';

const OTHER = '0x1111111111111111111111111111111111111111' as const;
const TX = `0x${'cd'.repeat(32)}`;
const TOKEN = 'facilitator-test-token';

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
  const prevToken = process.env.CLEARING_FACILITATOR_TOKEN;
  const keys = ed25519Secret();
  process.env.CDP_API_KEY_ID = keys.id;
  process.env.CDP_API_KEY_SECRET = keys.secret;
  process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
  return run().finally(() => {
    if (prevId === undefined) delete process.env.CDP_API_KEY_ID;
    else process.env.CDP_API_KEY_ID = prevId;
    if (prevSecret === undefined) delete process.env.CDP_API_KEY_SECRET;
    else process.env.CDP_API_KEY_SECRET = prevSecret;
    if (prevToken === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
    else process.env.CLEARING_FACILITATOR_TOKEN = prevToken;
  });
}

function withToken(run: () => Promise<void>): Promise<void> {
  const prevToken = process.env.CLEARING_FACILITATOR_TOKEN;
  process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
  return run().finally(() => {
    if (prevToken === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
    else process.env.CLEARING_FACILITATOR_TOKEN = prevToken;
  });
}

function body(payTo: string, window?: { validAfter: string; validBefore: string }) {
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
          validAfter: window?.validAfter ?? '0',
          validBefore: window?.validBefore ?? '9999999999',
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

function post(path: '/verify' | '/settle', payload: unknown, token = TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://clearing.rippel.ai${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

describe('x402 facilitator routes', () => {
  it('env cannot add a payTo', () => {
    const prevPay = process.env.CLEARING_PAY_TO;
    const prevExtra = process.env.CLEARING_FACILITATOR_PAYTOS;
    process.env.CLEARING_PAY_TO = OTHER;
    process.env.CLEARING_FACILITATOR_PAYTOS = OTHER;
    try {
      const allow = facilitatorPayToAllowlist();
      expect([...allow].sort()).toEqual([HANGAR_TREASURY.toLowerCase(), VORTEX_TREASURY.toLowerCase()].sort());
      expect(allow.has(OTHER.toLowerCase())).toBe(false);
    } finally {
      if (prevPay === undefined) delete process.env.CLEARING_PAY_TO;
      else process.env.CLEARING_PAY_TO = prevPay;
      if (prevExtra === undefined) delete process.env.CLEARING_FACILITATOR_PAYTOS;
      else process.env.CLEARING_FACILITATOR_PAYTOS = prevExtra;
    }
  });

  it('requires the facilitator bearer and 503s when the token env is unset', async () => {
    const prevToken = process.env.CLEARING_FACILITATOR_TOKEN;
    delete process.env.CLEARING_FACILITATOR_TOKEN;
    try {
      const ctx = makeCtx();
      const unset = await handleFacilitator(post('/verify', body(VORTEX_TREASURY), ''), ctx);
      expect(unset?.status).toBe(503);
      expect(((await unset!.json()) as { error?: string }).error).toBe('CLEARING_FACILITATOR_TOKEN is required');
    } finally {
      if (prevToken === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
      else process.env.CLEARING_FACILITATOR_TOKEN = prevToken;
    }
    await withToken(async () => {
      const ctx = makeCtx();
      const missing = await handleFacilitator(post('/settle', body(HANGAR_TREASURY), ''), ctx);
      const wrong = await handleFacilitator(post('/verify', body(HANGAR_TREASURY), 'nope'), ctx);
      expect(missing?.status).toBe(401);
      expect(wrong?.status).toBe(401);
    });
  });

  it('rejects a payTo outside the treasury allowlist and does not call CDP', async () => {
    await withToken(async () => {
      const urls: string[] = [];
      const ctx = makeCtx();
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
  });

  it('rejects an amount that is not exact and a non-base network before CDP', async () => {
    await withToken(async () => {
      const urls: string[] = [];
      const ctx = makeCtx();
      const fetchFn = async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response('{}');
      };
      const over = body(HANGAR_TREASURY);
      over.paymentPayload.payload.authorization.value = '10001';
      const network = body(HANGAR_TREASURY);
      (network.paymentRequirements as { network: string }).network = 'eip155:1';
      const mismatchedTo = body(HANGAR_TREASURY);
      mismatchedTo.paymentPayload.payload.authorization.to = OTHER;
      for (const payload of [over, network, mismatchedTo]) {
        const settled = await handleFacilitator(post('/settle', payload), ctx, { fetchFn });
        const paid = (await settled!.json()) as { success: boolean };
        expect(paid.success).toBe(false);
      }
      expect(urls).toEqual([]);
    });
  });

  it('accepts validAfter equal to now and rejects validBefore equal to now', async () => {
    await withCdpEnv(async () => {
      const urls: string[] = [];
      const now = 1_700_000_000n;
      const ctx = makeCtx();
      const fetchFn = async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ isValid: true }));
      };
      const atStart = body(HANGAR_TREASURY, { validAfter: now.toString(), validBefore: (now + 60n).toString() });
      const opened = await handleFacilitator(post('/verify', atStart), ctx, { fetchFn, nowSec: now });
      expect((await opened!.json()) as { isValid: boolean }).toEqual({ isValid: true });
      expect(urls).toEqual([CDP_VERIFY_URL]);
      urls.length = 0;
      const atEnd = body(HANGAR_TREASURY, { validAfter: (now - 60n).toString(), validBefore: now.toString() });
      const closed = await handleFacilitator(post('/settle', atEnd), ctx, { fetchFn, nowSec: now });
      const paid = (await closed!.json()) as { success: boolean; errorReason?: string };
      expect(paid.success).toBe(false);
      expect(paid.errorReason).toMatch(/validAfter/);
      expect(urls).toEqual([]);
    });
  });

  it('returns 503 when CDP keys are absent', async () => {
    const prevId = process.env.CDP_API_KEY_ID;
    const prevSecret = process.env.CDP_API_KEY_SECRET;
    const prevToken = process.env.CLEARING_FACILITATOR_TOKEN;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    process.env.CLEARING_FACILITATOR_TOKEN = TOKEN;
    try {
      const ctx = makeCtx();
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
      if (prevToken === undefined) delete process.env.CLEARING_FACILITATOR_TOKEN;
      else process.env.CLEARING_FACILITATOR_TOKEN = prevToken;
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
      const ctx = makeCtx();
      const payload = body(HANGAR_TREASURY);
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

  it('returns success false when CDP settle has no transaction hash', async () => {
    await withCdpEnv(async () => {
      const fetchFn = async (input: string | URL | Request) => {
        if (String(input).endsWith('/verify')) return new Response(JSON.stringify({ isValid: true }));
        throw new Error('timeout');
      };
      const ctx = makeCtx();
      const timedOut = await handleFacilitator(post('/settle', body(HANGAR_TREASURY)), ctx, { fetchFn });
      const timeoutBody = (await timedOut!.json()) as { success: boolean; errorReason?: string; transaction?: string };
      expect(timeoutBody.success).toBe(false);
      expect(timeoutBody.transaction).toBeUndefined();
      expect(timeoutBody.errorReason).toMatch(/timeout/);
      const ambiguous = async (input: string | URL | Request) => {
        if (String(input).endsWith('/verify')) return new Response(JSON.stringify({ isValid: true }));
        return new Response(JSON.stringify({ success: true }));
      };
      const unsettled = await handleFacilitator(post('/settle', body(HANGAR_TREASURY)), ctx, { fetchFn: ambiguous });
      const paid = (await unsettled!.json()) as { success: boolean; transaction?: string };
      expect(paid.success).toBe(false);
      expect(paid.transaction).toBeUndefined();
    });
  });
});
