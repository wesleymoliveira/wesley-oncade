// Split templates: a saved list of recipients, and a payout made from one.
// Recipients are the operator's own addresses. Every template is archived
// and every payout cancelled at the end.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore, type Answer } from './lib.ts';

const x = explore('split-templates');
const { team } = addresses();
const split = (extra: Record<string, unknown> = {}) => ({
  name: `Exploration ${x.tag}`,
  mode: 'percentage',
  recipients: [
    { email: team[0]!, name: 'Person 1', percentage: 60 },
    { email: team[1]!, name: 'Person 2', percentage: 40 },
  ],
  ...extra,
});
const templates: string[] = [];
const payouts: string[] = [];
const idOf = (answer: Answer): string => String(answer.body?._id ?? answer.body?.templateId ?? answer.body?.id);
const create = async (asked: string, body: unknown, key?: string) => {
  const answer = await x.call(asked, 'POST /split-templates', {}, { body, key });
  if (answer.status < 300) templates.push(idOf(answer));
  return answer;
};

try {
  const made = await create('create a template', split());
  const id = idOf(made);
  const read = await x.call('read it', 'GET /split-templates/{templateId}', { templateId: id });
  const listed = await x.call('list them', 'GET /split-templates');
  const renamed = await x.call(
    'rename it',
    'PATCH /split-templates/{templateId}',
    { templateId: id },
    { body: { name: `Exploration ${x.tag} renamed` } },
  );
  const payout = await x.call(
    'a payout from the template',
    'POST /distributions',
    {},
    {
      body: {
        templateId: id,
        totalAmountCents: 1000,
        payoutPath: 'dashboard',
        memo: `Exploration ${x.tag} from a template`,
      },
    },
  );
  if (payout.status < 300) payouts.push(String(payout.body?._id));
  x.answer(
    'happy path',
    `create ${brief(made)}; read ${brief(read)}; list ${listed.status}, ${listed.body?.templates?.length ?? '?'} found; rename ${brief(renamed)}; ` +
      `payout from it ${brief(payout)}, lines ${(payout.body?.lineItems ?? []).map((l: any) => l.amountCents).join('+')} cents`,
  );

  const notHundred = await create(
    'percentages that do not add up',
    split({ recipients: [{ email: team[0]!, name: 'Person 1', percentage: 50 }] }),
  );
  const tooMany = await create(
    '21 recipients',
    split({
      recipients: Array.from({ length: 21 }, (_, i) => ({
        email: team[0]!.replace('@', `+limit${i}@`),
        name: `Limit ${i}`,
        percentage: i === 0 ? 80 : 1,
      })),
    }),
  );
  const noName = await create('no name', split({ name: '' }));
  const fixedMode = await create(
    'a fixed-amount template',
    split({ mode: 'fixed', recipients: [{ email: team[0]!, name: 'Person 1', amount: 2 }] }),
  );
  x.answer(
    'validation',
    `percentages≠100 ${brief(notHundred)}; 21 recipients ${brief(tooMany)}; no name ${brief(noName)}; fixed mode ${brief(fixedMode)}`,
  );

  // A template name must be unique, so the repeat is tried under a name of its own.
  const key = randomUUID();
  const keyed = split({ name: `Exploration ${x.tag} keyed` });
  const first = await create('create with a key', keyed, key);
  const second = await create('the same create, same key', keyed, key);
  x.answer(
    'repeated key',
    second.status >= 300
      ? `the second create was refused (${brief(second)}): the unique name stops the duplicate, not the key`
      : idOf(first) === idOf(second)
        ? `the second returned the first template (${second.status})`
        : `the second made a second template (${brief(second)})`,
  );

  const deleted = await x.call('archive it', 'DELETE /split-templates/{templateId}', { templateId: id });
  const deleteAgain = await x.call('archive it twice', 'DELETE /split-templates/{templateId}', { templateId: id });
  const readDeleted = await x.call('read an archived one', 'GET /split-templates/{templateId}', { templateId: id });
  const renameDeleted = await x.call(
    'rename an archived one',
    'PATCH /split-templates/{templateId}',
    { templateId: id },
    { body: { name: 'again' } },
  );
  const payoutDeleted = await x.call(
    'a payout from an archived template',
    'POST /distributions',
    {},
    { body: { templateId: id, totalAmountCents: 1000, payoutPath: 'dashboard' } },
  );
  if (payoutDeleted.status < 300) payouts.push(String(payoutDeleted.body?._id));
  const unknown = await x.call('read an id that does not exist', 'GET /split-templates/{templateId}', {
    templateId: '0'.repeat(24),
  });
  x.answer(
    'wrong state',
    `archive ${brief(deleted)}; archive twice ${brief(deleteAgain)}; read archived ${brief(readDeleted)}; rename archived ${brief(renameDeleted)}; ` +
      `payout from archived ${brief(payoutDeleted)}; unknown id ${brief(unknown)}`,
  );
} finally {
  for (const id of payouts)
    await x.call('clean up', 'POST /distributions/{distributionId}/cancel', { distributionId: id });
  for (const id of templates) await x.call('clean up', 'DELETE /split-templates/{templateId}', { templateId: id });
  const left = await x.call('what is left', 'GET /split-templates');
  x.answer('left behind', `${left.body?.templates?.length ?? '?'} template(s) still listed`);
}
await x.finish();
