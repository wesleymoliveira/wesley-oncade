// The platform itself: who am I, scope requests, link sessions, invites,
// grants and the business record. One link session and one invite are made
// here, and both are cancelled.
// Not done: revoking the grant (it would break every business call) and
// changing the business record (it is the operator's real business).

import { brief, explore } from './lib.ts';

const x = explore('platform');
const platform = { asPlatform: true };

const me = await x.call('who am I', 'GET /me', {}, platform);
const grants = await x.call('who granted what', 'GET /grants', {}, platform);
const business = await x.call('the business record', 'GET /business');
const readiness = await x.call('is it ready to move money', 'GET /business/readiness');
const wallet = await x.call('its balance', 'GET /business/wallet-balance');
x.answer(
  'happy path',
  `me ${me.status}, platform ${me.body?.status}, key environment ${me.body?.keyInfo?.environment}; grants ${grants.status}; ` +
    `business ${business.status}; readiness ${readiness.status}, ready ${readiness.body?.ready}; wallet balance ${wallet.status}`,
);

const again = await x.call(
  'ask for a scope I already have',
  'POST /me/scopes',
  {},
  { ...platform, body: { scopes: ['invoice:read'] } },
);
const bogus = await x.call(
  'ask for a scope that does not exist',
  'POST /me/scopes',
  {},
  { ...platform, body: { scopes: ['bogus:scope'] } },
);
const none = await x.call('ask for no scope', 'POST /me/scopes', {}, { ...platform, body: { scopes: [] } });
x.answer(
  'scope requests',
  `already approved ${brief(again)}; unknown scope ${brief(bogus)}; empty list ${brief(none)}`,
);

const session = await x.call(
  'open a link session',
  'POST /link-sessions',
  {},
  { ...platform, body: { requestedScopes: ['invoice:read'] } },
);
const sessionId = String(session.body?.sessionId);
const readSession = await x.call('read it', 'GET /link-sessions/{sessionId}', { sessionId }, platform);
const sessions = await x.call('list them', 'GET /link-sessions', {}, platform);
const cancelled = await x.call('cancel it', 'DELETE /link-sessions/{sessionId}', { sessionId }, platform);
const cancelAgain = await x.call('cancel it twice', 'DELETE /link-sessions/{sessionId}', { sessionId }, platform);
const readCancelled = await x.call('read a cancelled one', 'GET /link-sessions/{sessionId}', { sessionId }, platform);
const badScopeSession = await x.call(
  'a link session for a scope that does not exist',
  'POST /link-sessions',
  {},
  { ...platform, body: { requestedScopes: ['bogus:scope'] } },
);
if (badScopeSession.status < 300 && badScopeSession.body?.sessionId) {
  await x.call(
    'clean up',
    'DELETE /link-sessions/{sessionId}',
    { sessionId: String(badScopeSession.body.sessionId) },
    platform,
  );
}
x.answer(
  'link sessions',
  `open ${brief(session)}; read ${brief(readSession)}; list ${sessions.status}, ${sessions.body?.sessions?.length ?? '?'} listed; cancel ${brief(cancelled)}; ` +
    `cancel twice ${brief(cancelAgain)}; read cancelled ${brief(readCancelled)}; unknown scope ${brief(badScopeSession)}`,
);

const own = await x.call(
  'invite my own business',
  'POST /invites',
  {},
  { ...platform, body: { businessId: x.businessId, requestedScopes: ['invoice:read'] } },
);
const badInvite = await x.call(
  'invite with a platform scope',
  'POST /invites',
  {},
  { ...platform, body: { businessId: x.businessId, requestedScopes: ['platform:read'] } },
);
// The only invite the API accepts here is one to a business that does not exist. It is cancelled at once.
const nobody = await x.call(
  'invite a business that does not exist',
  'POST /invites',
  {},
  { ...platform, body: { businessId: '0'.repeat(24), requestedScopes: ['invoice:read'] } },
);
const inviteId = String(nobody.body?._id ?? nobody.body?.inviteId);
const invites = await x.call('list the invites', 'GET /invites', {}, platform);
const inviteCancelled =
  nobody.status < 300
    ? await x.call('cancel the invite', 'POST /invites/{inviteId}/cancel', { inviteId }, platform)
    : null;
const inviteCancelAgain =
  nobody.status < 300
    ? await x.call('cancel it twice', 'POST /invites/{inviteId}/cancel', { inviteId }, platform)
    : null;
x.answer(
  'invites',
  `my own business ${brief(own)}; a platform scope ${brief(badInvite)}; a business that does not exist ${brief(nobody)}; ` +
    `list ${invites.status}, ${invites.body?.invites?.length ?? '?'} listed; cancel ${inviteCancelled ? brief(inviteCancelled) : 'not tried'}; ` +
    `cancel twice ${inviteCancelAgain ? brief(inviteCancelAgain) : 'not tried'}`,
);

const noHeader = await x.call(
  'a business call without the business header',
  'GET /invoices',
  {},
  { ...platform, query: '?limit=1' },
);
const badKey = await x.call(
  'a key that is not valid',
  'GET /me',
  {},
  { ...platform, withKey: `oncade_platform_test_${'0'.repeat(64)}` },
);
x.answer('who is calling', `no X-Target-Business-Id ${brief(noHeader)}; an unknown key ${brief(badKey)}`);

await x.finish();
