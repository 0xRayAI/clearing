import { existsSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      releaseLedgerLock(lock, first);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, 'utf8')).toBe(second.token);
      releaseLedgerLock(lock, second);
      expect(existsSync(lock)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLEARING_LEDGER_LOCK_STALE_MS;
      else process.env.CLEARING_LEDGER_LOCK_STALE_MS = previous;
    }
  });
});
