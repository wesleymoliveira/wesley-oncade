// Invoices: every call in the reference, and the five questions.
// Every invoice here is addressed to the operator's own address, is never
// e-mailed (sendEmail: false) and is cancelled at the end.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore, type Answer } from './lib.ts';

const x = explore('invoices');
const { client } = addresses();
const today = new Date().toISOString().slice(0, 10);
const invoice = (dollars: number, extra: Record<string, unknown> = {}) => ({
  receiverName: 'API exploration',
  receiverEmail: client,
  date: today,
  payToTarget: 'BUSINESS',
  items: [{ description: 'API exploration', quantity: 1, rate: dollars, amount: dollars }],
  externalMetadata: { explore: x.tag },
  ...extra,
});
const created: string[] = [];
const keep = (answer: Answer): Answer => {
  if (answer.status < 300 && typeof answer.body?._id === 'string') created.push(answer.body._id);
  return answer;
};

try {
  // 1. The happy path: draft, update, send without e-mail, read, list, export.
  const draft = keep(await x.call('create a draft', 'POST /invoices', {}, { body: invoice(2) }));
  const id = String(draft.body?._id);
  const updated = await x.call(
    'replace the draft',
    'PUT /invoices/{invoiceId}',
    { invoiceId: id },
    { body: invoice(3) },
  );
  const sent = await x.call(
    'send it, no e-mail',
    'POST /invoices/{invoiceId}/send',
    { invoiceId: id },
    { body: { sendEmail: false } },
  );
  const read = await x.call('read it', 'GET /invoices/{invoiceId}', { invoiceId: id });
  const listed = await x.call('list the sent ones', 'GET /invoices', {}, { query: '?page=1&limit=5&status=sent' });
  const exported = await x.call('export it as CSV', 'GET /invoices/export', {}, { query: `?invoiceIds=${id}` });
  x.answer(
    'happy path',
    `create ${brief(draft)}; update ${brief(updated)}, total ${updated.body?.total}; send ${brief(sent)}, emailSuppressed ${sent.body?.emailSuppressed}; ` +
      `read ${brief(read)}; list ${listed.status}, ${listed.body?.invoices?.length ?? '?'} sent; ` +
      `export ${exported.status}, ${typeof exported.body === 'string' ? `${exported.body.split('\n').length - 1} data lines` : 'not text'}`,
  );

  // 2. Validation.
  const noItems = await x.call('no items', 'POST /invoices', {}, { body: { ...invoice(1), items: [] } });
  const bothReceivers = await x.call(
    'two kinds of receiver',
    'POST /invoices',
    {},
    {
      body: invoice(1, { recipientBusinessId: x.businessId }),
    },
  );
  const wrongTotal = await x.call(
    'a total that does not add up',
    'POST /invoices',
    {},
    { body: invoice(1, { total: 5 }) },
  );
  const dueBefore = await x.call(
    'due before its date',
    'POST /invoices',
    {},
    { body: invoice(1, { dueDate: '2020-01-01' }) },
  );
  const negative = await x.call('a negative amount', 'POST /invoices', {}, { body: invoice(-1) });
  const badStatus = await x.call(
    'export with a status that does not exist',
    'GET /invoices/export',
    {},
    { query: '?status=bogus' },
  );
  const plainKey = await x.call(
    'a key that is not a UUID',
    'POST /invoices',
    {},
    { body: invoice(1), key: `explore-${x.tag}` },
  );
  for (const answer of [noItems, bothReceivers, wrongTotal, dueBefore, negative, plainKey]) keep(answer);
  x.answer(
    'validation',
    `no items ${brief(noItems)}; both receivers ${brief(bothReceivers)}; wrong total ${brief(wrongTotal)}; ` +
      `due before date ${brief(dueBefore)}; negative amount ${brief(negative)}; export status=bogus ${brief(badStatus)}; ` +
      `a key that is not a UUID ${brief(plainKey)}`,
  );

  // 3. The same Idempotency-Key twice, on a create and on an update.
  const key = randomUUID();
  const first = keep(await x.call('create with a key', 'POST /invoices', {}, { body: invoice(1), key }));
  const second = keep(await x.call('the same create, same key', 'POST /invoices', {}, { body: invoice(1), key }));
  x.answer(
    'repeated key',
    first.body?._id && second.body?._id
      ? first.body._id === second.body._id
        ? 'the second create returned the first invoice'
        : `the second create made a second invoice (${brief(second)})`
      : `could not compare: ${brief(first)}, ${brief(second)}`,
  );

  // 4. Calls in the wrong state.
  const sendAgain = await x.call(
    'send what is already sent',
    'POST /invoices/{invoiceId}/send',
    { invoiceId: id },
    { body: { sendEmail: false } },
  );
  const cancelled = await x.call('cancel it', 'POST /invoices/{invoiceId}/cancel', { invoiceId: id });
  const updateCancelled = await x.call(
    'update a cancelled one',
    'PUT /invoices/{invoiceId}',
    { invoiceId: id },
    { body: invoice(4) },
  );
  const sendCancelled = await x.call(
    'send a cancelled one',
    'POST /invoices/{invoiceId}/send',
    { invoiceId: id },
    { body: { sendEmail: false } },
  );
  const unknown = await x.call('read an id that does not exist', 'GET /invoices/{invoiceId}', {
    invoiceId: '0'.repeat(24),
  });
  const notAnId = await x.call('read something that is not an id', 'GET /invoices/{invoiceId}', {
    invoiceId: 'not-an-id',
  });
  x.answer(
    'wrong state',
    `send twice ${brief(sendAgain)}; cancel ${brief(cancelled)}; update cancelled ${brief(updateCancelled)}; ` +
      `send cancelled ${brief(sendCancelled)}; unknown id ${brief(unknown)}; malformed id ${brief(notAnId)}`,
  );
} finally {
  for (const id of created) await x.call('clean up', 'POST /invoices/{invoiceId}/cancel', { invoiceId: id });
}
await x.finish();
