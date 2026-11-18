// The part of campaigns and business users that needs a second person: someone
// joins, the owner funds the campaign, an event pays them. Two steps, with
// people in between:
//
//   npm run explore -- campaign-join open     creates the campaign and prints three links
//   (the second person opens two of them and approves; the owner opens the third and funds)
//   npm run explore -- campaign-join close    records an event, reads the balances, cleans up
//   ... close --delete-with-funds             also deletes a campaign that still holds funds, to see what happens
//
// The amounts are 1 on purpose: the docs give three different units for a
// campaign payout, so the balances after one event say which one is right.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore } from './lib.ts';

const STATE = '.local/explore-join.json';
const phase = process.argv[3];
if (phase !== 'open' && phase !== 'close') {
  console.error('usage: npm run explore -- campaign-join open | close [--delete-with-funds]');
  process.exit(1);
}

if (phase === 'open') {
  const x = explore('campaign-join-open');
  const { team } = addresses();
  const campaign = await x.call(
    'create a campaign',
    'POST /campaigns',
    {},
    {
      body: {
        name: `explore-join-${x.tag.toLowerCase()}`,
        publicName: 'API exploration',
        events: [{ code: 'bonus', name: 'Bonus', payoutAmount: 1 }],
      },
    },
  );
  const campaignId = String(campaign.body?.campaignId);
  const join = await x.call(
    'a campaign link for the second person',
    'POST /campaigns/{campaignId}/users/{userRef}/link/initiate',
    { campaignId, userRef: 'new' },
    { body: { email: team[0] } },
  );
  const link = await x.call(
    'a business link for the second person',
    'POST /business/users/link/initiate',
    {},
    { body: { email: team[0] } },
  );
  const fund = await x.call(
    'a fund session for the owner',
    'POST /campaigns/{campaignId}/fund-sessions',
    { campaignId },
    { body: {} },
  );
  writeFileSync(
    STATE,
    JSON.stringify({
      campaignId,
      joinSession: join.body?.sessionKey,
      linkSession: link.body?.sessionKey,
      fundHandle: fund.body?.sessionKey,
    }),
  );
  x.answer(
    'opened',
    `campaign ${brief(campaign)}; campaign link ${brief(join)}; business link ${brief(link)}; fund session ${brief(fund)}`,
  );
  await x.finish();
  console.log('\nFor the second person, signed in with the second account:');
  console.log(`  1. join the business:  ${link.body?.url}`);
  console.log(`  2. join the campaign:  ${join.body?.url}`);
  console.log('For the owner, signed in with the main account:');
  console.log(`  3. fund the campaign:  ${fund.body?.url}`);
} else {
  if (!existsSync(STATE)) {
    console.error('run "open" first');
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as {
    campaignId: string;
    joinSession: string;
    linkSession: string;
    fundHandle: string;
  };
  const { campaignId } = state;
  const x = explore('campaign-join-close');
  const money = (answer: { body: any }) => JSON.stringify(answer.body?.balance ?? answer.body);

  const joined = await x.call(
    'did the second person join the campaign',
    'GET /campaigns/{campaignId}/users/link/details',
    { campaignId },
    { query: `?session=${encodeURIComponent(state.joinSession)}` },
  );
  const linked = await x.call(
    'did the second person join the business',
    'GET /business/users/link/details',
    {},
    { query: `?session=${encodeURIComponent(state.linkSession)}` },
  );
  const funded = await x.call('did the owner fund the campaign', 'GET /campaigns/{campaignId}/fund-sessions/{handle}', {
    campaignId,
    handle: state.fundHandle,
  });
  const campaignUser = joined.body?.userRef ?? joined.body?.user_ref;
  const businessUser = linked.body?.userRef ?? linked.body?.user_ref;
  if (typeof campaignUser !== 'string' || typeof businessUser !== 'string' || funded.body?.status !== 'completed') {
    console.error('\nNot everything is done yet, so nothing was changed and nothing was cleaned up:');
    console.error(`  campaign link  ${joined.body?.status ?? joined.status}`);
    console.error(`  business link  ${linked.body?.status ?? linked.status}`);
    console.error(`  fund session   ${funded.body?.status ?? funded.status}`);
    process.exit(1);
  }
  const members = await x.call('who joined the campaign', 'GET /campaigns/{campaignId}/users', { campaignId });
  const people = await x.call('who is linked to the business', 'GET /business/users');
  const before = await x.call('the campaign before the event', 'GET /campaigns/{campaignId}', { campaignId });
  x.answer(
    'joining and funding',
    `campaign link ${brief(joined)}; business link ${brief(linked)}; fund session ${brief(funded)}; ` +
      `${members.body?.users?.length ?? '?'} in the campaign, ${people.body?.users?.length ?? '?'} linked to the business; campaign balance ${money(before)}`,
  );

  const started = await x.call('start the campaign', 'PUT /campaigns/{campaignId}/start', { campaignId });
  const event = await x.call(
    'record the event for the second person',
    'POST /campaigns/{campaignId}/events',
    { campaignId },
    { body: { eventCode: 'bonus', userRef: campaignUser } },
  );
  const afterEvent = await x.call('the campaign after the event', 'GET /campaigns/{campaignId}', { campaignId });
  const wallet = await x.call(
    'what the second person holds, by campaign',
    'GET /campaigns/{campaignId}/users/{userRef}/wallet/balance',
    { campaignId, userRef: campaignUser },
  );
  const tip = await x.call(
    'a one-time tip of 1',
    'POST /campaigns/{campaignId}/events',
    { campaignId },
    { body: { userRef: campaignUser, payoutAmount: 1 } },
  );
  const afterTip = await x.call('the campaign after the tip', 'GET /campaigns/{campaignId}', { campaignId });
  x.answer(
    'events',
    `start ${brief(started)}; event with payoutAmount 1 ${brief(event)}, campaign balance then ${money(afterEvent)}, the person holds ${money(wallet)}; ` +
      `tip of 1 ${brief(tip)}, campaign balance then ${money(afterTip)}`,
  );

  const businessWallet = await x.call(
    'what the second person holds, by business',
    'GET /business/users/{userRef}/wallet/balance',
    { userRef: businessUser },
  );
  const assigned = await x.call(
    'assign the business user to the campaign',
    'POST /business/users/{userRef}/campaigns/{campaignId}/assign',
    { userRef: businessUser, campaignId },
  );
  const left = await x.call(
    'the second person leaves the campaign',
    'POST /campaigns/{campaignId}/users/{userRef}/link/remove',
    { campaignId, userRef: campaignUser },
  );
  const eventAfterLeaving = await x.call(
    'an event for someone who left',
    'POST /campaigns/{campaignId}/events',
    { campaignId },
    { body: { eventCode: 'bonus', userRef: campaignUser } },
  );
  const unlinked = await x.call(
    'unlink the second person from the business',
    'POST /business/users/{userRef}/link/remove',
    { userRef: businessUser },
  );
  x.answer(
    'leaving',
    `business wallet ${businessWallet.status}; assign ${brief(assigned)}; leave the campaign ${brief(left)}; event after leaving ${brief(eventAfterLeaving)}; unlink from the business ${brief(unlinked)}`,
  );

  const stopped = await x.call('stop the campaign', 'PUT /campaigns/{campaignId}/stop', { campaignId });
  // A campaign that still holds funds is left for the owner: deleting it does not give them back.
  const last = await x.call('what the campaign still holds', 'GET /campaigns/{campaignId}', { campaignId });
  if (Number(last.body?.balance?.available ?? 0) > 0 && process.argv[4] !== '--delete-with-funds') {
    x.answer('clean up', `stop ${brief(stopped)}; the campaign holds ${money(last)} and was left in place`);
    await x.finish();
    process.exit(0);
  }
  const deleted = await x.call('delete the campaign', 'DELETE /campaigns/{campaignId}', { campaignId });
  x.answer('clean up', `stop ${brief(stopped)}; delete ${brief(deleted)}`);
  if (deleted.status < 300) rmSync(STATE, { force: true });
  await x.finish();
}
