/**
 * Public x402 facilitator for Dynamo. Coinbase settles and pays Base gas.
 * Pin and the shops keep ctx.facilitator (zigzag). payTo must be one of our treasuries.
 * The allowlist and CDP key values are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { missingCdpKeyEnv } from './cdp-auth.js';
import { isHexAddress, normalizeAddress } from './bytes.js';
import { CdpFacilitator, createFacilitator } from './facilitator.js';
import { readNearTestnetReceipt } from './near-rail.js';
import {
  createNearSettler,
  loadTestnetMemoRows,
  readNearTestnetAccessKey,
  readNearTestnetBlock,
  type BookedPayment,
  type DelegateLock,
} from './near-settle.js';
import { USDC_BASE } from './types.js';
import type { ClearingContext } from './context.js';
import type { FetchFn, HexAddress } from './types.js';

export const VORTEX_TREASURY = '0xd45CcF98D6db5A36E7CdD10ffae0b685BF27CE43' as const;
/** Hangar payTo checked in at SKILL.md and kit.env. Not read from the environment. */
export const HANGAR_TREASURY = '0xc9cD4E19e8fFabFC479352680295ba12e454462D' as const;
/** Blaze, testnet only. Pays the hosted testnet payee and the relay gas. Not a mainnet account. */
export const NEAR_TESTNET_TREASURY = 'clearing-treasury-0xray.testnet' as const;

/**
 * Hosted NEAR payees by network. Literals only. Environment variables do not add accounts.
 * near:mainnet stays empty, so a mainnet payment fails closed.
 */
export const HOSTED_NEAR_PAYEES = {
  'near:testnet': [NEAR_TESTNET_TREASURY],
  'near:mainnet': [],
} as const;

/** Relay-gas account by network. Mainnet has none. */
export const HOSTED_NEAR_RELAYER = {
  'near:testnet': NEAR_TESTNET_TREASURY,
  'near:mainnet': '',
} as const;

export function hostedNearPayees(network: string): readonly string[] {
  if (network === 'near:testnet') return HOSTED_NEAR_PAYEES['near:testnet'];
  if (network === 'near:mainnet') return HOSTED_NEAR_PAYEES['near:mainnet'];
  return [];
}

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

/** Vortex and the hangar treasury. Environment variables do not add addresses. */
export function facilitatorPayToAllowlist(): Set<string> {
  return new Set([normalizeAddress(VORTEX_TREASURY), normalizeAddress(HANGAR_TREASURY)]);
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

/** One receipt per memo for the hosted caller. The embeddable module keeps its own book. */
const hostedNearBook = new Map<string, BookedPayment>();
/** One relay attempt per delegate for the hosted caller. */
const hostedDelegateLocks = new Map<string, DelegateLock>();

function isNearNetwork(raw: unknown): boolean {
  const network = asRecord(asRecord(raw)?.paymentRequirements)?.network;
  return typeof network === 'string' && network.startsWith('near:');
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
  nowSec: bigint,
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
  const validAfter = decimal(authorization.validAfter);
  const validBefore = decimal(authorization.validBefore);
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
  if (!isHexAddress(payTo) || !facilitatorPayToAllowlist().has(normalizeAddress(payTo))) {
    return { isValid: false, invalidReason: 'payTo is not an allowed treasury' };
  }
  if (!validAfter || !validBefore || !(BigInt(validAfter) <= nowSec && nowSec < BigInt(validBefore))) {
    return { isValid: false, invalidReason: 'authorization is outside validAfter/validBefore' };
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
  opts: { fetchFn?: FetchFn; nowSec?: bigint } = {},
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
  const nowSec = opts.nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  if (isNearNetwork(raw)) return settleNear(url.pathname, raw, nowSec, opts.fetchFn);
  const blocked = exactPaymentVerdict(raw, nowSec);
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

/**
 * Hosted /verify and /settle for near:* . One caller of the embeddable settler.
 * The payee list is the one for that network. Coinbase is not called.
 * Mainnet's list is empty, so the route returns before any RPC.
 */
async function settleNear(
  pathname: string,
  raw: unknown,
  nowSec: bigint,
  fetchFn?: FetchFn,
): Promise<Response> {
  const network = String(asRecord(asRecord(raw)?.paymentRequirements)?.network ?? '');
  const payees = hostedNearPayees(network);
  if (payees.length === 0) {
    const reason = network === 'near:mainnet' ? 'near:mainnet payee list is empty' : 'network is not near testnet';
    if (pathname === '/verify') return json({ isValid: false, invalidReason: reason }, 200);
    return json({ success: false, errorReason: reason }, 200);
  }
  const fetchImpl = (fetchFn ?? fetch) as typeof fetch;
  const settler = createNearSettler({
    allowPayTo: payees,
    nowSec: () => nowSec,
    readReceipt: (txHash, txSigner, tokenSender) => readNearTestnetReceipt(txHash, txSigner, fetchImpl, tokenSender ?? txSigner),
    findRows: (signerId) => loadTestnetMemoRows(signerId, fetchImpl),
    book: hostedNearBook,
    delegateLocks: hostedDelegateLocks,
    chain: {
      blockHeight: () => readNearTestnetBlock(fetchImpl),
      accessKey: (accountId, publicKey) => readNearTestnetAccessKey(accountId, publicKey, fetchImpl),
    },
  });
  if (pathname === '/verify') return json(await settler.verify(raw), 200);
  const settled = await settler.settle(raw);
  if (settled.success) return json({ success: true, transaction: settled.transaction }, 200);
  return json({ success: false, errorReason: settled.errorReason }, 200);
}
