import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Receipt, ReceiptStatus } from './types.js';
import { parseUsd } from './money.js';

/** A lock older than this is removed. Tests set CLEARING_LEDGER_LOCK_STALE_MS. */
function staleLockMs(): number {
  const raw = Number(process.env.CLEARING_LEDGER_LOCK_STALE_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

const COUNTED: ReceiptStatus[] = ['submitted', 'settled', 'replayed'];

export interface Ledger {
  get(paymentId: string): Receipt | undefined;
  put(receipt: Receipt): void;
  list(filter?: { since?: string; paymentId?: string; limit?: number }): Receipt[];
  spentUsd(opts: { sessionId?: string; day?: string }): number;
  /** Run `fn` with exclusive access. FileLedger re-reads the file inside the lock. */
  withLock<T>(fn: () => T): T;
}

export class MemoryLedger implements Ledger {
  private readonly byId = new Map<string, Receipt>();

  constructor(seed: Receipt[] = []) {
    for (const row of seed) this.byId.set(row.paymentId, row);
  }

  get(paymentId: string): Receipt | undefined {
    return this.byId.get(paymentId);
  }

  put(receipt: Receipt): void {
    this.byId.set(receipt.paymentId, { ...receipt });
  }

  list(filter: { since?: string; paymentId?: string; limit?: number } = {}): Receipt[] {
    let rows = [...this.byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (filter.paymentId) rows = rows.filter((r) => r.paymentId === filter.paymentId);
    if (filter.since) rows = rows.filter((r) => r.createdAt >= filter.since!);
    if (filter.limit) rows = rows.slice(0, filter.limit);
    return rows.map((r) => ({ ...r }));
  }

  spentUsd(opts: { sessionId?: string; day?: string } = {}): number {
    let total = 0;
    for (const row of this.byId.values()) {
      if (!COUNTED.includes(row.status)) continue;
      if (opts.sessionId && row.sessionId !== opts.sessionId) continue;
      if (opts.day && row.createdAt.slice(0, 10) !== opts.day) continue;
      total += parseUsd(row.amountUsd);
    }
    return total;
  }

  withLock<T>(fn: () => T): T {
    return fn();
  }

  protected replaceAll(rows: Receipt[]): void {
    this.byId.clear();
    for (const row of rows) this.byId.set(row.paymentId, { ...row });
  }
}

export class FileLedger extends MemoryLedger {
  constructor(private readonly path: string) {
    super(loadJsonl(path));
  }

  /**
   * Append-only. A later line for the same paymentId wins on load.
   * Exclusive lock is O_CREAT|O_EXCL (open(2)). Release unlinks only the
   * owner token written at create. A stale lock is removed only when a
   * second read still shows that same token and mtime.
   */
  override put(receipt: Receipt): void {
    super.put(receipt);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, 'utf8');
  }

  override withLock<T>(fn: () => T): T {
    const held = acquireLedgerLock(`${this.path}.lock`);
    try {
      this.replaceAll(loadJsonl(this.path));
      return fn();
    } finally {
      releaseLedgerLock(`${this.path}.lock`, held);
    }
  }
}

export type LedgerLock = { fd: number; token: string };

/** Exclusive lock. The file holds `pid:random` so only that owner may remove it. */
export function acquireLedgerLock(path: string): LedgerLock {
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const token = `${process.pid}:${randomBytes(16).toString('hex')}`;
      writeSync(fd, token);
      return { fd, token };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (stealStaleLock(path)) continue;
      if (Date.now() - started > staleLockMs() + 5_000) {
        throw new Error(`ledger lock timeout: ${path}`);
      }
      sleepMs(15);
    }
  }
}

/** Unlink only when the file still contains the token this holder wrote. */
export function releaseLedgerLock(path: string, held: LedgerLock): void {
  try {
    closeSync(held.fd);
  } catch {
    /* already closed */
  }
  try {
    if (readFileSync(path, 'utf8') !== held.token) return;
    unlinkSync(path);
  } catch {
    /* the file is already gone */
  }
}

function lockSnapshot(path: string): { token: string; mtimeMs: number } | undefined {
  try {
    return { token: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Remove a lock older than the stale window. A second read of the token and
 * mtime must still match, so a lock a new owner just created is left in place.
 */
function stealStaleLock(path: string): boolean {
  const seen = lockSnapshot(path);
  if (!seen || Date.now() - seen.mtimeMs <= staleLockMs()) return false;
  const again = lockSnapshot(path);
  if (!again || again.token !== seen.token || again.mtimeMs !== seen.mtimeMs) return false;
  if (Date.now() - again.mtimeMs <= staleLockMs()) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function loadJsonl(path: string): Receipt[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const rows: Receipt[] = [];
  const byId = new Map<string, Receipt>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Receipt;
    byId.set(row.paymentId, row);
  }
  for (const row of byId.values()) rows.push(row);
  return rows;
}

export function ledgerPath(dataDir: string): string {
  return join(dataDir, 'receipts.jsonl');
}

export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}
