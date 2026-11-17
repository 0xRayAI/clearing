import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleBlip } from '../mcp/src/blip.js';
import { MemoryFacilitator } from '../mcp/src/facilitator.js';
import { FileLedger, ledgerPath, MemoryLedger } from '../mcp/src/ledger.js';
import {
  CIRCLE_USDC_NEAR_TESTNET,
  encodeNearPayment,
  issueNearQuote,
  NEAR_QUOTE_TTL_MS,
  nearQuotePaymentId,
  nearTxPaymentId,
  transferFromTxStatus,
  verifyPayment,
  type NearTransferView,
} from '../mcp/src/near-rail.js';
import type { Ledger } from '../mcp/src/ledger.js';
import { makeCtx, PAYER_A } from './helpers.js';

const FOUNDRY = 'foundry.testnet';
const SENDER = 'vault.testnet';
const AMOUNT = '50000';
const RELAYER = 'relayer.testnet';

function view(over: Partial<NearTransferView> = {}): NearTransferView {
  return {
    finalExecutionStatus: 'FINAL',
    executionSucceeded: true,
    senderAccountId: SENDER,
    tokenContract: CIRCLE_USDC_NEAR_TESTNET,
    receiverId: FOUNDRY,
    amount: AMOUNT,
    memo: 'pending',
    ...over,
  };
}

function reader(seen: NearTransferView) {
  return async () => seen;
}

function openLedger(): Ledger {
  return new MemoryLedger();
}

function issue(ledger: Ledger, nowMs = 0) {
  return issueNearQuote(ledger, { receiver: FOUNDRY, amount: AMOUNT, nowMs });
}

function check(
  ledger: Ledger,
  nonce: string,
  txHash: string,
  seen: NearTransferView,
  nowMs = 1,
) {
  return verifyPayment({
    ledger,
    txHash,
    senderAccountId: SENDER,
    nonce,
    nowMs,
    readReceipt: reader(seen),
  });
}

describe('NEAR USDC rail', () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = openLedger();
  });

  it('rejects_wrong_receiver', async () => {
    const quote = issue(ledger);
    const result = await check(ledger, quote.nonce, 'tx-wrong-receiver', view({ receiverId: 'other.testnet', memo: quote.nonce }));
    expect(result).toEqual({ ok: false, code: 'wrong_receiver' });
  });

  it('rejects_amount_not_equal_quote', async () => {
    const over = issue(ledger);
    const overpay = await check(ledger, over.nonce, 'tx-over', view({ amount: '50001', memo: over.nonce }));
    expect(overpay).toEqual({ ok: false, code: 'amount_not_equal' });

    const under = issue(ledger);
    const underpay = await check(ledger, under.nonce, 'tx-under', view({ amount: '49999', memo: under.nonce }));
    expect(underpay).toEqual({ ok: false, code: 'amount_not_equal' });
  });

  it('rejects_missing_nonce', async () => {
    const result = await check(ledger, 'never-issued', 'tx-missing', view());
    expect(result).toEqual({ ok: false, code: 'missing_nonce' });
  });

  it('rejects_nonce_past_180s_ttl', async () => {
    const quote = issue(ledger);
    const result = await check(
      ledger,
      quote.nonce,
      'tx-late',
      view({ memo: quote.nonce }),
      NEAR_QUOTE_TTL_MS + 1,
    );
    expect(result).toEqual({ ok: false, code: 'nonce_past_ttl' });
  });

  it('rejects_replayed_nonce', async () => {
    const quote = issue(ledger);
    const first = await check(ledger, quote.nonce, 'tx-nonce-once', view({ memo: quote.nonce }));
    expect(first.ok).toBe(true);
    const second = await check(ledger, quote.nonce, 'tx-nonce-again', view({ memo: quote.nonce }), 2);
    expect(second).toEqual({ ok: false, code: 'replayed_nonce' });
  });

  it('rejects_replayed_tx_hash', async () => {
    const firstQuote = issue(ledger);
    const first = await check(ledger, firstQuote.nonce, 'tx-replay', view({ memo: firstQuote.nonce }));
    expect(first.ok).toBe(true);
    const secondQuote = issue(ledger, 2);
    const second = await check(ledger, secondQuote.nonce, 'tx-replay', view({ memo: secondQuote.nonce }), 3);
    expect(second).toEqual({ ok: false, code: 'replayed_tx' });
  });

  it('rejects_non_final_or_failed_status', async () => {
    const pending = issue(ledger);
    const notFinal = await check(
      ledger,
      pending.nonce,
      'tx-pending',
      view({ finalExecutionStatus: 'EXECUTED', memo: pending.nonce }),
    );
    expect(notFinal).toEqual({ ok: false, code: 'not_final' });

    const failed = issue(ledger);
    const failedTx = await check(
      ledger,
      failed.nonce,
      'tx-failed',
      view({ executionSucceeded: false, memo: failed.nonce }),
    );
    expect(failedTx).toEqual({ ok: false, code: 'not_final' });
  });

  it('args memo and event memo must agree; the Circle tx has deposit in both', () => {
    // Circle testnet USDC tx 53LCBQv92Fp2h19FAnpx1Ng4NacFz1Ncxf3dbnZf47C.
    // memo "deposit" is in the ft_transfer args and the nep141 EVENT_JSON.
    // Verified on 0xRayAI/xray#1148 comment 6913091316.
    const args = Buffer.from(
      JSON.stringify({
        amount: '1000000',
        memo: 'deposit',
        receiver_id: 'shopkeeper.pcreh412610.testnet',
      }),
    ).toString('base64');
    const agreed = transferFromTxStatus(
      {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        transaction: {
          signer_id: 'p1.pcreh412610.testnet',
          receiver_id: CIRCLE_USDC_NEAR_TESTNET,
          actions: [{ FunctionCall: { method_name: 'ft_transfer', args } }],
        },
        receipts_outcome: [
          {
            outcome: {
              executor_id: CIRCLE_USDC_NEAR_TESTNET,
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: 'nep141',
                  version: '1.0.0',
                  event: 'ft_transfer',
                  data: [
                    {
                      old_owner_id: 'p1.pcreh412610.testnet',
                      new_owner_id: 'shopkeeper.pcreh412610.testnet',
                      amount: '1000000',
                      memo: 'deposit',
                    },
                  ],
                })}`,
              ],
            },
          },
        ],
      },
      'p1.pcreh412610.testnet',
    );
    expect(agreed.memo).toBe('deposit');
    expect(agreed.memoConflict).toBe(false);
    expect(agreed.tokenContract).toBe(CIRCLE_USDC_NEAR_TESTNET);

    const clashArgs = Buffer.from(
      JSON.stringify({ amount: AMOUNT, memo: 'args-memo', receiver_id: FOUNDRY }),
    ).toString('base64');
    const clash = transferFromTxStatus(
      {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        transaction: {
          signer_id: SENDER,
          receiver_id: CIRCLE_USDC_NEAR_TESTNET,
          actions: [{ FunctionCall: { method_name: 'ft_transfer', args: clashArgs } }],
        },
        receipts_outcome: [
          {
            outcome: {
              executor_id: CIRCLE_USDC_NEAR_TESTNET,
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: 'nep141',
                  event: 'ft_transfer',
                  data: [{ old_owner_id: SENDER, new_owner_id: FOUNDRY, amount: AMOUNT, memo: 'event-memo' }],
                })}`,
              ],
            },
          },
        ],
      },
      SENDER,
    );
    expect(clash.memoConflict).toBe(true);
  });

  it('a relayed delegate is judged by the USDC receipt, not the outer receiver', () => {
    const args = Buffer.from(
      JSON.stringify({ amount: AMOUNT, memo: 'quote-nonce', receiver_id: FOUNDRY }),
    ).toString('base64');
    const parsed = transferFromTxStatus(
      {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        transaction: { signer_id: RELAYER, receiver_id: SENDER, actions: [{ Delegate: {} }] },
        receipts: [
          {
            receiver_id: CIRCLE_USDC_NEAR_TESTNET,
            receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_transfer', args } }] } },
          },
        ],
        receipts_outcome: [
          {
            outcome: {
              executor_id: CIRCLE_USDC_NEAR_TESTNET,
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: 'nep141',
                  event: 'ft_transfer',
                  data: [{ old_owner_id: SENDER, new_owner_id: FOUNDRY, amount: AMOUNT, memo: 'quote-nonce' }],
                })}`,
              ],
            },
          },
        ],
      },
      SENDER,
    );
    expect(parsed.tokenContract).toBe(CIRCLE_USDC_NEAR_TESTNET);
    expect(parsed.tokenContract).not.toBe(SENDER);
    expect(parsed.senderAccountId).toBe(SENDER);
    expect(parsed.memo).toBe('quote-nonce');
    expect(parsed.executionSucceeded).toBe(true);
  });

  it('two parallel verifies of one nonce or one tx yield one success', async () => {
    const quote = issue(ledger);
    const [first, second] = await Promise.all([
      check(ledger, quote.nonce, 'tx-race-a', view({ memo: quote.nonce })),
      check(ledger, quote.nonce, 'tx-race-b', view({ memo: quote.nonce })),
    ]);
    expect([first, second].filter((row) => row.ok)).toHaveLength(1);

    const left = issue(ledger, 2);
    const right = issue(ledger, 3);
    const [sameA, sameB] = await Promise.all([
      check(ledger, left.nonce, 'tx-same', view({ memo: left.nonce }), 4),
      check(ledger, right.nonce, 'tx-same', view({ memo: right.nonce }), 4),
    ]);
    expect([sameA, sameB].filter((row) => row.ok)).toHaveLength(1);
  });

  it('a stale submitted row with a tx hash is settled from that receipt', async () => {
    const quote = issue(ledger);
    const row = ledger.get(nearQuotePaymentId(quote.nonce));
    expect(row).toBeDefined();
    const crashedAt = new Date(0).toISOString();
    ledger.put({
      ...row!,
      status: 'submitted',
      updatedAt: crashedAt,
      body: { ...(row!.body as object), txHash: 'crashed-tx' },
    });
    ledger.put({
      ...row!,
      paymentId: nearTxPaymentId('crashed-tx'),
      status: 'submitted',
      updatedAt: crashedAt,
      body: { txHash: 'crashed-tx', chain: 'near:testnet' },
    });
    let readHash = '';
    const result = await verifyPayment({
      ledger,
      txHash: 'ignored-by-recovery',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 120_000,
      staleSubmitMs: 1_000,
      readReceipt: async (txHash) => {
        readHash = txHash;
        return view({ memo: quote.nonce });
      },
    });
    expect(readHash).toBe('crashed-tx');
    expect(result).toMatchObject({ ok: true, txHash: 'crashed-tx', amount: AMOUNT });
    expect(ledger.get(nearQuotePaymentId(quote.nonce))?.status).toBe('settled');
    expect(ledger.get(nearTxPaymentId('crashed-tx'))?.status).toBe('settled');
  });

  it('a stale submitted row with no tx hash can be claimed again', async () => {
    const quote = issue(ledger);
    const row = ledger.get(nearQuotePaymentId(quote.nonce));
    ledger.put({ ...row!, status: 'submitted', updatedAt: new Date(0).toISOString() });
    const result = await verifyPayment({
      ledger,
      txHash: 'retry-tx',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 5_000,
      staleSubmitMs: 1_000,
      readReceipt: reader(view({ memo: quote.nonce })),
    });
    expect(result).toMatchObject({ ok: true, txHash: 'retry-tx' });
  });

  it('a fresh submitted row is still replayed_nonce', async () => {
    const quote = issue(ledger);
    const row = ledger.get(nearQuotePaymentId(quote.nonce));
    ledger.put({ ...row!, status: 'submitted', updatedAt: new Date(1).toISOString() });
    const result = await verifyPayment({
      ledger,
      txHash: 'tx-fresh',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 2,
      staleSubmitMs: 60_000,
      readReceipt: reader(view({ memo: quote.nonce })),
    });
    expect(result).toEqual({ ok: false, code: 'replayed_nonce' });
  });

  it('two processes racing one file produce one claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'near-rail-race-'));
    const path = ledgerPath(dir);
    const first = new FileLedger(path);
    const nowMs = Date.now();
    const quote = issueNearQuote(first, { receiver: FOUNDRY, amount: AMOUNT, nowMs });
    const worker = fileURLToPath(new URL('./near-claim-worker.ts', import.meta.url));
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const run = (txHash: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [tsx, worker, path, quote.nonce, txHash, SENDER, FOUNDRY, AMOUNT, String(nowMs)],
          { cwd: dirname(worker) },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`worker ${code}: ${err}`));
            return;
          }
          resolve(out.trim());
        });
      });
    const [left, right] = await Promise.all([run('tx-proc-a'), run('tx-proc-b')]);
    const results = [JSON.parse(left), JSON.parse(right)] as Array<{ ok: boolean }>;
    expect(results.filter((row) => row.ok)).toHaveLength(1);
    const settled = new FileLedger(path);
    expect(settled.get(nearQuotePaymentId(quote.nonce))?.status).toBe('settled');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const quoteLines = lines.filter((line) => line.includes(quote.nonce));
    expect(quoteLines.length).toBeGreaterThan(1);
  });

  it('a second ledger opened on the same file sees the quote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'near-rail-'));
    const path = ledgerPath(dir);
    const first = new FileLedger(path);
    const quote = issueNearQuote(first, { receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const second = new FileLedger(path);
    expect(second.get(nearQuotePaymentId(quote.nonce))?.status).toBe('quoted');
    const body = second.get(nearQuotePaymentId(quote.nonce))?.body as { receiver?: string };
    expect(body.receiver).toBe(FOUNDRY);
  });

  it('3.6 mock done: unpaid GET returns both accepts and a mocked FINAL receipt serves the blip', async () => {
    const ctx = makeCtx({}, { config: { nearPayTo: FOUNDRY } });
    const url = `https://api.clearing.dev/v1/blip?picture=still&brief=night%20alley%20still&owner=${PAYER_A}`;
    const unpaid = await handleBlip(new Request(url), ctx);
    expect(unpaid?.status).toBe(402);
    const quote = (await unpaid!.json()) as {
      accepts: Array<{ network: string; asset?: string; payTo?: string; amount?: string; maxAmountRequired?: string; extra?: { method?: string; memo?: string } }>;
    };
    expect(quote.accepts[0]?.network).toBe('eip155:8453');
    const near = quote.accepts.find((row) => row.network === 'near:testnet');
    expect(near?.asset).toBe(CIRCLE_USDC_NEAR_TESTNET);
    expect(near?.payTo).toBe(FOUNDRY);
    expect(near?.amount).toBe(quote.accepts[0]?.amount);
    expect(Object.keys(quote.accepts[0]!).filter((key) => key === 'amount' || key === 'maxAmountRequired')).toEqual(['amount']);
    expect(Object.keys(near!).filter((key) => key === 'amount' || key === 'maxAmountRequired')).toEqual(['amount']);
    expect(near?.extra?.method).toBe('ft_transfer');
    expect(near?.extra?.memo).toMatch(/^[0-9a-f]{32}$/);
    expect(quote.accepts.some((row) => row.network === 'near')).toBe(false);

    const nonce = near!.extra!.memo!;
    const amount = near!.amount!;
    ctx.nearReceipts = async () => view({ amount, memo: nonce });
    const paid = await handleBlip(
      new Request(url, {
        headers: {
          'X-PAYMENT': encodeNearPayment({
            txHash: 'mock-final-tx',
            senderAccountId: SENDER,
            nonce,
          }),
        },
      }),
      ctx,
    );
    expect(paid?.status).toBe(200);
    const body = (await paid!.json()) as { paid: boolean; videoUrl: string; txHash: string; chain?: string; chainId?: number };
    expect(body.paid).toBe(true);
    expect(body.videoUrl).toMatch(/\.mp4$/);
    expect(body.txHash).toBe('mock-final-tx');
    expect(body.chain).toBe('near:testnet');
    expect(body.chainId).toBeUndefined();
    expect((ctx.facilitator as MemoryFacilitator).debitCount()).toBe(0);
    const row = ctx.settlements.get('mock-final-tx');
    expect(row?.chain).toBe('near:testnet');
    expect(row?.from).toBe(SENDER);
    expect(row?.to).toBe(FOUNDRY);
  });
});
