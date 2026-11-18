// Payouts: distributions, fund sessions, and the refusals of the calls that
// belong to another payout path. Recipients are the operator's own addresses.
// Nothing here is funded, and everything created is cancelled at the end.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore, type Answer } from './lib.ts';

const x = explore('payouts');
const { team } = addresses();
const people = (amounts: number[]) =>
  amounts.map((amount, i) => ({ email: team[i]!, name: `Person ${i + 1}`, amount }));
const fixed = (path: string | undefined, extra: Record<string, unknown> = {}) => ({
  mode: 'fixed',
  totalAmountCents: 600,
  ...(path ? { payoutPath: path } : {}),
  memo: `Exploration ${x.tag}`,
  recipients: people([1, 2, 3]),
  ...extra,
});
const created: string[] = [];
const keep = (answer: Answer): Answer => {
  if (answer.status < 300 && typeof answer.body?._id === 'string') created.push(answer.body._id);
  return answer;
};
const create = (asked: string, body: unknown, key?: string) =>
  x.call(asked, 'POST /distributions', {}, { body, key }).then(keep);
const fakeHash = `0x${'ab'.repeat(32)}`;

try {
  // 1. The happy path, in both modes, and the list with a filter.
  const fees = await x.call('preview the fees', 'GET /distributions/fee-preview');
  const lookup = await x.call('who has an account', 'POST /lookup-emails', {}, { body: { emails: team } });
  const dashboard = await create('fixed amounts, paid from the dashboard', fixed('dashboard'));
  const percentage = await create('percentages', {
    mode: 'percentage',
    totalAmountCents: 1000,
    payoutPath: 'dashboard',
    memo: `Exploration ${x.tag} percentage`,
    recipients: [
      { email: team[0]!, name: 'Person 1', percentage: 60 },
      { email: team[1]!, name: 'Person 2', percentage: 40 },
    ],
  });
  const pending = await x.call(
    'list the pending ones',
    'GET /distributions',
    {},
    { query: '?page=1&limit=5&status=pending' },
  );
  x.answer(
    'happy path',
    `fee preview ${fees.status}, ${fees.body?.fees?.length ?? '?'} rules; lookup ${lookup.status}; fixed ${brief(dashboard)}; ` +
      `percentage ${brief(percentage)}, lines ${(percentage.body?.lineItems ?? []).map((l: any) => l.amountCents).join('+')} cents; ` +
      `list status=pending ${pending.status}, ${pending.body?.distributions?.length ?? '?'} found`,
  );

  // 2. Validation.
  const notHundred = await create('percentages that do not add up', {
    mode: 'percentage',
    totalAmountCents: 1000,
    payoutPath: 'dashboard',
    recipients: [
      { email: team[0]!, name: 'Person 1', percentage: 60 },
      { email: team[1]!, name: 'Person 2', percentage: 30 },
    ],
  });
  const wrongTotal = await create('amounts that do not add up', fixed('dashboard', { totalAmountCents: 999 }));
  const nobody = await create('no recipients', fixed('dashboard', { recipients: [] }));
  const twice = await create(
    'the same person three times',
    fixed('dashboard', { recipients: people([1, 2, 3]).map((p) => ({ ...p, email: team[0]! })) }),
  );
  const badAddress = await create(
    'an address that is not one',
    fixed('dashboard', { recipients: [{ email: 'not-an-address', name: 'Nobody', amount: 6 }] }),
  );
  const negative = await create(
    'a negative amount',
    fixed('dashboard', { totalAmountCents: 0, recipients: people([-1, 0, 1]) }),
  );
  const badMode = await create('a mode that does not exist', fixed('dashboard', { mode: 'bogus' }));
  const badPath = await create('a payout path that does not exist', fixed('bogus'));
  x.answer(
    'validation',
    `percentages≠100 ${brief(notHundred)}; amounts≠total ${brief(wrongTotal)}; no recipients ${brief(nobody)}; ` +
      `same person three times ${brief(twice)}; bad address ${brief(badAddress)}; negative amount ${brief(negative)}; ` +
      `unknown mode ${brief(badMode)}; unknown payoutPath ${brief(badPath)}`,
  );

  // 3. Fund sessions: the reference says they are "Idempotent by Idempotency-Key".
  const funded = await create('a payout for a fund session', fixed('fund_session'));
  const fundId = String(funded.body?._id);
  const key = randomUUID();
  const session = await x.call(
    'open a fund session',
    'POST /distributions/{distributionId}/fund-sessions',
    { distributionId: fundId },
    { body: {}, key },
  );
  const sessionAgain = await x.call(
    'the same, same key',
    'POST /distributions/{distributionId}/fund-sessions',
    { distributionId: fundId },
    { body: {}, key },
  );
  const handle = String(session.body?.sessionKey);
  const readSession = await x.call(
    'read the session',
    'GET /distributions/{distributionId}/fund-sessions/{sessionHandle}',
    { distributionId: fundId, sessionHandle: handle },
  );
  const revoked = await x.call(
    'revoke the session',
    'DELETE /distributions/{distributionId}/fund-sessions/{sessionHandle}',
    { distributionId: fundId, sessionHandle: handle },
  );
  const readRevoked = await x.call(
    'read the revoked session',
    'GET /distributions/{distributionId}/fund-sessions/{sessionHandle}',
    { distributionId: fundId, sessionHandle: handle },
  );
  const wrongPathSession = await x.call(
    'a fund session on a dashboard payout',
    'POST /distributions/{distributionId}/fund-sessions',
    { distributionId: String(dashboard.body?._id) },
    { body: {} },
  );
  x.answer(
    'fund sessions',
    `open ${brief(session)}; read ${brief(readSession)}; revoke ${brief(revoked)}; read after revoke ${brief(readRevoked)}; ` +
      `on a dashboard payout ${brief(wrongPathSession)}`,
  );

  // 4. The same Idempotency-Key twice.
  const createKey = randomUUID();
  const first = await create('create with a key', fixed('dashboard'), createKey);
  const second = await create('the same create, same key', fixed('dashboard'), createKey);
  x.answer(
    'repeated key',
    `distribution: ${!first.body?._id ? `no first to compare (${brief(first)})` : first.body._id === second.body?._id ? 'the second returned the first' : `the second made a second one (${brief(second)})`}; ` +
      `fund session: ${!session.body?.sessionKey ? `no first to compare (${brief(session)})` : session.body.sessionKey === sessionAgain.body?.sessionKey ? 'the second returned the first session' : `the second made another session (${brief(sessionAgain)})`}`,
  );

  // 5. Calls in the wrong state, or on the wrong payout path.
  const partner = await create('a payout on the partner path', fixed(undefined));
  const partnerId = String(partner.body?._id);
  const unverified = await x.call(
    'record a transfer that never happened',
    'POST /distributions/{distributionId}/direct-transfers/mark-sent',
    { distributionId: partnerId },
    { body: { transactionHash: fakeHash } },
  );
  const badHash = await x.call(
    'record a hash that is not one',
    'POST /distributions/{distributionId}/direct-transfers/mark-sent',
    { distributionId: partnerId },
    { body: { transactionHash: 'nope' } },
  );
  const wrongPathSent = await x.call(
    'record a transfer on a dashboard payout',
    'POST /distributions/{distributionId}/direct-transfers/mark-sent',
    { distributionId: String(dashboard.body?._id) },
    { body: { transactionHash: fakeHash } },
  );
  const giftsFunded = await x.call(
    'mark gifts funded on a dashboard payout',
    'POST /gifts/mark-funded',
    {},
    { body: { distributionId: String(dashboard.body?._id), giftData: [], transactionHash: fakeHash } },
  );
  const cancelled = await x.call('cancel', 'POST /distributions/{distributionId}/cancel', {
    distributionId: String(dashboard.body?._id),
  });
  const cancelAgain = await x.call('cancel twice', 'POST /distributions/{distributionId}/cancel', {
    distributionId: String(dashboard.body?._id),
  });
  const paid = await x.call(
    'find a paid payout',
    'GET /distributions',
    {},
    { query: '?page=1&limit=1&status=completed' },
  );
  const paidId = paid.body?.distributions?.[0]?._id;
  const cancelPaid = paidId
    ? await x.call('cancel a paid payout', 'POST /distributions/{distributionId}/cancel', {
        distributionId: String(paidId),
      })
    : null;
  const unknown = await x.call('cancel an id that does not exist', 'POST /distributions/{distributionId}/cancel', {
    distributionId: '0'.repeat(24),
  });
  x.answer(
    'wrong state',
    `unverified transfer ${brief(unverified)}; malformed hash ${brief(badHash)}; mark-sent on dashboard path ${brief(wrongPathSent)}; ` +
      `gifts/mark-funded on dashboard path ${brief(giftsFunded)}; cancel ${brief(cancelled)}; cancel twice ${brief(cancelAgain)}; ` +
      `cancel a paid payout ${cancelPaid ? brief(cancelPaid) : 'none to try'}; unknown id ${brief(unknown)}`,
  );
} finally {
  for (const id of created)
    await x.call('clean up', 'POST /distributions/{distributionId}/cancel', { distributionId: id });
}
await x.finish();
