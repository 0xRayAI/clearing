/**
 * Public x402 facilitator for Dynamo. Coinbase settles and pays Base gas.
 * Pin and the shops keep ctx.facilitator (zigzag). payTo must be one of our treasuries.
 * The allowlist and CDP key values are never logged.
 */
import { missingCdpKeyEnv } from './cdp-auth.js';
import { isHexAddress, normalizeAddress } from './bytes.js';
import { CdpFacilitator, createFacilitator } from './facilitator.js';
import type { ClearingContext } from './context.js';
import type { FetchFn, HexAddress } from './types.js';

export const VORTEX_TREASURY = '0xd45CcF98D6db5A36E7CdD10ffae0b685BF27CE43' as const;

export type FacilitatorVerify = { isValid: true } | { isValid: false; invalidReason: string };
export type FacilitatorSettle =
  | { success: true; transaction: HexAddress }
  | { success: false; errorReason: string };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

function addAddress(out: Set<string>, value: string | undefined): void {
  if (!value || !isHexAddress(value.trim())) return;
  out.add(normalizeAddress(value.trim()));
}

/** Vortex treasury, CLEARING_PAY_TO, the configured payTo, plus CLEARING_FACILITATOR_PAYTOS. */
export function facilitatorPayToAllowlist(configPayTo?: string): Set<string> {
  const out = new Set<string>();
  addAddress(out, VORTEX_TREASURY);
  addAddress(out, process.env.CLEARING_PAY_TO);
  addAddress(out, configPayTo);
  const extra = process.env.CLEARING_FACILITATOR_PAYTOS;
  if (extra) {
    for (const part of extra.split(/[\s,]+/)) addAddress(out, part);
  }
  return out;
}

function payToOf(raw: unknown): string {
  const requirements = asRecord(asRecord(raw)?.paymentRequirements);
  return typeof requirements?.payTo === 'string' ? requirements.payTo : '';
}

function allowlistVerdict(raw: unknown, configPayTo?: string): { isValid: false; invalidReason: string } | undefined {
  const payTo = payToOf(raw);
  if (!isHexAddress(payTo) || !facilitatorPayToAllowlist(configPayTo).has(normalizeAddress(payTo))) {
    return { isValid: false, invalidReason: 'payTo is not an allowed treasury' };
  }
  return undefined;
}

function openCdp(fetchFn?: FetchFn): CdpFacilitator | Response {
  const missing = missingCdpKeyEnv();
  if (missing.length > 0) {
    return json({ error: `${missing.join(' and ')} required` }, 503);
  }
  const made = createFacilitator('cdp', false, { fetchFn });
  if (!(made instanceof CdpFacilitator)) {
    return json({ error: 'CDP facilitator is not configured' }, 503);
  }
  return made;
}

function verifyFromCdp(jsonBody: unknown, transportError?: string): FacilitatorVerify {
  if (transportError) return { isValid: false, invalidReason: transportError.slice(0, 200) };
  const row = asRecord(jsonBody);
  if (row?.isValid === true || row?.valid === true) return { isValid: true };
  const reason = row?.invalidReason ?? row?.errorReason ?? row?.errorMessage ?? 'invalid';
  return { isValid: false, invalidReason: String(reason).slice(0, 200) };
}

function settleFromCdp(jsonBody: unknown, transportError?: string): FacilitatorSettle {
  if (transportError) return { success: false, errorReason: transportError.slice(0, 200) };
  const row = asRecord(jsonBody);
  const tx = typeof row?.transaction === 'string' ? row.transaction : '';
  if (row?.success === true && tx.startsWith('0x')) {
    return { success: true, transaction: tx as HexAddress };
  }
  const reason = row?.errorReason ?? row?.errorMessage ?? 'no tx';
  return { success: false, errorReason: String(reason).slice(0, 200) };
}

export async function handleFacilitator(
  req: Request,
  ctx: ClearingContext,
  opts: { fetchFn?: FetchFn } = {},
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname !== '/verify' && url.pathname !== '/settle') return undefined;
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const blocked = allowlistVerdict(raw, ctx.config.payTo);
  if (blocked) {
    if (url.pathname === '/verify') return json(blocked, 200);
    return json({ success: false, errorReason: blocked.invalidReason }, 200);
  }
  const opened = openCdp(opts.fetchFn);
  if (opened instanceof Response) return opened;
  if (url.pathname === '/verify') {
    const posted = await opened.postX402('verify', raw);
    return json(verifyFromCdp(posted.ok ? posted.json : undefined, posted.ok ? undefined : posted.error), 200);
  }
  const verified = await opened.postX402('verify', raw);
  const verdict = verifyFromCdp(verified.ok ? verified.json : undefined, verified.ok ? undefined : verified.error);
  if (!verdict.isValid) return json({ success: false, errorReason: verdict.invalidReason }, 200);
  const settled = await opened.postX402('settle', raw);
  return json(settleFromCdp(settled.ok ? settled.json : undefined, settled.ok ? undefined : settled.error), 200);
}
