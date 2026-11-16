/**
 * One process that enters the ledger lock, records enter/exit, and releases.
 * The parent reads the log to see that holders never overlap.
 */
import { appendFileSync } from 'node:fs';
import { acquireLedgerLock, releaseLedgerLock } from '../mcp/src/ledger.js';

const [lockPath, logPath, holdFifo] = process.argv.slice(2);
if (holdFifo) process.env.CLEARING_LEDGER_STEAL_HOLD = holdFifo;
const held = acquireLedgerLock(lockPath);
appendFileSync(logPath, `enter ${process.pid}\n`);
await new Promise((resolve) => setTimeout(resolve, 40));
appendFileSync(logPath, `exit ${process.pid}\n`);
releaseLedgerLock(lockPath, held);
process.stdout.write('ok\n');
