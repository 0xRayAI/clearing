import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createContext } from '../mcp/src/context.js';
import { ClearingError } from '../mcp/src/errors.js';
import { CdpFacilitator, MemoryFacilitator } from '../mcp/src/facilitator.js';
import { dispatch } from '../mcp/src/http.js';
import { handlePing } from '../mcp/src/ping.js';
import { USDC_BASE, type PaymentRequirements } from '../mcp/src/types.js';
import { decodePayload } from '../mcp/src/x402.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PAY = '0xc9cD4E19e8fFabFC479352680295ba12e454462D' as const;
const NONCE = '0xabababababababababababababababababababababababababababababababab';
const PING = 'https://clearing.rippel.ai/v1/ping?url=https://clearing.rippel.ai/v1/skim?url=https://example.com';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/x402-v2-exact.json', import.meta.url), 'utf8')) as {
  payload: { authorization: { nonce: string }; signature: string };
  [key: string]: unknown;
};

function headerOf(body: unknown): string {
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

function shopRequirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    maxAmountRequired: '10000',
    asset: USDC_BASE,
    payTo: PAY.toLowerCase() as `0x${string}`,
    resource: 'https://clearing.rippel.ai/v1/skim?url=https://example.com',
    description: 'x402 shop. Unpaid GET returns 402.',
    mimeType: 'application/json',
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
  };
}

function ed25519Secret(): { id: string; secret: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) throw new Error('ed25519 jwk missing d/x');
  return {
    id: '00000000-0000-4000-8000-000000000031',
    secret: Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64'),
  };
}

describe('x402 v2 exact payload', () => {
  const header = headerOf(fixture);

  it('derives paymentId and nonce from authorization.nonce', () => {
    const body = decodePayload(header);
    expect(fixture.payload.authorization.nonce).toBe(NONCE);
    expect(body.x402Version).toBe(2);
    expect(body.paymentId).toBe(NONCE);
    expect(body.nonce).toBe(NONCE);
    expect(body.accepted.maxAmountRequired).toBe('10000');
    expect(body.accepted.scheme).toBe('exact');
    expect(body.eip3009?.nonce).toBe(NONCE);
    expect(body.eip3009?.signature).toBe(fixture.payload.signature);
    expect(body.eip3009?.value).toBe('10000');
  });

  it('settles one debit for that signed payload and refuses a second body', async () => {
    const rail = new MemoryFacilitator();
    const expected = shopRequirements();
    const first = await rail.settle(header, expected);
    expect(first.ok).toBe(true);
    expect(first.replayed).toBe(false);
    const again = await rail.settle(header, expected);
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(rail.debitCount()).toBe(1);
    const other = headerOf({
      ...fixture,
      payload: {
        ...fixture.payload,
        signature: `0x${'dd'.repeat(65)}`,
      },
    });
    const rebound = await rail.settle(other, expected);
    expect(rebound.ok).toBe(false);
    expect(rail.debitCount()).toBe(1);
  });

  it('facilitator settle posts the v2 authorization', async () => {
    const { id, secret } = ed25519Secret();
    const posted: unknown[] = [];
    const rail = new CdpFacilitator({
      apiKeyId: id,
      apiKeySecret: secret,
      fetchFn: async (_url, init) => {
        posted.push(JSON.parse(String(init?.body ?? '{}')));
        const path = String(_url);
        if (path.endsWith('/verify')) return new Response(JSON.stringify({ isValid: true }));
        return new Response(JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}` }));
      },
    });
    const settled = await rail.settle(header, shopRequirements());
    expect(settled.ok).toBe(true);
    const body = posted[0] as {
      x402Version: number;
      paymentPayload: { payload: { authorization: { nonce: string } } };
    };
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.payload.authorization.nonce).toBe(NONCE);
  });

  it('pays /v1/ping from a PAYMENT-SIGNATURE header', async () => {
    const facilitator = new MemoryFacilitator();
    const ctx = createContext({
      config: { allowFake: true, signer: 'fake', facilitator: 'memory', payTo: PAY },
      facilitator,
      fetch: async (input) => {
        const u = String(input);
        if (u.includes('skim')) return new Response('{}', { status: 402 });
        return new Response('ok', { status: 200 });
      },
    });
    const live = await handlePing(
      new Request(PING, { headers: { 'PAYMENT-SIGNATURE': header } }),
      ctx,
    );
    expect(live?.status).toBe(200);
    const paid = (await live!.json()) as { paid: boolean };
    expect(paid.paid).toBe(true);
    expect(facilitator.debitCount()).toBe(1);
    const replay = await handlePing(
      new Request(PING, { headers: { 'PAYMENT-SIGNATURE': header } }),
      ctx,
    );
    expect(replay?.status).toBe(200);
    expect(facilitator.debitCount()).toBe(1);
  });

  it('returns 402 for a bad payload', async () => {
    expect(() => decodePayload(Buffer.from('{"x402Version":2}').toString('base64'))).toThrow(ClearingError);
    try {
      decodePayload(Buffer.from('{"x402Version":2}').toString('base64'));
    } catch (err) {
      expect(err).toBeInstanceOf(ClearingError);
      expect((err as ClearingError).httpStatus).toBe(402);
    }
    const ctx = createContext({
      config: { allowFake: true, signer: 'fake', facilitator: 'memory', payTo: PAY },
    });
    const req = {
      method: 'GET',
      url: '/v1/ping?url=https://clearing.rippel.ai/v1/skim?url=https://example.com',
      headers: {
        host: 'clearing.rippel.ai',
        'payment-signature': Buffer.from('{"x402Version":2}').toString('base64'),
      },
    } as IncomingMessage;
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse;
    await dispatch(req, res, ctx);
    expect(res.statusCode).toBe(402);
  });
});
