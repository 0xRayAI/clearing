/**
 * NEAR USDC rail for one Clearing 402.
 *
 * Borrowed idea, not copied code: a 402 quote nonce checked against an
 * ft_transfer after the tx is final.
 * Cite: MihenkAI/near-pay-per-call@1da0b45c4f9ad29cdf654e773a2c9e878bcc2d3d server.mjs
 * Rewritten here: Circle testnet USDC, amount string equality, 180s TTL,
 * final_execution_status FINAL. The memo is read from the ft_transfer
 * FunctionCall args and from the nep141 event log. When both are present
 * they must match.
 * Circle testnet USDC tx 53LCBQv92Fp2h19FAnpx1Ng4NacFz1Ncxf3dbnZf47C has
 * memo "deposit" in both places (0xRayAI/xray#1148 comment 6913091316).
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
import type { Ledger } from './ledger.js';
import type { NearRailAccept, Receipt } from './types.js';

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
  /** executor_id of the receipt that ran ft_transfer, not the outer tx receiver. */
  tokenContract: string;
  receiverId: string;
  amount: string;
  memo?: string;
  /** True when FunctionCall args and the event log both carry a memo and they differ. */
  memoConflict?: boolean;
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

const QUOTE_PREFIX = 'near-quote:';
const TX_PREFIX = 'near-tx:';
/** Ledger rows need a hex payTo. The NEAR receiver lives in `body`. */
const LEDGER_PAY_TO = '0x0000000000000000000000000000000000000000' as const;

export function nearQuotePaymentId(nonce: string): string {
  return `${QUOTE_PREFIX}${nonce}`;
}

function nearTxPaymentId(txHash: string): string {
  return `${TX_PREFIX}${txHash}`;
}

type QuoteBody = StoredNearQuote & { chain: 'near:testnet' };

function nearRow(paymentId: string, status: Receipt['status'], body: unknown, nowMs: number): Receipt {
  const at = new Date(nowMs).toISOString();
  return {
    paymentId,
    chainId: 8453,
    token: 'USDC',
    amountUsd: '0',
    payTo: LEDGER_PAY_TO,
    origin: 'near:testnet',
    resource: 'near:testnet',
    status,
    body,
    sessionId: 'near-rail',
    createdAt: at,
    updatedAt: at,
  };
}

function quoteBody(row: Receipt | undefined): QuoteBody | undefined {
  const body = row?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const rec = body as Partial<QuoteBody>;
  if (typeof rec.nonce !== 'string' || typeof rec.receiver !== 'string' || typeof rec.amount !== 'string') {
    return undefined;
  }
  if (typeof rec.expiresAt !== 'number') return undefined;
  return { receiver: rec.receiver, amount: rec.amount, nonce: rec.nonce, expiresAt: rec.expiresAt, chain: 'near:testnet' };
}

/**
 * Quotes, claimed nonces, and claimed tx hashes live on the same ledger as
 * Base receipts (`receipts.jsonl` when the context persists). A second
 * ledger opened on that file sees them.
 */
export function issueNearQuote(ledger: Ledger, input: IssueInput): StoredNearQuote {
  const nonce = randomBytes(16).toString('hex');
  const quote: StoredNearQuote = {
    receiver: input.receiver,
    amount: input.amount,
    nonce,
    expiresAt: input.nowMs + NEAR_QUOTE_TTL_MS,
  };
  ledger.put(nearRow(nearQuotePaymentId(nonce), 'quoted', { ...quote, chain: 'near:testnet' }, input.nowMs));
  return quote;
}

type Claim = { ok: true; quote: QuoteBody } | { ok: false; code: VerifyCode };

/** Synchronous. Runs before any RPC await so two callers cannot both pass. */
function claimNonce(ledger: Ledger, nonce: string, nowMs: number): Claim {
  const row = ledger.get(nearQuotePaymentId(nonce));
  if (!row) return { ok: false, code: 'missing_nonce' };
  if (row.status === 'settled' || row.status === 'submitted') return { ok: false, code: 'replayed_nonce' };
  if (row.status !== 'quoted') return { ok: false, code: 'missing_nonce' };
  const quote = quoteBody(row);
  if (!quote) return { ok: false, code: 'missing_nonce' };
  if (nowMs > quote.expiresAt) return { ok: false, code: 'nonce_past_ttl' };
  ledger.put({ ...row, status: 'submitted', updatedAt: new Date(nowMs).toISOString() });
  return { ok: true, quote };
}

function claimTx(ledger: Ledger, txHash: string, nowMs: number): boolean {
  const id = nearTxPaymentId(txHash);
  const row = ledger.get(id);
  if (row && (row.status === 'submitted' || row.status === 'settled')) return false;
  const at = new Date(nowMs).toISOString();
  ledger.put({
    ...(row ?? nearRow(id, 'submitted', { txHash, chain: 'near:testnet' }, nowMs)),
    status: 'submitted',
    updatedAt: at,
  });
  return true;
}

function releaseNonce(ledger: Ledger, nonce: string, nowMs: number): void {
  const row = ledger.get(nearQuotePaymentId(nonce));
  if (!row || row.status !== 'submitted') return;
  ledger.put({ ...row, status: 'quoted', updatedAt: new Date(nowMs).toISOString() });
}

function releaseTx(ledger: Ledger, txHash: string, nowMs: number): void {
  const row = ledger.get(nearTxPaymentId(txHash));
  if (!row || row.status !== 'submitted') return;
  ledger.put({ ...row, status: 'failed', updatedAt: new Date(nowMs).toISOString() });
}

function commitClaim(ledger: Ledger, nonce: string, txHash: string, nowMs: number): void {
  const at = new Date(nowMs).toISOString();
  const quote = ledger.get(nearQuotePaymentId(nonce));
  const tx = ledger.get(nearTxPaymentId(txHash));
  if (quote) ledger.put({ ...quote, status: 'settled', updatedAt: at });
  if (tx) ledger.put({ ...tx, status: 'settled', updatedAt: at });
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
  ledger: Ledger;
  txHash: string;
  senderAccountId: string;
  nonce: string;
  nowMs: number;
  readReceipt: NearReceiptReader;
}): Promise<VerifyResult> {
  const claimed = claimNonce(args.ledger, args.nonce, args.nowMs);
  if (!claimed.ok) return { ok: false, code: claimed.code };
  if (!claimTx(args.ledger, args.txHash, args.nowMs)) {
    releaseNonce(args.ledger, args.nonce, args.nowMs);
    return { ok: false, code: 'replayed_tx' };
  }

  const release = () => {
    releaseNonce(args.ledger, args.nonce, args.nowMs);
    releaseTx(args.ledger, args.txHash, args.nowMs);
  };
  let view: NearTransferView;
  try {
    view = await args.readReceipt(args.txHash, args.senderAccountId);
  } catch {
    release();
    return { ok: false, code: 'not_final' };
  }
  const failed = checkView(view, claimed.quote, args.senderAccountId, args.nonce);
  if (failed) {
    release();
    return { ok: false, code: failed };
  }
  commitClaim(args.ledger, args.nonce, args.txHash, args.nowMs);
  return { ok: true, txHash: args.txHash, senderAccountId: args.senderAccountId, amount: claimed.quote.amount };
}

function checkView(
  view: NearTransferView,
  quote: QuoteBody,
  senderAccountId: string,
  nonce: string,
): VerifyCode | undefined {
  if (view.finalExecutionStatus !== 'FINAL' || !view.executionSucceeded) return 'not_final';
  if (view.memoConflict) return 'memo_mismatch';
  if (view.senderAccountId !== senderAccountId) return 'sender_mismatch';
  if (view.tokenContract !== CIRCLE_USDC_NEAR_TESTNET) return 'wrong_asset';
  if (view.receiverId !== quote.receiver) return 'wrong_receiver';
  if (view.amount !== quote.amount) return 'amount_not_equal';
  if (view.memo !== nonce) return 'memo_mismatch';
  return undefined;
}

type FunctionCall = { method_name?: string; args?: string };
type TxStatusBody = {
  final_execution_status?: string;
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: Array<{ FunctionCall?: FunctionCall }>;
  };
  receipts?: Array<{
    receiver_id?: string;
    receipt?: { Action?: { actions?: Array<{ FunctionCall?: FunctionCall }> } };
  }>;
  receipts_outcome?: Array<{
    outcome?: { executor_id?: string; status?: { Failure?: unknown }; logs?: string[] };
  }>;
};

type TransferFacts = { receiverId: string; amount: string; memo?: string };

/**
 * The paying receipt is the one whose executor_id is the USDC contract.
 * A delegate's outer transaction receiver is the relayer or the vault, not the token.
 * Memo is taken from that receipt's FunctionCall args and from its nep141 event.
 * Circle testnet USDC tx 53LCBQv92Fp2h19FAnpx1Ng4NacFz1Ncxf3dbnZf47C carries
 * memo "deposit" in both (0xRayAI/xray#1148 comment 6913091316).
 */
export function transferFromTxStatus(body: unknown, senderAccountId: string): NearTransferView {
  const tx = (body ?? {}) as TxStatusBody;
  const finalExecutionStatus = String(tx.final_execution_status ?? '');
  const success = Boolean(tx.status && 'SuccessValue' in tx.status && !tx.status.Failure);
  const failedReceipt = (tx.receipts_outcome ?? []).some((row) => row.outcome?.status?.Failure);
  const event = findTransferEvent(tx, senderAccountId);
  const args = findTransferArgs(tx);
  const memoConflict = args?.memo !== undefined && event?.memo !== undefined && args.memo !== event.memo;
  const fieldsConflict =
    memoConflict ||
    (args?.amount !== undefined && event?.amount !== undefined && args.amount !== event.amount) ||
    (args?.receiverId !== undefined && event?.receiverId !== undefined && args.receiverId !== event.receiverId);
  return {
    finalExecutionStatus,
    executionSucceeded: success && !failedReceipt && finalExecutionStatus === 'FINAL' && Boolean(event),
    senderAccountId: event?.senderAccountId ?? '',
    tokenContract: event?.executorId ?? '',
    receiverId: event?.receiverId ?? '',
    amount: event?.amount ?? '',
    memo: fieldsConflict ? undefined : (event?.memo ?? args?.memo),
    memoConflict: fieldsConflict,
  };
}

function decodeCallArgs(raw: string | undefined): TransferFacts | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
      receiver_id?: string;
      amount?: string;
      memo?: string;
    };
    if (typeof parsed.receiver_id !== 'string' || typeof parsed.amount !== 'string') return undefined;
    return {
      receiverId: parsed.receiver_id,
      amount: parsed.amount,
      memo: typeof parsed.memo === 'string' ? parsed.memo : undefined,
    };
  } catch {
    return undefined;
  }
}

function findTransferArgs(tx: TxStatusBody): TransferFacts | undefined {
  for (const receipt of tx.receipts ?? []) {
    if (receipt.receiver_id !== CIRCLE_USDC_NEAR_TESTNET) continue;
    for (const action of receipt.receipt?.Action?.actions ?? []) {
      if (action.FunctionCall?.method_name !== 'ft_transfer') continue;
      const decoded = decodeCallArgs(action.FunctionCall.args);
      if (decoded) return decoded;
    }
  }
  if (tx.transaction?.receiver_id === CIRCLE_USDC_NEAR_TESTNET) {
    for (const action of tx.transaction.actions ?? []) {
      if (action.FunctionCall?.method_name !== 'ft_transfer') continue;
      const decoded = decodeCallArgs(action.FunctionCall.args);
      if (decoded) return decoded;
    }
  }
  return undefined;
}

function findTransferEvent(
  tx: TxStatusBody,
  senderAccountId: string,
): { executorId: string; senderAccountId: string; receiverId: string; amount: string; memo?: string } | undefined {
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
        executorId: outcome.executor_id,
        senderAccountId: rowData.old_owner_id ?? senderAccountId,
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
