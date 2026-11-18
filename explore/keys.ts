// API keys. Everything here is done to one throwaway key that this session
// creates. Its value lives in memory only: it is never printed, and never
// saved (explore/lib.ts redacts it). The key in .env is never touched: the
// script stops if a step would name its id.

import { randomUUID } from 'node:crypto';
import { brief, explore } from './lib.ts';

const x = explore('keys');
const platform = { asPlatform: true };

const me = await x.call('who am I', 'GET /me', {}, platform);
if (me.status !== 200 || typeof me.body?.keyInfo?.keyId !== 'string')
  throw new Error('cannot tell which key is in use: stopping');
const mine: string = me.body.keyInfo.keyId;
const notMine = (keyId: string): string => {
  if (keyId === mine || keyId === 'undefined') throw new Error('refusing to touch the key in use');
  return keyId;
};

const listed = await x.call('list the keys', 'GET /me/keys', {}, platform);
const key = randomUUID();
const made = await x.call(
  'create a throwaway key',
  'POST /me/keys',
  {},
  { ...platform, body: { requestedScopes: ['platform:read'], label: `explore ${x.tag}` }, key },
);
const madeAgain = await x.call(
  'the same create, same key',
  'POST /me/keys',
  {},
  { ...platform, body: { requestedScopes: ['platform:read'], label: `explore ${x.tag}` }, key },
);
const throwaway = notMine(String(made.body?.key?.keyId));
const secret: string | undefined = made.body?.rawKey;
const extra =
  madeAgain.status < 300 && madeAgain.body?.key?.keyId !== throwaway
    ? notMine(String(madeAgain.body?.key?.keyId))
    : null;

const read = await x.call('read it', 'GET /me/keys/{keyId}', { keyId: throwaway }, platform);
const works = secret ? await x.call('use it', 'GET /me', {}, { ...platform, withKey: secret }) : null;
const beyond = secret
  ? await x.call('use it beyond its scopes', 'GET /me/keys', {}, { ...platform, withKey: secret })
  : null;
x.answer(
  'happy path',
  `list ${listed.status}, ${listed.body?.keys?.length ?? '?'} key(s); create ${made.status}, raw key returned ${typeof secret === 'string'}; ` +
    `read ${brief(read)}; the new key works ${works ? works.status : 'not tried'}; beyond its scopes ${beyond ? brief(beyond) : 'not tried'}`,
);
x.answer(
  'repeated key',
  extra
    ? `the second create made a second API key (${madeAgain.status})`
    : `the second create answered ${brief(madeAgain)}`,
);

const noScopes = await x.call(
  'a key with no scope',
  'POST /me/keys',
  {},
  { ...platform, body: { requestedScopes: [] } },
);
const bogus = await x.call(
  'a key with a scope that does not exist',
  'POST /me/keys',
  {},
  { ...platform, body: { requestedScopes: ['bogus:scope'] } },
);
for (const answer of [noScopes, bogus]) {
  if (answer.status < 300 && answer.body?.key?.keyId)
    await x.call('clean up', 'DELETE /me/keys/{keyId}', { keyId: notMine(String(answer.body.key.keyId)) }, platform);
}
x.answer('validation', `no scope ${brief(noScopes)}; unknown scope ${brief(bogus)}`);

const rotated = await x.call(
  'rotate the throwaway key',
  'POST /me/keys/{keyId}/rotate',
  { keyId: throwaway },
  { ...platform, body: { gracePeriodDays: 1 } },
);
const successor = rotated.status < 300 ? notMine(String(rotated.body?.newKey?.keyId)) : null;
const newSecret: string | undefined = rotated.body?.rawKey;
const oldStillWorks = secret
  ? await x.call('the old key during the grace period', 'GET /me', {}, { ...platform, withKey: secret })
  : null;
const newWorks = newSecret ? await x.call('the new key', 'GET /me', {}, { ...platform, withKey: newSecret }) : null;
x.answer(
  'rotation',
  `rotate ${rotated.status}; old key during the grace period ${oldStillWorks ? oldStillWorks.status : 'not tried'}; new key ${newWorks ? newWorks.status : 'not tried'}`,
);

const revoked = await x.call('revoke the throwaway key', 'DELETE /me/keys/{keyId}', { keyId: throwaway }, platform);
const revokedAgain = await x.call('revoke it twice', 'DELETE /me/keys/{keyId}', { keyId: throwaway }, platform);
const afterRevoke = secret ? await x.call('use a revoked key', 'GET /me', {}, { ...platform, withKey: secret }) : null;
const unknown = await x.call(
  'read a key that does not exist',
  'GET /me/keys/{keyId}',
  { keyId: 'key_does_not_exist' },
  platform,
);
x.answer(
  'wrong state',
  `revoke ${brief(revoked)}; revoke twice ${brief(revokedAgain)}; a revoked key ${afterRevoke ? brief(afterRevoke) : 'not tried'}; unknown key id ${brief(unknown)}`,
);

for (const keyId of [successor, extra]) {
  if (keyId) await x.call('clean up', 'DELETE /me/keys/{keyId}', { keyId }, platform);
}
const left = await x.call('what is left', 'GET /me/keys', {}, platform);
const active = (left.body?.keys ?? []).filter((k: any) => k.status === 'active').length;
x.answer(
  'left behind',
  `${active} active key(s) at the end; ${listed.body?.keys?.length ?? '?'} key(s) listed at the start`,
);
await x.finish();
