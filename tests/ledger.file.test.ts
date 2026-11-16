import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireLedgerLock, FileLedger, ledgerPath, releaseLedgerLock } from '../mcp/src/ledger.js';
import type { Receipt } from '../mcp/src/types.js';

describe('file ledger', () => {
  it('persists and reloads by paymentId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-'));
    const path = ledgerPath(dir);
    const a = new FileLedger(path);
    const row: Receipt = {
      paymentId: '11111111-1111-4111-8111-111111111111',
      chainId: 8453,
      token: 'USDC',
      amountUsd: '0.02',
      payTo: '0x0000000000000000000000000000000000000402',
      origin: 'https://api.clearing.dev',
      resource: 'https://api.clearing.dev/v1/extract',
      status: 'settled',
      sessionId: 'sess',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    a.put(row);
    expect(readFileSync(path, 'utf8')).toContain(row.paymentId);
    const b = new FileLedger(path);
    expect(b.get(row.paymentId)?.status).toBe('settled');
    expect(b.spentUsd({ sessionId: 'sess' })).toBe(0.02);
  });

  it('a release after a stale takeover leaves the new owner lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-lock-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const previous = process.env.CLEARING_LEDGER_LOCK_STALE_MS;
    process.env.CLEARING_LEDGER_LOCK_STALE_MS = '1000';
    try {
      const first = acquireLedgerLock(lock);
      const past = new Date(Date.now() - 5_000);
      utimesSync(lock, past, past);
      const second = acquireLedgerLock(lock);
      expect(releaseLedgerLock(lock, first)).toBe('lost');
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, 'utf8')).toBe(second.token);
      releaseLedgerLock(lock, second);
      expect(existsSync(lock)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previous;
    }
  });

  it('three processes stealing one aged lock never overlap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-steal-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const log = join(dir, 'holders.log');
    writeFileSync(lock, `0:${'ab'.repeat(16)}`);
    const past = new Date(Date.now() - 5_000);
    utimesSync(lock, past, past);
    await Promise.all([enterLock(lock, log), enterLock(lock, log), enterLock(lock, log)]);
    expect(holderDepth(readFileSync(log, 'utf8'))).toEqual({ max: 1, enters: 3, open: 0 });
    expect(existsSync(lock)).toBe(false);
  });

  it('a release racing the stealers does not drop the new owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-release-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const log = join(dir, 'holders.log');
    const previous = process.env.CLEARING_LEDGER_LOCK_STALE_MS;
    process.env.CLEARING_LEDGER_LOCK_STALE_MS = '1000';
    try {
      const held = acquireLedgerLock(lock);
      const past = new Date(Date.now() - 5_000);
      utimesSync(lock, past, past);
      const racers = Promise.all([enterLock(lock, log), enterLock(lock, log), enterLock(lock, log)]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseLedgerLock(lock, held);
      await racers;
      expect(holderDepth(readFileSync(log, 'utf8'))).toEqual({ max: 1, enters: 3, open: 0 });
      expect(existsSync(lock)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previous;
    }
  });

  it('a fresh holder is not evicted and steal does not throw on the old restore path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-fresh-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const log = join(dir, 'holders.log');
    const previous = process.env.CLEARING_LEDGER_LOCK_STALE_MS;
    process.env.CLEARING_LEDGER_LOCK_STALE_MS = '1000';
    try {
      const held = acquireLedgerLock(lock);
      const child = enterLock(lock, log);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(readFileSync(lock, 'utf8')).toBe(held.token);
      expect(existsSync(log)).toBe(false);
      expect(releaseLedgerLock(lock, held)).toBe('released');
      await child;
      expect(holderDepth(readFileSync(log, 'utf8'))).toEqual({ max: 1, enters: 1, open: 0 });
    } finally {
      if (previous === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previous;
    }
  });

  it('a leftover grave and steal guard do not block the next acquire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-crash-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const previousLock = process.env.CLEARING_LEDGER_LOCK_STALE_MS;
    const previousGuard = process.env.CLEARING_LEDGER_STEAL_STALE_MS;
    process.env.CLEARING_LEDGER_LOCK_STALE_MS = '1000';
    process.env.CLEARING_LEDGER_STEAL_STALE_MS = '1000';
    try {
      writeFileSync(lock, `0:${'ab'.repeat(16)}`);
      writeFileSync(`${lock}.steal`, 'crashed-stealer');
      writeFileSync(`${lock}.stale.0.${'cd'.repeat(8)}.deadbeef`, 'leftover-grave');
      const past = new Date(Date.now() - 5_000);
      utimesSync(lock, past, past);
      utimesSync(`${lock}.steal`, past, past);
      const held = acquireLedgerLock(lock);
      expect(readFileSync(lock, 'utf8')).toBe(held.token);
      expect(releaseLedgerLock(lock, held)).toBe('released');
      expect(existsSync(lock)).toBe(false);
    } finally {
      if (previousLock === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previousLock;
      if (previousGuard === undefined) delete process.env.CLEARING_LEDGER_STEAL_STALE_MS;
      else process.env.CLEARING_LEDGER_STEAL_STALE_MS = previousGuard;
    }
  });

  it('withLock throws when the release is lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-lost-'));
    const path = ledgerPath(dir);
    const ledger = new FileLedger(path);
    const lock = `${path}.lock`;
    expect(() => {
      ledger.withLock(() => {
        renameSync(lock, `${lock}.moved`);
        unlinkSync(`${lock}.moved`);
        const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        writeSync(fd, 'other-holder');
        closeSync(fd);
      });
    }).toThrow(/ledger lock lost/);
  });

  it('a stealer paused past the guard ttl does not move the fresh lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clearing-ledger-pause-'));
    const lock = join(dir, 'receipts.jsonl.lock');
    const log = join(dir, 'holders.log');
    const fifo = join(dir, 'hold.fifo');
    execFileSync('mkfifo', [fifo]);
    const previousLock = process.env.CLEARING_LEDGER_LOCK_STALE_MS;
    const previousGuard = process.env.CLEARING_LEDGER_STEAL_STALE_MS;
    process.env.CLEARING_LEDGER_LOCK_STALE_MS = '1000';
    process.env.CLEARING_LEDGER_STEAL_STALE_MS = '400';
    try {
      writeFileSync(lock, `0:${'ab'.repeat(16)}`);
      const past = new Date(Date.now() - 5_000);
      utimesSync(lock, past, past);
      const child = enterLock(lock, log, fifo);
      const started = Date.now();
      while (!existsSync(`${lock}.steal`)) {
        if (Date.now() - started > 5_000) throw new Error('stealer did not take the guard');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const held = acquireLedgerLock(lock);
      expect(readFileSync(lock, 'utf8')).toBe(held.token);
      writeFileSync(fifo, 'go\n');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(readFileSync(lock, 'utf8')).toBe(held.token);
      expect(existsSync(log)).toBe(false);
      expect(releaseLedgerLock(lock, held)).toBe('released');
      await child;
      expect(holderDepth(readFileSync(log, 'utf8'))).toEqual({ max: 1, enters: 1, open: 0 });
    } finally {
      if (previousLock === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previousLock;
      if (previousGuard === undefined) delete process.env.CLEARING_LEDGER_STEAL_STALE_MS;
      else process.env.CLEARING_LEDGER_STEAL_STALE_MS = previousGuard;
    }
  });
});

function holderDepth(log: string): { max: number; enters: number; open: number } {
  let open = 0;
  let max = 0;
  let enters = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('enter ')) {
      open += 1;
      enters += 1;
      if (open > max) max = open;
    } else if (line.startsWith('exit ')) {
      open -= 1;
    }
  }
  return { max, enters, open };
}

function enterLock(lock: string, log: string, holdFifo?: string): Promise<void> {
  const worker = fileURLToPath(new URL('./ledger-lock-worker.ts', import.meta.url));
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const args = [tsx, worker, lock, log];
  if (holdFifo) args.push(holdFifo);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: dirname(worker),
      env: { ...process.env, CLEARING_LEDGER_LOCK_STALE_MS: process.env.CLEARING_LEDGER_LOCK_STALE_MS ?? '1000' },
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`lock worker ${code}: ${err}`));
        return;
      }
      resolve();
    });
  });
}
