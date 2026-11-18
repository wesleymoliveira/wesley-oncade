// Recurring invoices (invoice templates). A template makes a draft invoice on
// its anchor day, so each one here uses day 28 and is deleted at the end.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore, type Answer } from './lib.ts';

const x = explore('invoice-templates');
const { client } = addresses();
const template = (extra: Record<string, unknown> = {}) => ({
  name: `Exploration ${x.tag}`,
  recurrence: { anchorDay: 28 },
  receiverName: 'API exploration',
  receiverEmail: client,
  payToTarget: 'BUSINESS',
  items: [{ description: 'Retainer', quantity: 1, rate: 2, amount: 2 }],
  ...extra,
});
const created: string[] = [];
const keep = (answer: Answer): Answer => {
  if (answer.status < 300 && typeof answer.body?._id === 'string') created.push(answer.body._id);
  return answer;
};
const create = (asked: string, body: unknown, key?: string) =>
  x.call(asked, 'POST /invoice-templates', {}, { body, key }).then(keep);

try {
  const made = await create('create a template', template());
  const id = String(made.body?._id);
  const read = await x.call('read it', 'GET /invoice-templates/{templateId}', { templateId: id });
  const listed = await x.call('list them', 'GET /invoice-templates', {}, { query: '?page=1&limit=10' });
  const paused = await x.call(
    'pause it',
    'PUT /invoice-templates/{templateId}',
    { templateId: id },
    { body: template({ status: 'paused' }) },
  );
  x.answer(
    'happy path',
    `create ${brief(made)}, next run ${typeof made.body?.nextRunAt === 'string' ? 'set' : 'missing'}; read ${brief(read)}; ` +
      `list ${listed.status}, ${listed.body?.templates?.length ?? '?'} found; pause ${brief(paused)}`,
  );

  const day31 = await create('anchor day 31', template({ recurrence: { anchorDay: 31 } }));
  const noItems = await create('no items', template({ items: [] }));
  const noName = await create('no name', template({ name: '' }));
  const both = await create('two kinds of receiver', template({ recipientBusinessId: x.businessId }));
  x.answer(
    'validation',
    `anchor day 31 ${brief(day31)}; no items ${brief(noItems)}; no name ${brief(noName)}; both receivers ${brief(both)}`,
  );

  const key = randomUUID();
  const first = await create('create with a key', template(), key);
  const second = await create('the same create, same key', template(), key);
  x.answer(
    'repeated key',
    !first.body?._id
      ? `no first to compare (${brief(first)})`
      : first.body._id === second.body?._id
        ? 'the second returned the first template'
        : `the second made a second template (${brief(second)})`,
  );

  const deleted = await x.call('delete it', 'DELETE /invoice-templates/{templateId}', { templateId: id });
  const deleteAgain = await x.call('delete it twice', 'DELETE /invoice-templates/{templateId}', { templateId: id });
  const readDeleted = await x.call('read a deleted one', 'GET /invoice-templates/{templateId}', { templateId: id });
  const updateDeleted = await x.call(
    'update a deleted one',
    'PUT /invoice-templates/{templateId}',
    { templateId: id },
    { body: template() },
  );
  const unknown = await x.call('read an id that does not exist', 'GET /invoice-templates/{templateId}', {
    templateId: '0'.repeat(24),
  });
  x.answer(
    'wrong state',
    `delete ${brief(deleted)}; delete twice ${brief(deleteAgain)}; read deleted ${brief(readDeleted)}; ` +
      `update deleted ${brief(updateDeleted)}; unknown id ${brief(unknown)}`,
  );
} finally {
  for (const id of created) await x.call('clean up', 'DELETE /invoice-templates/{templateId}', { templateId: id });
  const left = await x.call('what is left', 'GET /invoice-templates', {}, { query: '?page=1&limit=50' });
  const mine = (left.body?.templates ?? []).filter(
    (t: any) => String(t.name).includes(x.tag) && t.status !== 'deleted',
  );
  x.answer('left behind', `${mine.length} template(s) of this session still listed`);
}
await x.finish();
