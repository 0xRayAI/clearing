/**
 * NEAR USDC rail for one Clearing 402.
 *
 * Borrowed idea, not copied code: a 402 quote nonce checked against an
 * ft_transfer after the tx is final.
 * Cite: MihenkAI/near-pay-per-call@1da0b45c4f9ad29cdf654e773a2c9e878bcc2d3d server.mjs
 * Rewritten here: Circle testnet USDC, amount string equality, 180s TTL,
 * final_execution_status FINAL, memo taken from the nep141 event log.
 *
 * RPC: tx_status with wait_until FINAL.
 * https://docs.near.org/api/rpc/transactions
 * EXPERIMENTAL_tx_status is the deprecated alias (nearcore 2.14).
 * Event shape: NEP-141 EVENT_JSON ft_transfer.
 * https://docs.near.org/primitives/ft
 * Account ids: https://docs.near.org/protocol/account-id
 *
 * No plain-NEAR accept. A native Transfer has no memo field
 * (nearcore 2.14 core/primitives/src/views.rs Transfer { deposit }).
 */
import { randomBytes } from 'node:crypto';
import type { NearRailAccept } from './types.js';

/** Circle USDC on NEAR testnet. Confirmed by ft_metadata (symbol USDC, decimals 6). */
export const CIRCLE_USDC_NEAR_TESTNET =
  '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** Same window as the blip quote maxTimeoutSeconds. */
export const NEAR_QUOTE_TTL_MS = 180_000;

export const NEAR_TESTNET_RPC = 'https://rpc.testnet.near.org';

const ACCOUNT_ID =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);
}

export type StoredNearQuote = {
  receiver: string;
  amount: string;
  nonce: string;
  expiresAt: number;
};

export type NearTransferView = {
  finalExecutionStatus: string;
  executionSucceeded: boolean;
  senderAccountId: string;
  tokenContract: string;
  receiverId: string;
  amount: string;
  memo?: string;
};

export type NearReceiptReader = (
  txHash: string,
  senderAccountId: string,
) => Promise<NearTransferView>;

export type VerifyCode =
  | 'missing_nonce'
  | 'nonce_past_ttl'
  | 'replayed_nonce'
  | 'replayed_tx'
  | 'wrong_receiver'
  | 'amount_not_equal'
  | 'not_final'
  | 'memo_mismatch'
  | 'sender_mismatch'
  | 'wrong_asset';

export type VerifyResult =
  | { ok: true; txHash: string; senderAccountId: string; amount: string }
  | { ok: false; code: VerifyCode };

type IssueInput = {
  receiver: string;
  amount: string;
  nowMs: number;
};

const liveQuotes = new Map<string, StoredNearQuote>();
const usedNonces = new Set<string>();
const usedTx = new Set<string>();

export function resetNearRailForTests(): void {
  liveQuotes.clear();
  usedNonces.clear();
  usedTx.clear();
}

export function issueNearQuote(input: IssueInput): StoredNearQuote {
  const nonce = randomBytes(16).toString('hex');
  const quote: StoredNearQuote = {
    receiver: input.receiver,
    amount: input.amount,
    nonce,
    expiresAt: input.nowMs + NEAR_QUOTE_TTL_MS,
  };
  liveQuotes.set(nonce, quote);
  return quote;
}

export function nearAccept(args: {
  amount: string;
  payTo: string;
  resource: string;
  description: string;
  memo: string;
}): NearRailAccept {
  return {
    scheme: 'exact',
    network: 'near:testnet',
    maxAmountRequired: args.amount,
    amount: args.amount,
    asset: CIRCLE_USDC_NEAR_TESTNET,
    payTo: args.payTo,
    resource: args.resource,
    description: args.description,
    mimeType: 'application/json',
    maxTimeoutSeconds: NEAR_QUOTE_TTL_MS / 1000,
    extra: { method: 'ft_transfer', memo: args.memo },
  };
}

export type NearPaymentAttempt = {
  txHash: string;
  senderAccountId: string;
  nonce: string;
};

/** Caller supplies tx hash, sender, and nonce. Receiver and amount stay in the store. */
export function parseNearPayment(header: string): NearPaymentAttempt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const body = parsed as Record<string, unknown>;
  if (body.network !== 'near:testnet') return undefined;
  const txHash = body.txHash;
  const senderAccountId = body.senderAccountId;
  const nonce = body.nonce;
  if (typeof txHash !== 'string' || typeof senderAccountId !== 'string' || typeof nonce !== 'string') {
    return undefined;
  }
  if (!txHash || !nonce || !isNearAccountId(senderAccountId)) return undefined;
  return { txHash, senderAccountId, nonce };
}

export function encodeNearPayment(attempt: NearPaymentAttempt): string {
  return Buffer.from(JSON.stringify({ network: 'near:testnet', ...attempt })).toString('base64');
}

export async function verifyPayment(args: {
  txHash: string;
  senderAccountId: string;
  nonce: string;
  nowMs: number;
  readReceipt: NearReceiptReader;
}): Promise<VerifyResult> {
  if (usedNonces.has(args.nonce)) return { ok: false, code: 'replayed_nonce' };
  const quote = liveQuotes.get(args.nonce);
  if (!quote) return { ok: false, code: 'missing_nonce' };
  if (args.nowMs > quote.expiresAt) return { ok: false, code: 'nonce_past_ttl' };
  if (usedTx.has(args.txHash)) return { ok: false, code: 'replayed_tx' };

  let view: NearTransferView;
  try {
    view = await args.readReceipt(args.txHash, args.senderAccountId);
  } catch {
    return { ok: false, code: 'not_final' };
  }
  if (view.finalExecutionStatus !== 'FINAL' || !view.executionSucceeded) {
    return { ok: false, code: 'not_final' };
  }
  if (view.senderAccountId !== args.senderAccountId) return { ok: false, code: 'sender_mismatch' };
  if (view.tokenContract !== CIRCLE_USDC_NEAR_TESTNET) return { ok: false, code: 'wrong_asset' };
  if (view.receiverId !== quote.receiver) return { ok: false, code: 'wrong_receiver' };
  if (view.amount !== quote.amount) return { ok: false, code: 'amount_not_equal' };
  if (view.memo !== args.nonce) return { ok: false, code: 'memo_mismatch' };

  liveQuotes.delete(args.nonce);
  usedNonces.add(args.nonce);
  usedTx.add(args.txHash);
  return { ok: true, txHash: args.txHash, senderAccountId: args.senderAccountId, amount: quote.amount };
}

type TxStatusBody = {
  final_execution_status?: string;
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction?: { signer_id?: string; receiver_id?: string };
  receipts_outcome?: Array<{
    outcome?: { executor_id?: string; status?: { Failure?: unknown }; logs?: string[] };
  }>;
};

/**
 * Pull the nep141 ft_transfer the USDC contract logged.
 * Memo is read from that event, not from a caller-supplied quote.
 */
export function transferFromTxStatus(body: unknown, senderAccountId: string): NearTransferView {
  const tx = (body ?? {}) as TxStatusBody;
  const finalExecutionStatus = String(tx.final_execution_status ?? '');
  const success = Boolean(tx.status && 'SuccessValue' in tx.status && !tx.status.Failure);
  const failedReceipt = (tx.receipts_outcome ?? []).some((row) => row.outcome?.status?.Failure);
  const event = findTransferEvent(tx, senderAccountId);
  return {
    finalExecutionStatus,
    executionSucceeded: success && !failedReceipt && finalExecutionStatus === 'FINAL',
    senderAccountId: String(tx.transaction?.signer_id ?? ''),
    tokenContract: String(tx.transaction?.receiver_id ?? ''),
    receiverId: event?.receiverId ?? '',
    amount: event?.amount ?? '',
    memo: event?.memo,
  };
}

function findTransferEvent(
  tx: TxStatusBody,
  senderAccountId: string,
): { receiverId: string; amount: string; memo?: string } | undefined {
  for (const row of tx.receipts_outcome ?? []) {
    const outcome = row.outcome;
    if (outcome?.executor_id !== CIRCLE_USDC_NEAR_TESTNET) continue;
    for (const line of outcome.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
      } catch {
        continue;
      }
      const event = parsed as {
        standard?: string;
        event?: string;
        data?: Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string; memo?: string }>;
      };
      if (event.standard !== 'nep141' || event.event !== 'ft_transfer') continue;
      const rowData = event.data?.find((item) => item.old_owner_id === senderAccountId);
      if (!rowData?.new_owner_id || typeof rowData.amount !== 'string') continue;
      return {
        receiverId: rowData.new_owner_id,
        amount: rowData.amount,
        memo: typeof rowData.memo === 'string' ? rowData.memo : undefined,
      };
    }
  }
  return undefined;
}

export async function readNearTestnetReceipt(
  txHash: string,
  senderAccountId: string,
  fetchFn: typeof fetch = fetch,
): Promise<NearTransferView> {
  const res = await fetchFn(NEAR_TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'near-rail',
      method: 'tx_status',
      params: {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
        wait_until: 'FINAL',
      },
    }),
  });
  const payload = (await res.json()) as { result?: unknown };
  if (!payload.result) throw new Error('tx_status missing result');
  return transferFromTxStatus(payload.result, senderAccountId);
}
