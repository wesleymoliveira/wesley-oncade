// Things only a person should decide. Each one is logged and leaves a mark
// on the run.
//
//   npm run operator -- simulate-funding <reference> "<reason>"
//       Treats a run as funded without money from Oncade. Test only: it is
//       refused unless simulated funding is switched on, and the run, the
//       ledger and every report show it as simulated.
//   npm run operator -- dead-letters            list the dead-letter queue
//   npm run operator -- dead-letters redrive    put them back on the work queue
//   npm run operator -- dead-letters drop       delete them

import { config } from '../lib/config.ts';
import { simulateFunding } from '../lib/flows/fund.ts';
import { closeDb } from '../lib/infra/db.ts';
import { ack, publish, receiveDeadLetters } from '../lib/infra/queue.ts';

const [command, ...args] = process.argv.slice(2);
const usage = 'usage: npm run operator -- simulate-funding <reference> "<reason>" | dead-letters [redrive|drop]';
const here = `${config.setup.provider}, database ${config.setup.database}, queue ${config.setup.queue}`;

if (command === 'simulate-funding' && args[0] && args[1]) {
  const [reference, reason] = args;
  console.log(`acting on: ${here}`);
  const done = await simulateFunding(reference, reason);
  console.log(
    done ? `${reference}: funded, SIMULATED (${reason})` : `${reference}: not waiting for funds, nothing changed`,
  );
} else if (command === 'dead-letters' && ['list', 'redrive', 'drop'].includes(args[0] ?? 'list')) {
  const action = args[0] ?? 'list';
  console.log(`acting on: ${here}`);
  const messages = await receiveDeadLetters();
  if (messages.length === 0) console.log('the dead-letter queue is empty');
  for (const message of messages) {
    console.log(`${action === 'list' ? 'found' : action}: ${message.body.slice(0, 200)}`);
    if (action === 'redrive') await publish(message.body, message.traceparent);
    if (action === 'redrive' || action === 'drop') await ack(message, 'deadLetter');
  }
} else {
  console.error(usage);
  process.exitCode = 2;
}
await closeDb();
