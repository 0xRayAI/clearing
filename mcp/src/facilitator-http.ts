/**
 * Public x402 facilitator. Dynamo posts the standard v2 body.
 * Zigzag has no verify, so the checks happen here, then settle calls ctx.facilitator.
 * payTo must be one of our treasuries. The allowlist is never logged.
 */
import { recoverTypedDataAddress } from 'viem';
import { isHexAddress, isHexBytes32, normalizeAddress } from './bytes.js';
import { encodePayload } from './x402.js';
import {
  BASE_CHAIN_ID,
  USDC_BASE,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  type Eip3009Auth,
  type HexAddress,
  type PayloadBody,
  type PaymentRequirements,
} from './types.js';
import type { ClearingContext } from './context.js';
import type { SettleResult } from './facilitator.js';

export const VORTEX_TREASURY = '0xd45CcF98D6db5A36E7CdD10ffae0b685BF27CE43' as const;

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function usdcAuthDomain() {
  return {
    name: USDC_EIP712_NAME,
    version: USDC_EIP712_VERSION,
    chainId: BASE_CHAIN_ID,
    verifyingContract: USDC_BASE,
  } as const;
}

export type FacilitatorVerify = { isValid: true } | { isValid: false; invalidReason: string };
export type FacilitatorSettle =
  | { success: true; transaction: HexAddress }
  | { success: false; errorReason: string };

type AuthFields = {
  from: HexAddress;
  to: HexAddress;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  signature: `0x${string}`;
  amount: string;
  asset: string;
  payTo: string;
  resource: string;
};

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

function readBody(raw: unknown): { ok: true; fields: AuthFields } | { ok: false; reason: string } {
  const body = asRecord(raw);
  if (!body) return { ok: false, reason: 'body must be an object' };
  if (body.x402Version !== 2) return { ok: false, reason: 'x402Version must be 2' };
  const payment = asRecord(body.paymentPayload);
  const requirements = asRecord(body.paymentRequirements);
  if (!payment || !requirements) return { ok: false, reason: 'paymentPayload and paymentRequirements required' };
  const payload = asRecord(payment.payload);
  const authorization = asRecord(payload?.authorization);
  if (!authorization || typeof payload?.signature !== 'string') {
    return { ok: false, reason: 'missing authorization signature' };
  }
  const from = typeof authorization.from === 'string' ? authorization.from : '';
  const to = typeof authorization.to === 'string' ? authorization.to : '';
  const value = authorization.value == null ? '' : String(authorization.value);
  const validAfter = authorization.validAfter == null ? '' : String(authorization.validAfter);
  const validBefore = authorization.validBefore == null ? '' : String(authorization.validBefore);
  const nonce = typeof authorization.nonce === 'string' ? authorization.nonce : '';
  const signature = payload.signature;
  const amountRaw = requirements.amount ?? requirements.maxAmountRequired;
  const amount = amountRaw == null ? '' : String(amountRaw);
  const asset = typeof requirements.asset === 'string' ? requirements.asset : '';
  const payTo = typeof requirements.payTo === 'string' ? requirements.payTo : '';
  if (
    !isHexAddress(from) ||
    !isHexAddress(to) ||
    !isHexBytes32(nonce) ||
    !signature.startsWith('0x') ||
    !/^\d+$/.test(value) ||
    !/^\d+$/.test(validAfter) ||
    !/^\d+$/.test(validBefore) ||
    !/^\d+$/.test(amount)
  ) {
    return { ok: false, reason: 'authorization fields are incomplete' };
  }
  if (requirements.amount != null && requirements.maxAmountRequired != null) {
    if (String(requirements.amount) !== String(requirements.maxAmountRequired)) {
      return { ok: false, reason: 'amount and maxAmountRequired disagree' };
    }
  }
  const resourceRec = asRecord(payment.resource);
  const resource =
    typeof requirements.resource === 'string'
      ? requirements.resource
      : typeof resourceRec?.url === 'string'
        ? resourceRec.url
        : '';
  return {
    ok: true,
    fields: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
      signature: signature as `0x${string}`,
      amount,
      asset,
      payTo,
      resource,
    },
  };
}

export async function verifyFacilitatorFields(
  fields: AuthFields,
  allow: Set<string>,
  nowSec: bigint,
): Promise<FacilitatorVerify> {
  if (!isHexAddress(fields.payTo) || !allow.has(normalizeAddress(fields.payTo))) {
    return { isValid: false, invalidReason: 'payTo is not an allowed treasury' };
  }
  if (!isHexAddress(fields.asset) || normalizeAddress(fields.asset) !== USDC_BASE.toLowerCase()) {
    return { isValid: false, invalidReason: 'asset is not Base USDC' };
  }
  if (normalizeAddress(fields.to) !== normalizeAddress(fields.payTo)) {
    return { isValid: false, invalidReason: 'authorization.to does not match payTo' };
  }
  if (BigInt(fields.value) < BigInt(fields.amount)) {
    return { isValid: false, invalidReason: 'authorization.value is below amount' };
  }
  const after = BigInt(fields.validAfter);
  const before = BigInt(fields.validBefore);
  if (!(nowSec > after && nowSec < before)) {
    return { isValid: false, invalidReason: 'authorization is outside validAfter/validBefore' };
  }
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: usdcAuthDomain(),
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: fields.from,
        to: fields.to,
        value: BigInt(fields.value),
        validAfter: after,
        validBefore: before,
        nonce: fields.nonce,
      },
      signature: fields.signature,
    });
  } catch {
    return { isValid: false, invalidReason: 'signature did not recover' };
  }
  if (normalizeAddress(recovered) !== normalizeAddress(fields.from)) {
    return { isValid: false, invalidReason: 'signature does not recover from' };
  }
  return { isValid: true };
}

function expectedFor(fields: AuthFields): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    maxAmountRequired: fields.value,
    asset: USDC_BASE,
    payTo: normalizeAddress(fields.payTo),
    resource: fields.resource || 'https://clearing.local/facilitator',
    description: '',
    mimeType: 'application/json',
    maxTimeoutSeconds: 60,
    extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION },
  };
}

function payloadFor(fields: AuthFields, expected: PaymentRequirements): PayloadBody {
  const eip3009: Eip3009Auth = {
    from: normalizeAddress(fields.from),
    to: normalizeAddress(fields.to),
    value: fields.value,
    validAfter: fields.validAfter,
    validBefore: fields.validBefore,
    nonce: fields.nonce,
    signature: fields.signature,
  };
  return {
    x402Version: 1,
    paymentId: fields.nonce,
    nonce: fields.nonce,
    accepted: expected,
    eip3009,
  };
}

export async function verifyFacilitatorBody(
  raw: unknown,
  allow: Set<string>,
  nowSec: bigint,
): Promise<FacilitatorVerify> {
  const parsed = readBody(raw);
  if (!parsed.ok) return { isValid: false, invalidReason: parsed.reason };
  return verifyFacilitatorFields(parsed.fields, allow, nowSec);
}

export async function settleFacilitatorBody(
  raw: unknown,
  ctx: ClearingContext,
  nowSec: bigint,
): Promise<FacilitatorSettle> {
  const allow = facilitatorPayToAllowlist(ctx.config.payTo);
  const parsed = readBody(raw);
  if (!parsed.ok) return { success: false, errorReason: parsed.reason };
  const check = await verifyFacilitatorFields(parsed.fields, allow, nowSec);
  if (!check.isValid) return { success: false, errorReason: check.invalidReason };
  const expected = expectedFor(parsed.fields);
  let result: SettleResult;
  try {
    result = await ctx.facilitator.settle(encodePayload(payloadFor(parsed.fields, expected)), expected);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'settle failed';
    return { success: false, errorReason: message.slice(0, 200) };
  }
  if (!result.ok || !result.txHash) {
    return { success: false, errorReason: result.error ?? 'settle failed' };
  }
  return { success: true, transaction: result.txHash };
}

export async function handleFacilitator(req: Request, ctx: ClearingContext): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname !== '/verify' && url.pathname !== '/settle') return undefined;
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (url.pathname === '/verify') {
    const verdict = await verifyFacilitatorBody(raw, facilitatorPayToAllowlist(ctx.config.payTo), nowSec);
    return json(verdict, 200);
  }
  const settled = await settleFacilitatorBody(raw, ctx, nowSec);
  return json(settled, 200);
}
