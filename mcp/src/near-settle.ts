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
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import {
  CIRCLE_USDC_NEAR_TESTNET,
  isNearAccountId,
  NEAR_TESTNET_RPC,
  type NearReceiptReader,
  type NearTransferView,
} from './near-rail.js';

/** Base58 NEAR tx hash. 32 bytes, not an EVM 0x hash. */
const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Same window as Base `buildRequirements` (`maxTimeoutSeconds` default 60). */
export const NEAR_VALIDITY_CAP_SECONDS = 60n;

/** One relay attempt. A failed delegate is not sent again. */
export const DELEGATE_ATTEMPT_CAP = 1;

/** ft_transfer gas the relayer may attach. Matches the near-pay submit (30 Tgas). */
export const MAX_DELEGATE_GAS = 30_000_000_000_000n;

/** NEP-461 prefix for NEP-366 delegate actions: 2^30 + 366. */
const DELEGATE_ACTION_PREFIX = 1_073_742_190;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
  gas: string;
  receiver_id: string;
  amount: string;
  memo: string;
  nonce: string;
  maxBlockHeight: string;
  publicKey: string;
  signature: string;
  args: Buffer;
  message: Buffer;
  lockId: string;
};

export type NearAccessKey = { nonce: bigint; fullAccess: boolean };

/** Testnet chain reads. A missing view fails closed. Mainnet is not a method here. */
export type NearChain = {
  blockHeight: () => Promise<bigint>;
  accessKey: (accountId: string, publicKey: string) => Promise<NearAccessKey | undefined>;
};

export type DelegateLock = {
  status: 'inflight' | 'failed' | 'settled';
  attempts: number;
  txHash?: string;
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
  /** Delegate hash -> one attempt. Claimed before relay. */
  delegateLocks?: Map<string, DelegateLock>;
  /** Required for a delegate. Direct ft_transfer does not use it. */
  chain?: NearChain;
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
  /** Outer transaction signer. A relayed ft_transfer is signed by the relayer. */
  txSigner: string;
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

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function u128(value: bigint): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes;
}

function borshStr(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

function borshBytes(bytes: Buffer): Buffer {
  return Buffer.concat([u32(bytes.length), bytes]);
}

export function decodeBase58(value: string): Buffer | undefined {
  if (!value) return undefined;
  let n = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return undefined;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

export function encodeBase58(bytes: Buffer): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || '1';
}

/** Prefixed NEP-366 bytes. The signature covers sha256 of this buffer. */
export function encodeDelegateAction(action: {
  senderId: string;
  receiverId: string;
  methodName: string;
  args: Buffer;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: Buffer;
}): Buffer {
  const call = Buffer.concat([
    Buffer.from([2]),
    borshStr(action.methodName),
    borshBytes(action.args),
    u64(action.gas),
    u128(action.deposit),
  ]);
  return Buffer.concat([
    u32(DELEGATE_ACTION_PREFIX),
    borshStr(action.senderId),
    borshStr(action.receiverId),
    u32(1),
    call,
    u64(action.nonce),
    u64(action.maxBlockHeight),
    Buffer.from([0]),
    action.publicKey,
  ]);
}

function ed25519Ok(digest: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verifyEd25519(null, digest, key, signature);
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

function actionFields(action: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(action.FunctionCall) ?? asRecord(action.functionCall);
  const params = asRecord(action.params);
  return nested ?? params ?? action;
}

function fieldString(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return '';
}

function argsBytes(raw: unknown): Buffer | undefined {
  if (typeof raw === 'string') {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 0) return undefined;
    return decoded;
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  return Buffer.from(JSON.stringify(record), 'utf8');
}

/**
 * One NEP-366 SignedDelegate. Exactly one FunctionCall, and that call is
 * ft_transfer of testnet USDC with a 1 yocto deposit. The signature must
 * match the delegate public key.
 */
export function readSignedDelegate(raw: unknown): { ok: true; delegate: NearDelegate } | { ok: false; reason: string } {
  const body = asRecord(raw);
  const action = asRecord(body?.delegateAction) ?? body;
  const senderId = typeof action?.senderId === 'string' ? action.senderId : '';
  const receiverId = typeof action?.receiverId === 'string' ? action.receiverId : '';
  const actions = Array.isArray(action?.actions) ? action.actions : [];
  if (actions.length !== 1) return { ok: false, reason: 'delegate must contain exactly one action' };
  const first = asRecord(actions[0]);
  if (!first) return { ok: false, reason: 'delegate must contain exactly one action' };
  const fields = actionFields(first);
  const methodName = fieldString(fields, ['methodName', 'method_name']);
  const deposit = fieldString(fields, ['deposit']);
  const gas = fieldString(fields, ['gas']);
  const argsRaw = fields.args;
  const argsRecord = decodeArgs(argsRaw);
  const args = argsBytes(argsRaw);
  const to = typeof argsRecord?.receiver_id === 'string' ? argsRecord.receiver_id : '';
  const amount = decimal(argsRecord?.amount);
  const memo = typeof argsRecord?.memo === 'string' ? argsRecord.memo : '';
  const nonce = fieldString(action ?? {}, ['nonce']);
  const maxBlockHeight = fieldString(action ?? {}, ['maxBlockHeight', 'max_block_height']);
  const publicKey = fieldString(action ?? {}, ['publicKey', 'public_key']);
  const signature = typeof body?.signature === 'string' ? body.signature : fieldString(action ?? {}, ['signature']);
  if (!isNearAccountId(senderId)) return { ok: false, reason: 'delegate sender is not a NEAR account' };
  if (receiverId !== CIRCLE_USDC_NEAR_TESTNET) return { ok: false, reason: 'delegate receiver is not testnet USDC' };
  if (methodName !== 'ft_transfer') return { ok: false, reason: 'delegate method is not ft_transfer' };
  if (deposit !== '1') return { ok: false, reason: 'delegate deposit is not 1 yocto' };
  if (!/^\d+$/.test(gas) || BigInt(gas) <= 0n || BigInt(gas) > MAX_DELEGATE_GAS) {
    return { ok: false, reason: 'delegate gas exceeds the cap' };
  }
  if (!isNearAccountId(to) || !amount || !memo || !args) return { ok: false, reason: 'delegate ft_transfer args are incomplete' };
  if (!/^\d+$/.test(nonce) || !/^\d+$/.test(maxBlockHeight)) return { ok: false, reason: 'delegate nonce or max_block_height is missing' };
  const keyRaw = publicKey.startsWith('ed25519:') ? decodeBase58(publicKey.slice('ed25519:'.length)) : undefined;
  const sigRaw = signature.startsWith('ed25519:') ? decodeBase58(signature.slice('ed25519:'.length)) : undefined;
  if (!keyRaw || !sigRaw) return { ok: false, reason: 'delegate public key is not ed25519' };
  const message = encodeDelegateAction({
    senderId,
    receiverId,
    methodName,
    args,
    gas: BigInt(gas),
    deposit: 1n,
    nonce: BigInt(nonce),
    maxBlockHeight: BigInt(maxBlockHeight),
    publicKey: keyRaw,
  });
  const digest = createHash('sha256').update(message).digest();
  if (!ed25519Ok(digest, sigRaw, keyRaw)) return { ok: false, reason: 'delegate signature does not match the public key' };
  const lockId = createHash('sha256').update(message).update(sigRaw).digest('hex');
  return {
    ok: true,
    delegate: {
      senderId,
      receiverId,
      methodName,
      deposit,
      gas,
      receiver_id: to,
      amount,
      memo,
      nonce,
      maxBlockHeight,
      publicKey,
      signature,
      args,
      message,
      lockId,
    },
  };
}

async function screenDelegate(delegate: NearDelegate, chain: NearChain | undefined): Promise<string | undefined> {
  if (!chain) return 'chain state is unavailable';
  let height: bigint;
  let key: NearAccessKey | undefined;
  try {
    height = await chain.blockHeight();
    key = await chain.accessKey(delegate.senderId, delegate.publicKey);
  } catch {
    return 'chain state is unavailable';
  }
  if (!key) return 'delegate public key is not an access key';
  if (!key.fullAccess) return 'delegate public key is not a full access key';
  const nonce = BigInt(delegate.nonce);
  const maxBlockHeight = BigInt(delegate.maxBlockHeight);
  if (nonce <= key.nonce) return 'delegate nonce is not above the access key nonce';
  if (nonce >= height * 1_000_000n) return 'delegate nonce exceeds the block bound';
  if (maxBlockHeight <= height) return 'delegate max_block_height is not above the current block';
  if (maxBlockHeight - height > NEAR_VALIDITY_CAP_SECONDS) return 'delegate max_block_height exceeds the timeout';
  return undefined;
}

function requirementsOf(raw: unknown, nowSec: bigint): { ok: true; requirements: Requirements } | { ok: false; reason: string } {
  const body = asRecord(raw);
  const requirements = asRecord(body?.paymentRequirements);
  if (!requirements) return { ok: false, reason: 'payment requirements are incomplete' };
  const network = typeof requirements.network === 'string' ? requirements.network : '';
  const payToEarly = typeof requirements.payTo === 'string' ? requirements.payTo : '';
  if (network === 'near:mainnet' && payToEarly.endsWith('.testnet')) {
    return { ok: false, reason: 'mainnet cannot accept a testnet payee' };
  }
  if (network !== 'near:testnet') return { ok: false, reason: 'network is not near testnet' };
  if (requirements.asset !== CIRCLE_USDC_NEAR_TESTNET) return { ok: false, reason: 'asset is not testnet USDC' };
  const amount = decimal(requirements.amount);
  const payTo = typeof requirements.payTo === 'string' ? requirements.payTo : '';
  const validAfter = decimal(requirements.validAfter);
  const validBefore = decimal(requirements.validBefore);
  const extra = asRecord(requirements.extra);
  const memo = typeof extra?.memo === 'string' ? extra.memo : '';
  if (!amount || !isNearAccountId(payTo) || !payTo.endsWith('.testnet') || !memo) {
    return { ok: false, reason: payTo && !payTo.endsWith('.testnet') ? 'payTo is not a testnet account' : 'payment requirements are incomplete' };
  }
  if (validAfter === undefined || validBefore === undefined) return { ok: false, reason: 'authorization is outside validAfter/validBefore' };
  const after = BigInt(validAfter);
  const before = BigInt(validBefore);
  if (!(after <= nowSec && nowSec < before)) return { ok: false, reason: 'authorization is outside validAfter/validBefore' };
  if (before - after > NEAR_VALIDITY_CAP_SECONDS || before - nowSec > NEAR_VALIDITY_CAP_SECONDS) {
    return { ok: false, reason: 'validity window exceeds 60 seconds' };
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
  const txSigner = typeof payload.txSigner === 'string' ? payload.txSigner : signerId;
  if (!isNearAccountId(signerId) || !isNearAccountId(txSigner) || memo !== requirements.memo) {
    return { ok: false, reason: 'payment payload is incomplete' };
  }
  if (txHash !== undefined && !isNearTxHash(txHash)) return { ok: false, reason: 'tx hash is not a NEAR transaction' };
  return { ok: true, claim: { kind: 'direct', memo, signerId, txHash, txSigner } };
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

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 'near-settle', method, params });
}

/** Final block height on testnet. Optimistic finality is not used. */
export async function readNearTestnetBlock(fetchFn: typeof fetch): Promise<bigint> {
  const res = await fetchFn(NEAR_TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rpcBody('block', { finality: 'final' }),
  });
  const header = asRecord(asRecord(asRecord(await res.json())?.result)?.header);
  const height = header?.height;
  if (typeof height !== 'number' && typeof height !== 'string') throw new Error('block height missing');
  return BigInt(height);
}

/** view_access_key on testnet. A missing key or a function-call key is not full access. */
export async function readNearTestnetAccessKey(
  accountId: string,
  publicKey: string,
  fetchFn: typeof fetch,
): Promise<NearAccessKey | undefined> {
  const res = await fetchFn(NEAR_TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rpcBody('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    }),
  });
  const result = asRecord(asRecord(await res.json())?.result);
  if (!result || result.nonce == null) return undefined;
  const nonce = typeof result.nonce === 'number' || typeof result.nonce === 'string' ? BigInt(result.nonce) : undefined;
  if (nonce === undefined) return undefined;
  return { nonce, fullAccess: result.permission === 'FullAccess' };
}

export function createNearSettler(deps: NearSettleDeps) {
  const allow = new Set(deps.allowPayTo);
  const book = deps.book ?? new Map<string, BookedPayment>();
  const delegateLocks = deps.delegateLocks ?? new Map<string, DelegateLock>();

  function claimDelegate(lockId: string): 'claimed' | 'inflight' | 'failed' | 'settled' {
    const row = delegateLocks.get(lockId);
    if (!row) {
      delegateLocks.set(lockId, { status: 'inflight', attempts: 1 });
      return 'claimed';
    }
    if (row.status === 'inflight') return 'inflight';
    if (row.status === 'settled') return 'settled';
    if (row.attempts >= DELEGATE_ATTEMPT_CAP || row.status === 'failed') return 'failed';
    return 'failed';
  }

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

  async function locate(requirements: Requirements, claim: DirectClaim): Promise<{ ok: true; txHash: string; signerId: string; txSigner: string } | { ok: false; reason: string }> {
    if (claim.txHash) return { ok: true, txHash: claim.txHash, signerId: claim.signerId, txSigner: claim.txSigner };
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
    return { ok: true, txHash: found.hash, signerId: claim.signerId, txSigner: claim.txSigner };
  }

  async function confirm(requirements: Requirements, txHash: string, txSigner: string, tokenSender: string): Promise<string | undefined> {
    let view: NearTransferView;
    try {
      view = await deps.readReceipt(txHash, txSigner, tokenSender);
    } catch {
      return 'transfer is not final';
    }
    return viewMatches(view, requirements, tokenSender, txHash);
  }

  return {
    async verify(raw: unknown): Promise<NearVerifyResult> {
      const gated = gate(raw);
      if (!gated.ok) return { isValid: false, invalidReason: gated.reason };
      if (gated.claim.kind === 'delegate') {
        const screened = await screenDelegate(gated.claim.delegate, deps.chain);
        if (screened) return { isValid: false, invalidReason: screened };
        return { isValid: true };
      }
      const located = await locate(gated.requirements, gated.claim);
      if (!located.ok) return { isValid: false, invalidReason: located.reason };
      const failed = await confirm(gated.requirements, located.txHash, located.txSigner, located.signerId);
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
        const screened = await screenDelegate(gated.claim.delegate, deps.chain);
        if (screened) return { success: false, errorReason: screened };
        if (!deps.relay) return { success: false, errorReason: 'relayer is not configured' };
        const claim = claimDelegate(gated.claim.delegate.lockId);
        if (claim === 'settled') {
          const locked = delegateLocks.get(gated.claim.delegate.lockId);
          if (locked?.txHash) return { success: true, transaction: locked.txHash, replayed: true };
        }
        if (claim === 'inflight') return { success: false, errorReason: 'delegate is already settling' };
        if (claim === 'failed') return { success: false, errorReason: 'delegate relay attempt cap reached' };
        const lock = delegateLocks.get(gated.claim.delegate.lockId);
        let relayed: { txHash: string; senderAccountId: string };
        try {
          relayed = await deps.relay(gated.claim.delegate);
        } catch {
          if (lock) lock.status = 'failed';
          return { success: false, errorReason: 'relayer did not return a tx hash' };
        }
        if (!isNearTxHash(relayed.txHash)) {
          if (lock) lock.status = 'failed';
          return { success: false, errorReason: 'relayer did not return a tx hash' };
        }
        const failed = await confirm(
          gated.requirements,
          relayed.txHash,
          relayed.senderAccountId,
          gated.claim.delegate.senderId,
        );
        if (failed) {
          if (lock) lock.status = 'failed';
          return { success: false, errorReason: failed };
        }
        if (lock) {
          lock.status = 'settled';
          lock.txHash = relayed.txHash;
        }
        return remember(gated.requirements, relayed.txHash, relayed.senderAccountId);
      }
      const located = await locate(gated.requirements, gated.claim);
      if (!located.ok) return { success: false, errorReason: located.reason };
      if (prior && (prior.txHash !== located.txHash || prior.signerId !== located.signerId)) {
        return { success: false, errorReason: 'payment already used' };
      }
      if (prior) return { success: true, transaction: prior.txHash, replayed: true };
      const failed = await confirm(gated.requirements, located.txHash, located.txSigner, located.signerId);
      if (failed) return { success: false, errorReason: failed };
      return remember(gated.requirements, located.txHash, located.signerId);
    },
  };
}
