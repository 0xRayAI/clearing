import { describe, expect, it, beforeEach } from 'vitest';
import { handleBlip } from '../mcp/src/blip.js';
import { MemoryFacilitator } from '../mcp/src/facilitator.js';
import {
  CIRCLE_USDC_NEAR_TESTNET,
  encodeNearPayment,
  issueNearQuote,
  NEAR_QUOTE_TTL_MS,
  resetNearRailForTests,
  transferFromTxStatus,
  verifyPayment,
  type NearTransferView,
} from '../mcp/src/near-rail.js';
import { makeCtx, PAYER_A } from './helpers.js';

const FOUNDRY = 'foundry.testnet';
const SENDER = 'vault.testnet';
const AMOUNT = '50000';

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

describe('NEAR USDC rail', () => {
  beforeEach(() => resetNearRailForTests());

  it('rejects_wrong_receiver', async () => {
    const quote = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const result = await verifyPayment({
      txHash: 'tx-wrong-receiver',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 1,
      readReceipt: reader(view({ receiverId: 'other.testnet', memo: quote.nonce })),
    });
    expect(result).toEqual({ ok: false, code: 'wrong_receiver' });
  });

  it('rejects_amount_not_equal_quote', async () => {
    const over = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const overpay = await verifyPayment({
      txHash: 'tx-over',
      senderAccountId: SENDER,
      nonce: over.nonce,
      nowMs: 1,
      readReceipt: reader(view({ amount: '50001', memo: over.nonce })),
    });
    expect(overpay).toEqual({ ok: false, code: 'amount_not_equal' });

    const under = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const underpay = await verifyPayment({
      txHash: 'tx-under',
      senderAccountId: SENDER,
      nonce: under.nonce,
      nowMs: 1,
      readReceipt: reader(view({ amount: '49999', memo: under.nonce })),
    });
    expect(underpay).toEqual({ ok: false, code: 'amount_not_equal' });
  });

  it('rejects_missing_nonce', async () => {
    const result = await verifyPayment({
      txHash: 'tx-missing',
      senderAccountId: SENDER,
      nonce: 'never-issued',
      nowMs: 1,
      readReceipt: reader(view()),
    });
    expect(result).toEqual({ ok: false, code: 'missing_nonce' });
  });

  it('rejects_nonce_past_180s_ttl', async () => {
    const quote = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const result = await verifyPayment({
      txHash: 'tx-late',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: NEAR_QUOTE_TTL_MS + 1,
      readReceipt: reader(view({ memo: quote.nonce })),
    });
    expect(result).toEqual({ ok: false, code: 'nonce_past_ttl' });
  });

  it('rejects_replayed_nonce', async () => {
    const quote = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const tx = 'tx-nonce-once';
    const first = await verifyPayment({
      txHash: tx,
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 1,
      readReceipt: reader(view({ memo: quote.nonce })),
    });
    expect(first.ok).toBe(true);
    const second = await verifyPayment({
      txHash: 'tx-nonce-again',
      senderAccountId: SENDER,
      nonce: quote.nonce,
      nowMs: 2,
      readReceipt: reader(view({ memo: quote.nonce })),
    });
    expect(second).toEqual({ ok: false, code: 'replayed_nonce' });
  });

  it('rejects_replayed_tx_hash', async () => {
    const firstQuote = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const tx = 'tx-replay';
    const first = await verifyPayment({
      txHash: tx,
      senderAccountId: SENDER,
      nonce: firstQuote.nonce,
      nowMs: 1,
      readReceipt: reader(view({ memo: firstQuote.nonce })),
    });
    expect(first.ok).toBe(true);
    const secondQuote = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 2 });
    const second = await verifyPayment({
      txHash: tx,
      senderAccountId: SENDER,
      nonce: secondQuote.nonce,
      nowMs: 3,
      readReceipt: reader(view({ memo: secondQuote.nonce })),
    });
    expect(second).toEqual({ ok: false, code: 'replayed_tx' });
  });

  it('rejects_non_final_or_failed_status', async () => {
    const pending = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const notFinal = await verifyPayment({
      txHash: 'tx-pending',
      senderAccountId: SENDER,
      nonce: pending.nonce,
      nowMs: 1,
      readReceipt: reader(view({ finalExecutionStatus: 'EXECUTED', memo: pending.nonce })),
    });
    expect(notFinal).toEqual({ ok: false, code: 'not_final' });

    const failed = issueNearQuote({ receiver: FOUNDRY, amount: AMOUNT, nowMs: 0 });
    const failedTx = await verifyPayment({
      txHash: 'tx-failed',
      senderAccountId: SENDER,
      nonce: failed.nonce,
      nowMs: 1,
      readReceipt: reader(view({ executionSucceeded: false, memo: failed.nonce })),
    });
    expect(failedTx).toEqual({ ok: false, code: 'not_final' });
  });

  it('reads memo from the nep141 event log, not from a caller quote', () => {
    const parsed = transferFromTxStatus(
      {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        transaction: { signer_id: SENDER, receiver_id: CIRCLE_USDC_NEAR_TESTNET },
        receipts_outcome: [
          {
            outcome: {
              executor_id: CIRCLE_USDC_NEAR_TESTNET,
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: 'nep141',
                  version: '1.0.0',
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
    expect(parsed.memo).toBe('quote-nonce');
    expect(parsed.amount).toBe(AMOUNT);
    expect(parsed.receiverId).toBe(FOUNDRY);
    expect(parsed.executionSucceeded).toBe(true);
  });

  it('3.6 mock done: unpaid GET returns both accepts and a mocked FINAL receipt serves the blip', async () => {
    const ctx = makeCtx({}, { config: { nearPayTo: FOUNDRY } });
    const url = `https://api.clearing.dev/v1/blip?picture=still&brief=night%20alley%20still&owner=${PAYER_A}`;
    const unpaid = await handleBlip(new Request(url), ctx);
    expect(unpaid?.status).toBe(402);
    const quote = (await unpaid!.json()) as {
      accepts: Array<{ network: string; asset?: string; payTo?: string; maxAmountRequired?: string; extra?: { method?: string; memo?: string } }>;
    };
    expect(quote.accepts[0]?.network).toBe('eip155:8453');
    const near = quote.accepts.find((row) => row.network === 'near:testnet');
    expect(near?.asset).toBe(CIRCLE_USDC_NEAR_TESTNET);
    expect(near?.payTo).toBe(FOUNDRY);
    expect(near?.maxAmountRequired).toBe(quote.accepts[0]?.maxAmountRequired);
    expect(near?.extra?.method).toBe('ft_transfer');
    expect(near?.extra?.memo).toMatch(/^[0-9a-f]{32}$/);
    expect(quote.accepts.some((row) => row.network === 'near')).toBe(false);

    const nonce = near!.extra!.memo!;
    const amount = near!.maxAmountRequired!;
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
    const body = (await paid!.json()) as { paid: boolean; videoUrl: string; txHash: string };
    expect(body.paid).toBe(true);
    expect(body.videoUrl).toMatch(/\.mp4$/);
    expect(body.txHash).toBe('mock-final-tx');
    expect((ctx.facilitator as MemoryFacilitator).debitCount()).toBe(0);
  });
});
