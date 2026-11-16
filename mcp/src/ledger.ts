import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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

/**
 * A crashed stealer's guard is swept after this. Tests set
 * CLEARING_LEDGER_STEAL_STALE_MS. A live steal finishes well inside it.
 */
function stealGuardStaleMs(): number {
  const raw = Number(process.env.CLEARING_LEDGER_STEAL_STALE_MS ?? 5_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
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
   * Exclusive lock is O_CREAT|O_EXCL (open(2)). Stealers share one
   * path.steal guard. Inside it, a lock is renamed only when a fresh
   * snapshot is still the stale one. Release renames only its own inode.
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

export type LedgerRelease = 'released' | 'lost';

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

/**
 * Drop our lock. Design (a): the same path.steal guard serializes this with
 * stealers, so path is renamed only while its inode is still ours. A mismatch
 * means the lock was already taken; that is reported as lost and nothing is
 * put back. A restore is never attempted, so path is not empty for a live holder.
 */
export function releaseLedgerLock(path: string, held: LedgerLock): LedgerRelease {
  let result: LedgerRelease = 'lost';
  try {
    result = withStealGuard(path, () => releaseOwnedLock(path, held));
  } finally {
    try {
      closeSync(held.fd);
    } catch {
      /* already closed */
    }
  }
  return result;
}

function lockSnapshot(path: string): { token: string; mtimeMs: number } | undefined {
  try {
    return { token: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function isStale(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > staleLockMs();
}

/**
 * Design (a). Stealers and releasers take path.steal with O_EXCL before they
 * look again. Inside that guard the snapshot is repeated. The lock is renamed
 * only when the token and mtime still match that stale snapshot, so a second
 * stealer cannot rename a fresh lock and no restore is required. Grave names
 * carry the token plus a random suffix. Leftover graves are ignored. A steal
 * guard older than its own timeout is renamed aside and deleted only when
 * that renamed file is still stale, so a crash cannot block the next acquire.
 */
function stealStaleLock(path: string): boolean {
  const seen = lockSnapshot(path);
  if (!seen || !isStale(seen.mtimeMs)) return false;
  return withStealGuard(path, () => {
    const again = lockSnapshot(path);
    if (!again || again.token !== seen.token || again.mtimeMs !== seen.mtimeMs) return false;
    if (!isStale(again.mtimeMs)) return false;
    const grave = `${path}.stale.${again.token}.${randomBytes(8).toString('hex')}`;
    try {
      renameSync(path, grave);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return false;
      throw err;
    }
    const moved = lockSnapshot(grave);
    if (moved && moved.token === again.token && isStale(moved.mtimeMs)) {
      try {
        unlinkSync(grave);
      } catch {
        /* already gone */
      }
    }
    return true;
  });
}

function releaseOwnedLock(path: string, held: LedgerLock): LedgerRelease {
  let currentIno: number;
  try {
    currentIno = statSync(path).ino;
  } catch {
    return 'lost';
  }
  if (currentIno !== fstatSync(held.fd).ino) return 'lost';
  const grave = `${path}.rel.${held.token}.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(path, grave);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return 'lost';
    throw err;
  }
  const moved = lockSnapshot(grave);
  if (moved?.token === held.token) {
    try {
      unlinkSync(grave);
    } catch {
      /* already gone */
    }
    return 'released';
  }
  return 'lost';
}

function withStealGuard<T>(lockPath: string, fn: () => T): T {
  const held = acquireStealGuard(lockPath);
  try {
    return fn();
  } finally {
    releaseStealGuard(`${lockPath}.steal`, held);
  }
}

function acquireStealGuard(lockPath: string): LedgerLock {
  const guard = `${lockPath}.steal`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(guard, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
      writeSync(fd, token);
      return { fd, token };
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (sweepStaleGuard(guard)) continue;
      if (Date.now() - started > staleLockMs() + stealGuardStaleMs() + 5_000) {
        throw new Error(`ledger steal guard timeout: ${guard}`);
      }
      sleepMs(15);
    }
  }
}

function releaseStealGuard(guard: string, held: LedgerLock): void {
  try {
    const current = statSync(guard);
    if (current.ino === fstatSync(held.fd).ino) {
      const grave = `${guard}.rel.${held.token}.${randomBytes(8).toString('hex')}`;
      renameSync(guard, grave);
      const moved = lockSnapshot(grave);
      if (moved?.token === held.token) {
        try {
          unlinkSync(grave);
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* a sweep already moved a crashed guard */
  } finally {
    try {
      closeSync(held.fd);
    } catch {
      /* already closed */
    }
  }
}

function sweepStaleGuard(guard: string): boolean {
  const seen = lockSnapshot(guard);
  if (!seen || Date.now() - seen.mtimeMs <= stealGuardStaleMs()) return false;
  const grave = `${guard}.old.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(guard, grave);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
  const moved = lockSnapshot(grave);
  if (moved && Date.now() - moved.mtimeMs > stealGuardStaleMs()) {
    try {
      unlinkSync(grave);
    } catch {
      /* already gone */
    }
    return true;
  }
  return false;
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
