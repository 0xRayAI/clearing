/**
 * Embeddable NEAR testnet settler. A foundry imports this and runs it in its
 * own process. It does not call hosted Clearing and it does not call Coinbase.
 *
 * Default path: the buyer already sent ft_transfer with the quote memo. The
 * module matches that transfer the way findPaidMemo does (xray#1185): outgoing
 * USDC, exact receiver, exact amount, exact memo, and a real tx hash.
 * Optional path: a NEP-366 SignedDelegate of ft_transfer. The foundry supplies
 * its own relayer account. No relayer means the delegate is refused.
 */
import {
  CIRCLE_USDC_NEAR_TESTNET,
  isNearAccountId,
  type NearReceiptReader,
  type NearTransferView,
} from './near-rail.js';

/** Base58 NEAR tx hash. 32 bytes, not an EVM 0x hash. */
const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Testnet indexer only. Mainnet is not a URL in this module. */
export const NEAR_TESTNET_INDEXER = 'https://api-testnet.nearblocks.io';

export type NearPaidRow = {
  hash?: string;
  memo?: string | null;
  delta?: string | null;
  token?: string | null;
  receiver?: string | null;
  amount?: string | null;
};

export type NearDelegate = {
  senderId: string;
  receiverId: string;
  methodName: string;
  deposit: string;
  receiver_id: string;
  amount: string;
  memo: string;
};

export type NearSettleDeps = {
  /** Foundry receivers. The module does not read payees from the environment. */
  allowPayTo: readonly string[];
  nowSec: () => bigint;
  readReceipt: NearReceiptReader;
  /** Recent ft rows for the signer. Used when the payload has a memo and no tx hash. */
  findRows?: (signerId: string) => Promise<readonly NearPaidRow[]>;
  /** Foundry-owned relayer. Absent means the NEP-366 path cannot settle. */
  relay?: (delegate: NearDelegate) => Promise<{ txHash: string; senderAccountId: string }>;
  /** Memo -> the one receipt that paid it. Same memo cannot pay twice. */
  book?: Map<string, BookedPayment>;
};

export type BookedPayment = {
  txHash: string;
  amount: string;
  payTo: string;
  signerId: string;
};

export type NearVerifyResult = { isValid: true } | { isValid: false; invalidReason: string };
export type NearSettleResult =
  | { success: true; transaction: string; replayed?: boolean }
  | { success: false; errorReason: string };

type DirectClaim = {
  kind: 'direct';
  memo: string;
  signerId: string;
  txHash?: string;
};

type DelegateClaim = {
  kind: 'delegate';
  memo: string;
  delegate: NearDelegate;
};

type Claim = DirectClaim | DelegateClaim;

type Requirements = {
  amount: string;
  payTo: string;
  memo: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

function decimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return value;
}

export function isNearTxHash(value: string): boolean {
  return NEAR_TX_HASH.test(value);
}

function argsOf(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  for (const action of actions) {
    const record = asRecord(action);
    if (!record) continue;
    if (typeof record.method === 'string' && record.method !== 'ft_transfer') continue;
    if (typeof record.args !== 'string') continue;
    try {
      return asRecord(JSON.parse(record.args) as unknown);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Same fields findPaidMemo reads from a nearblocks ft row. */
export function factsOfPaidRow(row: Record<string, unknown>): NearPaidRow {
  const args = argsOf(row);
  const ft = asRecord(row.ft);
  const token = typeof ft?.contract === 'string' ? ft.contract : typeof row.token === 'string' ? row.token : null;
  const delta = row.delta_amount == null ? null : String(row.delta_amount);
  const amount = row.amount != null
    ? String(row.amount)
    : args?.amount != null
      ? String(args.amount)
      : delta == null
        ? null
        : delta.replace(/^-/, '');
  const receiver = typeof row.receiver === 'string'
    ? row.receiver
    : typeof row.payTo === 'string'
      ? row.payTo
      : typeof row.involved_account_id === 'string'
        ? row.involved_account_id
        : typeof args?.receiver_id === 'string'
          ? args.receiver_id
          : null;
  const memo = typeof row.memo === 'string'
    ? row.memo
    : typeof ft?.memo === 'string'
      ? ft.memo
      : typeof args?.memo === 'string'
        ? args.memo
        : null;
  const hash = typeof row.hash === 'string' ? row.hash : typeof row.transaction_hash === 'string' ? row.transaction_hash : null;
  return { token, receiver, amount, memo, hash: hash ?? undefined, delta };
}

/** Latest testnet ft rows for the signer. Never calls a mainnet host. */
export async function loadTestnetMemoRows(
  signerId: string,
  fetchFn: typeof fetch,
): Promise<NearPaidRow[]> {
  const listUrl = `${NEAR_TESTNET_INDEXER}/v1/account/${encodeURIComponent(signerId)}/ft-txns?per_page=25`;
  const listed = await fetchFn(listUrl);
  const body = asRecord(await listed.json());
  const rows = Array.isArray(body?.txns) ? body.txns.slice(0, 25) : [];
  const detailed: NearPaidRow[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const ft = asRecord(record.ft);
    const hasMemo = typeof record.memo === 'string' || typeof ft?.memo === 'string' || (Array.isArray(record.actions) && record.actions.length > 0);
    if (hasMemo || typeof record.transaction_hash !== 'string') {
      detailed.push(factsOfPaidRow(record));
      continue;
    }
    const detailUrl = `${NEAR_TESTNET_INDEXER}/v1/txns/${record.transaction_hash}`;
    const detail = await fetchFn(detailUrl);
    const detailBody = asRecord(await detail.json());
    const txn = Array.isArray(detailBody?.txns) ? asRecord(detailBody.txns[0]) : undefined;
    detailed.push(factsOfPaidRow({
      ...record,
      actions: txn?.actions,
      receiver_account_id: txn?.receiver_account_id,
    }));
  }
  return detailed;
}

/**
 * One matching row wins. A row that carries the memo but fails the other
 * checks is a mismatch, same as findPaidMemo.
 */
export function selectPaidMemo(
  rows: readonly NearPaidRow[],
  quote: { nonce: string; payTo: string; amount: string; asset: string },
): { hash?: string; mismatch?: string } {
  for (const row of rows) {
    if (row.memo !== quote.nonce) continue;
    const outgoing = row.delta == null || row.delta.startsWith('-');
    if (!outgoing || row.token !== quote.asset || row.receiver !== quote.payTo || row.amount !== quote.amount) {
      return { mismatch: 'memo matched a transfer that is not this quote' };
    }
    if (!row.hash || !isNearTxHash(row.hash)) return { mismatch: 'memo matched a transfer with no tx hash' };
    return { hash: row.hash };
  }
  return {};
}

function decodeArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(raw);
}

/** NEP-366 SignedDelegate of one ft_transfer. Receiver is the USDC contract. Deposit is 1 yocto. */
export function readSignedDelegate(raw: unknown): { ok: true; delegate: NearDelegate } | { ok: false; reason: string } {
  const body = asRecord(raw);
  const action = asRecord(body?.delegateAction) ?? body;
  const senderId = typeof action?.senderId === 'string' ? action.senderId : '';
  const receiverId = typeof action?.receiverId === 'string' ? action.receiverId : '';
  const actions = Array.isArray(action?.actions) ? action.actions : [];
  const first = asRecord(actions[0]);
  const params = asRecord(first?.params);
  const methodName = typeof first?.methodName === 'string'
    ? first.methodName
    : typeof params?.methodName === 'string'
      ? params.methodName
      : '';
  const deposit = typeof first?.deposit === 'string'
    ? first.deposit
    : typeof params?.deposit === 'string'
      ? params.deposit
      : '';
  const args = decodeArgs(first?.args ?? params?.args);
  const to = typeof args?.receiver_id === 'string' ? args.receiver_id : '';
  const amount = decimal(args?.amount);
  const memo = typeof args?.memo === 'string' ? args.memo : '';
  if (!isNearAccountId(senderId)) return { ok: false, reason: 'delegate sender is not a NEAR account' };
  if (receiverId !== CIRCLE_USDC_NEAR_TESTNET) return { ok: false, reason: 'delegate receiver is not testnet USDC' };
  if (methodName !== 'ft_transfer') return { ok: false, reason: 'delegate method is not ft_transfer' };
  if (deposit !== '1') return { ok: false, reason: 'delegate deposit is not 1 yocto' };
  if (!isNearAccountId(to) || !amount || !memo) return { ok: false, reason: 'delegate ft_transfer args are incomplete' };
  return { ok: true, delegate: { senderId, receiverId, methodName, deposit, receiver_id: to, amount, memo } };
}

function requirementsOf(raw: unknown, nowSec: bigint): { ok: true; requirements: Requirements } | { ok: false; reason: string } {
  const body = asRecord(raw);
  const requirements = asRecord(body?.paymentRequirements);
  if (!requirements) return { ok: false, reason: 'payment requirements are incomplete' };
  const network = typeof requirements.network === 'string' ? requirements.network : '';
  if (network !== 'near:testnet') return { ok: false, reason: 'network is not near testnet' };
  if (requirements.asset !== CIRCLE_USDC_NEAR_TESTNET) return { ok: false, reason: 'asset is not testnet USDC' };
  const amount = decimal(requirements.amount);
  const payTo = typeof requirements.payTo === 'string' ? requirements.payTo : '';
  const validAfter = decimal(requirements.validAfter);
  const validBefore = decimal(requirements.validBefore);
  const extra = asRecord(requirements.extra);
  const memo = typeof extra?.memo === 'string' ? extra.memo : '';
  if (!amount || !isNearAccountId(payTo) || !memo) return { ok: false, reason: 'payment requirements are incomplete' };
  if (validAfter === undefined || validBefore === undefined) return { ok: false, reason: 'authorization is outside validAfter/validBefore' };
  if (!(BigInt(validAfter) <= nowSec && nowSec < BigInt(validBefore))) {
    return { ok: false, reason: 'authorization is outside validAfter/validBefore' };
  }
  return { ok: true, requirements: { amount, payTo, memo } };
}

function claimOf(raw: unknown, requirements: Requirements): { ok: true; claim: Claim } | { ok: false; reason: string } {
  const payload = asRecord(asRecord(asRecord(raw)?.paymentPayload)?.payload);
  if (!payload) return { ok: false, reason: 'payment payload is incomplete' };
  if (payload.signedDelegate !== undefined) {
    const decoded = readSignedDelegate(payload.signedDelegate);
    if (!decoded.ok) return decoded;
    if (decoded.delegate.receiver_id !== requirements.payTo) return { ok: false, reason: 'delegate receiver does not match payTo' };
    if (decoded.delegate.amount !== requirements.amount) return { ok: false, reason: 'delegate amount does not match requirements' };
    if (decoded.delegate.memo !== requirements.memo) return { ok: false, reason: 'delegate memo does not match requirements' };
    return { ok: true, claim: { kind: 'delegate', memo: requirements.memo, delegate: decoded.delegate } };
  }
  const signerId = typeof payload.signerId === 'string' ? payload.signerId : '';
  const memo = typeof payload.memo === 'string' ? payload.memo : '';
  const txHash = typeof payload.txHash === 'string' ? payload.txHash : undefined;
  if (!isNearAccountId(signerId) || memo !== requirements.memo) return { ok: false, reason: 'payment payload is incomplete' };
  if (txHash !== undefined && !isNearTxHash(txHash)) return { ok: false, reason: 'tx hash is not a NEAR transaction' };
  return { ok: true, claim: { kind: 'direct', memo, signerId, txHash } };
}

function viewMatches(view: NearTransferView, requirements: Requirements, signerId: string, txHash: string): string | undefined {
  if (!isNearTxHash(txHash)) return 'tx hash is not a NEAR transaction';
  if (view.finalExecutionStatus !== 'FINAL' || !view.executionSucceeded) return 'transfer is not final';
  if (view.memoConflict) return 'memo mismatch';
  if (view.senderAccountId !== signerId) return 'sender does not match the payload';
  if (view.tokenContract !== CIRCLE_USDC_NEAR_TESTNET) return 'asset is not testnet USDC';
  if (view.receiverId !== requirements.payTo) return 'receiver does not match payTo';
  if (view.amount !== requirements.amount) return 'amount does not match requirements';
  if (view.memo !== requirements.memo) return 'memo mismatch';
  return undefined;
}

export function createNearSettler(deps: NearSettleDeps) {
  const allow = new Set(deps.allowPayTo);
  const book = deps.book ?? new Map<string, BookedPayment>();

  function remember(requirements: Requirements, txHash: string, signerId: string): NearSettleResult {
    const prior = book.get(requirements.memo);
    if (prior) {
      const same = prior.txHash === txHash && prior.amount === requirements.amount && prior.payTo === requirements.payTo && prior.signerId === signerId;
      if (!same) return { success: false, errorReason: 'payment already used' };
      return { success: true, transaction: prior.txHash, replayed: true };
    }
    const booked: BookedPayment = { txHash, amount: requirements.amount, payTo: requirements.payTo, signerId };
    book.set(requirements.memo, booked);
    return { success: true, transaction: txHash };
  }

  function gate(raw: unknown): { ok: true; requirements: Requirements; claim: Claim } | { ok: false; reason: string } {
    const requirements = requirementsOf(raw, deps.nowSec());
    if (!requirements.ok) return requirements;
    if (!allow.has(requirements.requirements.payTo)) return { ok: false, reason: 'payTo is not an allowed treasury' };
    const claim = claimOf(raw, requirements.requirements);
    if (!claim.ok) return claim;
    return { ok: true, requirements: requirements.requirements, claim: claim.claim };
  }

  async function locate(requirements: Requirements, claim: DirectClaim): Promise<{ ok: true; txHash: string; signerId: string } | { ok: false; reason: string }> {
    if (claim.txHash) return { ok: true, txHash: claim.txHash, signerId: claim.signerId };
    if (!deps.findRows) return { ok: false, reason: 'payment not found' };
    let rows: readonly NearPaidRow[];
    try {
      rows = await deps.findRows(claim.signerId);
    } catch {
      return { ok: false, reason: 'payment not found' };
    }
    const found = selectPaidMemo(rows, {
      nonce: requirements.memo,
      payTo: requirements.payTo,
      amount: requirements.amount,
      asset: CIRCLE_USDC_NEAR_TESTNET,
    });
    if (found.mismatch) return { ok: false, reason: found.mismatch };
    if (!found.hash) return { ok: false, reason: 'payment not found' };
    return { ok: true, txHash: found.hash, signerId: claim.signerId };
  }

  async function confirm(requirements: Requirements, txHash: string, signerId: string): Promise<string | undefined> {
    let view: NearTransferView;
    try {
      view = await deps.readReceipt(txHash, signerId);
    } catch {
      return 'transfer is not final';
    }
    return viewMatches(view, requirements, signerId, txHash);
  }

  return {
    async verify(raw: unknown): Promise<NearVerifyResult> {
      const gated = gate(raw);
      if (!gated.ok) return { isValid: false, invalidReason: gated.reason };
      if (gated.claim.kind === 'delegate') return { isValid: true };
      const located = await locate(gated.requirements, gated.claim);
      if (!located.ok) return { isValid: false, invalidReason: located.reason };
      const failed = await confirm(gated.requirements, located.txHash, located.signerId);
      if (failed) return { isValid: false, invalidReason: failed };
      return { isValid: true };
    },

    async settle(raw: unknown): Promise<NearSettleResult> {
      const gated = gate(raw);
      if (!gated.ok) return { success: false, errorReason: gated.reason };
      const prior = book.get(gated.requirements.memo);
      if (prior && (prior.amount !== gated.requirements.amount || prior.payTo !== gated.requirements.payTo)) {
        return { success: false, errorReason: 'payment already used' };
      }
      if (gated.claim.kind === 'delegate') {
        if (prior) return { success: true, transaction: prior.txHash, replayed: true };
        if (!deps.relay) return { success: false, errorReason: 'relayer is not configured' };
        let relayed: { txHash: string; senderAccountId: string };
        try {
          relayed = await deps.relay(gated.claim.delegate);
        } catch {
          return { success: false, errorReason: 'relayer did not return a tx hash' };
        }
        if (!isNearTxHash(relayed.txHash)) return { success: false, errorReason: 'relayer did not return a tx hash' };
        const failed = await confirm(gated.requirements, relayed.txHash, relayed.senderAccountId);
        if (failed) return { success: false, errorReason: failed };
        return remember(gated.requirements, relayed.txHash, relayed.senderAccountId);
      }
      const located = await locate(gated.requirements, gated.claim);
      if (!located.ok) return { success: false, errorReason: located.reason };
      if (prior && (prior.txHash !== located.txHash || prior.signerId !== located.signerId)) {
        return { success: false, errorReason: 'payment already used' };
      }
      if (prior) return { success: true, transaction: prior.txHash, replayed: true };
      const failed = await confirm(gated.requirements, located.txHash, located.signerId);
      if (failed) return { success: false, errorReason: failed };
      return remember(gated.requirements, located.txHash, located.signerId);
    },
  };
}
