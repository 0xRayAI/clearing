/**
 * Public x402 facilitator for Dynamo. Coinbase settles and pays Base gas.
 * Pin and the shops keep ctx.facilitator (zigzag). payTo must be one of our treasuries.
 * The allowlist and CDP key values are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { missingCdpKeyEnv } from './cdp-auth.js';
import { isHexAddress, normalizeAddress } from './bytes.js';
import { CdpFacilitator, createFacilitator } from './facilitator.js';
import { USDC_BASE } from './types.js';
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

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time. Unset env is not a mismatch. */
export function facilitatorTokenStatus(authorization: string | null): 'ok' | 'unset' | 'denied' {
  const expected = process.env.CLEARING_FACILITATOR_TOKEN?.trim() ?? '';
  if (!expected) return 'unset';
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!presented || !timingSafeEqual(tokenDigest(presented), tokenDigest(expected))) return 'denied';
  return 'ok';
}

function isBaseNetwork(value: unknown): boolean {
  const network = String(value ?? '').trim().toLowerCase();
  return network === 'base' || network === 'eip155:8453' || network === '8453';
}

function decimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return value;
}

function sameAmount(left: string, right: string): boolean {
  return BigInt(left) === BigInt(right);
}

/** Amount is exact. Authorization fields must equal the requirements. payTo must be allowlisted. */
export function exactPaymentVerdict(
  raw: unknown,
  configPayTo?: string,
): { isValid: false; invalidReason: string } | undefined {
  const body = asRecord(raw);
  const requirements = asRecord(body?.paymentRequirements);
  const payload = asRecord(asRecord(body?.paymentPayload)?.payload);
  const authorization = asRecord(payload?.authorization);
  if (!requirements || !authorization) return { isValid: false, invalidReason: 'payment requirements are incomplete' };
  const amount = decimal(requirements.amount);
  const value = decimal(authorization.value);
  const payTo = typeof requirements.payTo === 'string' ? requirements.payTo : '';
  const to = typeof authorization.to === 'string' ? authorization.to : '';
  const asset = typeof requirements.asset === 'string' ? requirements.asset : '';
  if (!amount || !value || !sameAmount(value, amount)) {
    return { isValid: false, invalidReason: 'authorization.value must equal amount' };
  }
  if (requirements.maxAmountRequired != null && !sameAmount(String(requirements.maxAmountRequired), amount)) {
    return { isValid: false, invalidReason: 'amount and maxAmountRequired disagree' };
  }
  if (!isHexAddress(asset) || normalizeAddress(asset) !== USDC_BASE.toLowerCase()) {
    return { isValid: false, invalidReason: 'asset is not Base USDC' };
  }
  if (!isBaseNetwork(requirements.network)) {
    return { isValid: false, invalidReason: 'network is not base' };
  }
  if (!isHexAddress(payTo) || !facilitatorPayToAllowlist(configPayTo).has(normalizeAddress(payTo))) {
    return { isValid: false, invalidReason: 'payTo is not an allowed treasury' };
  }
  if (!isHexAddress(to) || normalizeAddress(to) !== normalizeAddress(payTo)) {
    return { isValid: false, invalidReason: 'authorization.to does not match payTo' };
  }
  const accepted = asRecord(asRecord(body?.paymentPayload)?.accepted);
  if (accepted) {
    const acceptedAmount = decimal(accepted.amount ?? accepted.maxAmountRequired);
    const acceptedPayTo = typeof accepted.payTo === 'string' ? accepted.payTo : '';
    const acceptedAsset = typeof accepted.asset === 'string' ? accepted.asset : '';
    if (
      !acceptedAmount ||
      !sameAmount(acceptedAmount, amount) ||
      !isHexAddress(acceptedPayTo) ||
      normalizeAddress(acceptedPayTo) !== normalizeAddress(payTo) ||
      !isHexAddress(acceptedAsset) ||
      normalizeAddress(acceptedAsset) !== USDC_BASE.toLowerCase() ||
      (accepted.network != null && !isBaseNetwork(accepted.network))
    ) {
      return { isValid: false, invalidReason: 'payload accepted does not match requirements' };
    }
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
  const tx = typeof row?.transaction === 'string' ? row.transaction.trim() : '';
  if (row?.success === true && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return { success: true, transaction: tx as HexAddress };
  }
  const reason = row?.errorReason ?? row?.errorMessage ?? 'cdp settle did not return a transaction';
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
  const token = facilitatorTokenStatus(req.headers.get('authorization'));
  if (token === 'unset') return json({ error: 'CLEARING_FACILITATOR_TOKEN is required' }, 503);
  if (token === 'denied') return json({ error: 'unauthorized' }, 401);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const blocked = exactPaymentVerdict(raw, ctx.config.payTo);
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
