// Business users, as far as one person can go alone: opening a link session
// for a person, reading it, and the refusals. Nobody approves the link here,
// so the calls that need a linked user are asked about someone unknown.
// The address used is the operator's own.

import { randomUUID } from 'node:crypto';
import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore } from './lib.ts';

const x = explore('business-users');
const { team } = addresses();
const nobody = 'obu_test_does_not_exist';

const session = await x.call(
  'a link session for a person',
  'POST /business/users/link/initiate',
  {},
  { body: { email: team[0] } },
);
const sessionKey = String(session.body?.sessionKey ?? session.body?.session);
const details = await x.call(
  'read the link session',
  'GET /business/users/link/details',
  {},
  { query: `?session=${encodeURIComponent(sessionKey)}` },
);
const users = await x.call('who is linked', 'GET /business/users', {}, { query: '?page=1&limit=5' });
const search = await x.call(
  'search the linked users',
  'GET /business/users',
  {},
  { query: '?search=nobody-by-that-name' },
);
x.answer(
  'happy path',
  `link session ${brief(session)}; details ${brief(details)}; list ${users.status}, ${users.body?.users?.length ?? '?'} linked; search ${search.status}`,
);

const sameEmail = await x.call(
  'the same person again',
  'POST /business/users/link/initiate',
  {},
  { body: { email: team[0] } },
);
const key = randomUUID();
const noEmail = await x.call(
  'a link session with no address',
  'POST /business/users/link/initiate',
  {},
  { body: {}, key },
);
const noEmailAgain = await x.call('the same, same key', 'POST /business/users/link/initiate', {}, { body: {}, key });
x.answer(
  'repeated key',
  `the same address twice: ${sameEmail.status}, ${sameEmail.body?.sessionKey === session.body?.sessionKey && session.body?.sessionKey ? 'the same session' : 'another session'}; ` +
    `no address, the same key twice: ${noEmailAgain.status}, ${noEmailAgain.body?.sessionKey === noEmail.body?.sessionKey && noEmail.body?.sessionKey ? 'the same session' : 'another session'}`,
);

const badEmail = await x.call(
  'an address that is not one',
  'POST /business/users/link/initiate',
  {},
  { body: { email: 'not-an-address' } },
);
const noSession = await x.call('details with no session', 'GET /business/users/link/details');
const badSession = await x.call(
  'details of a session that does not exist',
  'GET /business/users/link/details',
  {},
  { query: '?session=does-not-exist' },
);
x.answer(
  'validation',
  `bad address ${brief(badEmail)}; no session ${brief(noSession)}; unknown session ${brief(badSession)}`,
);

const balance = await x.call('the balance of someone unknown', 'GET /business/users/{userRef}/wallet/balance', {
  userRef: nobody,
});
const assign = await x.call(
  'assign someone unknown to a campaign',
  'POST /business/users/{userRef}/campaigns/{campaignId}/assign',
  { userRef: nobody, campaignId: '0'.repeat(24) },
);
const remove = await x.call('remove someone unknown', 'POST /business/users/{userRef}/link/remove', {
  userRef: nobody,
});
const compliance = await x.call(
  'the compliance call the reference names in passing',
  'GET /business/users/{userRef}/compliance',
  { userRef: nobody },
);
x.answer(
  'wrong state',
  `balance ${brief(balance)}; assign ${brief(assign)}; remove ${brief(remove)}; compliance (named in the text, not listed) ${brief(compliance)}`,
);
await x.finish();
