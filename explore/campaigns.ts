// Campaigns, as far as one person can go alone: the campaign itself, link
// sessions and link invites, fund sessions, start and stop, and the refusals.
// Nobody joins and nothing is funded here: that part is explore/campaign-join.ts.
// Every campaign is stopped and deleted at the end.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore, type Answer } from './lib.ts';

const x = explore('campaigns');
const { team } = addresses();
const campaign = (extra: Record<string, unknown> = {}) => ({
  name: `explore-${x.tag.toLowerCase()}`,
  publicName: 'API exploration',
  events: [{ code: 'bonus', name: 'Bonus', payoutAmount: 100 }],
  ...extra,
});
const created: string[] = [];
const idOf = (answer: Answer): string =>
  String(answer.body?.campaignId ?? answer.body?._id ?? answer.body?.id ?? answer.body?.campaign?._id);
const create = async (asked: string, body: unknown, key?: string) => {
  const answer = await x.call(asked, 'POST /campaigns', {}, { body, key });
  if (answer.status < 300) created.push(idOf(answer));
  return answer;
};

try {
  // 1. The campaign itself.
  const made = await create('create a campaign', campaign());
  const campaignId = idOf(made);
  const read = await x.call('read it', 'GET /campaigns/{campaignId}', { campaignId });
  const listed = await x.call('list them', 'GET /campaigns');
  const renamed = await x.call(
    'change its public name',
    'PATCH /campaigns/{campaignId}',
    { campaignId },
    { body: { publicName: 'API exploration, renamed' } },
  );
  const wallet = await x.call('the wallet that pays it', 'GET /campaigns/{campaignId}/payout-wallet/balance', {
    campaignId,
  });
  x.answer(
    'happy path',
    `create ${brief(made)} with payoutAmount 100; read ${brief(read)}, the event comes back as ${JSON.stringify(read.body?.events?.[0]?.payoutAmount)}; ` +
      `list ${listed.status}, ${listed.body?.campaigns?.length ?? '?'} found; ` +
      `rename ${brief(renamed)}; payout wallet balance ${wallet.status}`,
  );

  // 2. Joining: a link session for one person, and a shareable invite.
  const session = await x.call(
    'a link session for someone new',
    'POST /campaigns/{campaignId}/users/{userRef}/link/initiate',
    { campaignId, userRef: 'new' },
    { body: { email: team[0] } },
  );
  const sessionKey = String(
    session.body?.sessionKey ?? session.body?.session ?? session.body?.handle ?? session.body?.token,
  );
  const details = await x.call(
    'read the link session',
    'GET /campaigns/{campaignId}/users/link/details',
    { campaignId },
    { query: `?session=${encodeURIComponent(sessionKey)}` },
  );
  const guidePath = await x.call(
    'the path the guide shows for it',
    'POST /campaigns/{campaignId}/link/users/initiate',
    { campaignId },
    { body: { email: team[0] } },
  );
  const invite = await x.call(
    'a shareable invite',
    'POST /campaigns/{campaignId}/link-invites',
    { campaignId },
    { body: { label: 'Exploration', maxUses: 1 } },
  );
  const code = String(invite.body?.code ?? invite.body?.invite?.code);
  const invites = await x.call('list the invites', 'GET /campaigns/{campaignId}/link-invites', { campaignId });
  const paused = await x.call(
    'pause the invite',
    'PATCH /campaigns/{campaignId}/link-invites/{code}',
    { campaignId, code },
    { body: { status: 'paused' } },
  );
  const revoked = await x.call('revoke the invite', 'DELETE /campaigns/{campaignId}/link-invites/{code}', {
    campaignId,
    code,
  });
  const revokedAgain = await x.call('revoke it twice', 'DELETE /campaigns/{campaignId}/link-invites/{code}', {
    campaignId,
    code,
  });
  const users = await x.call('who joined', 'GET /campaigns/{campaignId}/users', { campaignId });
  x.answer(
    'joining',
    `link session ${brief(session)}; details ${brief(details)}; the guide's path ${brief(guidePath)}; invite ${brief(invite)}; ` +
      `list invites ${invites.status}; pause ${brief(paused)}; revoke ${brief(revoked)}; revoke twice ${brief(revokedAgain)}; users ${users.status}, ${users.body?.users?.length ?? '?'} joined`,
  );

  // 3. Fund sessions: the guide says the same key returns the pending session (200).
  const fundKey = randomUUID();
  const fund = await x.call(
    'open a fund session',
    'POST /campaigns/{campaignId}/fund-sessions',
    { campaignId },
    { body: {}, key: fundKey },
  );
  const fundAgain = await x.call(
    'the same, same key',
    'POST /campaigns/{campaignId}/fund-sessions',
    { campaignId },
    { body: {}, key: fundKey },
  );
  const handle = String(fund.body?.sessionKey ?? fund.body?.handle);
  const readFund = await x.call('read the fund session', 'GET /campaigns/{campaignId}/fund-sessions/{handle}', {
    campaignId,
    handle,
  });
  const cancelFund = await x.call(
    'cancel it, as the guide says',
    'DELETE /campaigns/{campaignId}/fund-sessions/{handle}',
    { campaignId, handle },
  );
  x.answer(
    'fund sessions',
    `open ${brief(fund)}; same key ${fundAgain.status}, ${fundAgain.body?.sessionKey === fund.body?.sessionKey && fund.body?.sessionKey ? 'the same session' : 'another session'}; ` +
      `read ${brief(readFund)}; cancel (in the guide, not in the reference) ${brief(cancelFund)}`,
  );

  // 4. Start, events and stop, with nobody joined and nothing funded.
  const started = await x.call('start it', 'PUT /campaigns/{campaignId}/start', { campaignId });
  const startedAgain = await x.call('start it again', 'PUT /campaigns/{campaignId}/start', { campaignId });
  const afterStart = await x.call('read it after the start', 'GET /campaigns/{campaignId}', { campaignId });
  const eventNobody = await x.call(
    'an event for someone who never joined',
    'POST /campaigns/{campaignId}/events',
    { campaignId },
    { body: { eventCode: 'bonus', userRef: 'pvu_does_not_exist' } },
  );
  const eventUnknown = await x.call(
    'an event that is not configured',
    'POST /campaigns/{campaignId}/events',
    { campaignId },
    { body: { eventCode: 'nope', userRef: 'pvu_does_not_exist' } },
  );
  const balanceNobody = await x.call(
    'the balance of someone who never joined',
    'GET /campaigns/{campaignId}/users/{userRef}/wallet/balance',
    { campaignId, userRef: 'pvu_does_not_exist' },
  );
  const removeNobody = await x.call(
    'remove someone who never joined',
    'POST /campaigns/{campaignId}/users/{userRef}/link/remove',
    { campaignId, userRef: 'pvu_does_not_exist' },
  );
  const stopped = await x.call('stop it', 'PUT /campaigns/{campaignId}/stop', { campaignId });
  const stoppedAgain = await x.call('stop it again', 'PUT /campaigns/{campaignId}/stop', { campaignId });
  const afterStop = await x.call('read it after the stop', 'GET /campaigns/{campaignId}', { campaignId });
  const unknown = await x.call('read a campaign that does not exist', 'GET /campaigns/{campaignId}', {
    campaignId: '0'.repeat(24),
  });
  const deleted = await x.call('delete it', 'DELETE /campaigns/{campaignId}', { campaignId });
  const deletedAgain = await x.call('delete it twice', 'DELETE /campaigns/{campaignId}', { campaignId });
  x.answer(
    'start and stop',
    `created as "${made.body?.status}"; start ${brief(started)}; start again ${brief(startedAgain)}; status after ${afterStart.body?.status}; ` +
      `stop ${brief(stopped)}; stop again ${brief(stoppedAgain)}; status after ${afterStop.body?.status}`,
  );
  x.answer(
    'wrong state',
    `event for nobody ${brief(eventNobody)}; unknown event ${brief(eventUnknown)}; balance of nobody ${brief(balanceNobody)}; ` +
      `remove nobody ${brief(removeNobody)}; unknown campaign ${brief(unknown)}; delete ${brief(deleted)}; delete twice ${brief(deletedAgain)}`,
  );

  // 5. Validation, and the repeated key.
  const noName = await create('no name', campaign({ name: '' }));
  const guideExample = await create('the example of the guide: amounts as strings', {
    name: `explore-${x.tag.toLowerCase()}-guide`,
    publicName: 'Q1 Reward Program',
    events: [
      { code: 'signup_bonus', name: 'Signup Bonus', payoutAmount: '5000000' },
      { code: 'referral', name: 'Referral Reward', payoutAmount: '10000000' },
    ],
  });
  const badAmount = await create(
    'a payout amount that is not a number',
    campaign({
      name: `explore-${x.tag.toLowerCase()}-b`,
      events: [{ code: 'bonus', name: 'Bonus', payoutAmount: 'lots' }],
    }),
  );
  const plainHttp = await create(
    'a webhook URL without https',
    campaign({ name: `explore-${x.tag.toLowerCase()}-c`, webhookUrl: 'http://example.com/hook' }),
  );
  x.answer(
    'validation',
    `no name ${brief(noName)}; the guide's example, amounts as strings ${brief(guideExample)}; bad amount ${brief(badAmount)}; http webhook URL ${brief(plainHttp)}`,
  );

  const key = randomUUID();
  const keyed = campaign({ name: `explore-${x.tag.toLowerCase()}-keyed` });
  const first = await create('create with a key', keyed, key);
  const second = await create('the same create, same key', keyed, key);
  x.answer(
    'repeated key',
    second.status >= 300
      ? `the second create was refused (${brief(second)})`
      : idOf(first) === idOf(second)
        ? `the second returned the first campaign (${second.status})`
        : `the second made a second campaign (${brief(second)})`,
  );
} finally {
  for (const campaignId of created) {
    await x.call('clean up: stop', 'PUT /campaigns/{campaignId}/stop', { campaignId });
    await x.call('clean up: delete', 'DELETE /campaigns/{campaignId}', { campaignId });
  }
  const left = await x.call('what is left', 'GET /campaigns');
  x.answer('left behind', `${left.body?.campaigns?.length ?? '?'} campaign(s) still listed`);
}
await x.finish();
