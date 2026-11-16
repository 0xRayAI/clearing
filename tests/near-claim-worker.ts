/**
 * One FileLedger process. The parent spawns two of these against one file.
 * Prints a single JSON VerifyResult on stdout.
 */
import { FileLedger } from '../mcp/src/ledger.js';
import { CIRCLE_USDC_NEAR_TESTNET, verifyPayment } from '../mcp/src/near-rail.js';

const [file, nonce, txHash, sender, receiver, amount, nowMsRaw] = process.argv.slice(2);

const ledger = new FileLedger(file);
const result = await verifyPayment({
  ledger,
  txHash,
  senderAccountId: sender,
  nonce,
  nowMs: Number(nowMsRaw),
  readReceipt: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      finalExecutionStatus: 'FINAL',
      executionSucceeded: true,
      senderAccountId: sender,
      tokenContract: CIRCLE_USDC_NEAR_TESTNET,
      receiverId: receiver,
      amount,
      memo: nonce,
    };
  },
});

process.stdout.write(`${JSON.stringify(result)}\n`);
