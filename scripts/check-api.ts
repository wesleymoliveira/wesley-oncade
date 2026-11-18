// Getting ready to talk to the real Oncade test API: the key, the scopes, the grant.
// The questions about each family of the API are in explore/.
//
//   npm run check-api -- probe        read-only: key, host, scopes, grants, readiness
//   npm run check-api -- link         write: opens a link session for the missing scopes
//   npm run check-api -- link all     the same, plus every other business scope in the reference
//   npm run check-api -- link-status  read-only: was it approved?
//   npm run check-api -- open-objects read-only: invoices and distributions at the provider, by status
//
// Every reply is saved untouched under .local/raw/ (never committed) and
// printed as a shape: structure and enumerated values, no ids, e-mails,
// wallets or keys.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertTestKey, send, type OncadeReply, type OncadeTarget } from '../lib/oncade/http.ts';
import { shape } from './lib/shape.ts';

const RAW_DIR = join(import.meta.dirname, '..', '.local', 'raw');
const STATE_FILE = join(RAW_DIR, '..', 'oncade.json');
// The documented host first, then the portal where the key was created.
const HOSTS = ['https://www.oncade.gg', 'https://dev.oncade.xyz'];

let step = 0;

function record(name: string, reply: OncadeReply): void {
  mkdirSync(RAW_DIR, { recursive: true });
  step += 1;
  const file = `${String(step).padStart(2, '0')}-${name}.json`;
  writeFileSync(join(RAW_DIR, file), JSON.stringify(reply, null, 2));
}

function show(label: string, reply: OncadeReply): void {
  const kind = reply.contentType.split(';')[0] || 'no content-type';
  console.log(`\n${label.replace(/[0-9a-f]{24}/g, '<id>')}\n  → ${reply.status} ${kind} in ${reply.ms} ms`);
  if (reply.location && reply.status >= 300 && reply.status < 400) {
    console.log(`  → redirect to ${new URL(reply.location, 'https://x').host}`);
  }
  if (typeof reply.body === 'string') {
    console.log(`  → body is not JSON (${reply.body.length} chars)`);
  } else {
    console.log(JSON.stringify(shape(reply.body), null, 1).replace(/^/gm, '  '));
  }
}

async function ask(target: OncadeTarget, name: string, path: string): Promise<OncadeReply> {
  const reply = await send(target, { method: 'GET', path });
  record(name, reply);
  show(`GET ${path}`, reply);
  return reply;
}

function firstId(body: unknown, listKeys: string[], idKeys: string[]): string | undefined {
  const root = body as Record<string, unknown> | unknown[] | null;
  const lists = Array.isArray(root)
    ? [root]
    : listKeys.map((k) => (root as Record<string, unknown> | null)?.[k]).filter(Array.isArray);
  for (const list of lists) {
    for (const item of list as Record<string, unknown>[]) {
      for (const idKey of idKeys) {
        const direct = item?.[idKey];
        if (typeof direct === 'string') return direct;
        const nested =
          (direct as Record<string, unknown> | undefined)?.id ?? (direct as Record<string, unknown> | undefined)?._id;
        if (typeof nested === 'string') return nested;
      }
    }
  }
  return undefined;
}

async function probe(): Promise<void> {
  const apiKey = process.env.API_KEY;
  assertTestKey(apiKey);
  console.log('API_KEY: present, shaped like a test key');

  let target: OncadeTarget | undefined;
  for (const baseUrl of HOSTS) {
    const candidate = { baseUrl, apiKey };
    console.log(`\n=== host ${new URL(baseUrl).host}`);
    const me = await ask(candidate, 'me', '/platform/me');
    if (me.status === 200 && typeof me.body === 'object') {
      target = candidate;
      break;
    }
    if (typeof me.body === 'string' && me.contentType.includes('html')) {
      console.log('  → an HTML page, not the API. Stopping here: not forcing a bot check.');
      return;
    }
  }
  if (!target) {
    console.log('\nNo host accepted the key. Nothing else was called.');
    return;
  }

  await ask(target, 'keys', '/platform/me/keys');
  const grants = await ask(target, 'grants', '/platform/grants');
  const businessId = firstId(grants.body, ['grants', 'data', 'items'], ['businessId', 'business']);
  if (!businessId) {
    console.log('\nNo business id found in the grants reply: the platform has no business linked yet.');
    return;
  }
  const scoped = { ...target, businessId };
  writeFileSync(STATE_FILE, JSON.stringify({ baseUrl: target.baseUrl, businessId }, null, 2));
  console.log('\nbusiness id found and saved to .local/oncade.json');

  await ask(scoped, 'business', '/platform/business');
  await ask(scoped, 'readiness', '/platform/business/readiness');
  await ask(scoped, 'wallet-balance', '/platform/business/wallet-balance');
  await ask(scoped, 'fee-preview', '/platform/distributions/fee-preview');
  await ask(scoped, 'invoices', '/platform/invoices?page=1&limit=5');
  await ask(scoped, 'distributions', '/platform/distributions?page=1&limit=5');
}

// The scopes this project needs from the business, plus the ones the grant
// already has, so the result is the same whether approval merges or replaces.
const WANTED_SCOPES = [
  'business:read',
  'business:wallet:balance',
  'invoice:create',
  'invoice:read',
  'invoice:update',
  'invoice:send',
  'invoice:cancel',
  'distribution:create',
  'distribution:read',
  'distribution:cancel',
  'distribution:funds:create',
  'distribution:funds:read',
  'gift:read',
  'lookup:emails',
];

// The rest of what the reference lists for a business, asked for only with
// `link all`: what the API exploration in explore/ needs beyond the payout run.
const EXPLORE_SCOPES = [
  'business:create',
  'business:update',
  'business:users:link:create',
  'business:users:link:read',
  'business:users:link:remove',
  'gift:create',
  'splitTemplate:create',
  'splitTemplate:read',
  'splitTemplate:update',
  'splitTemplate:delete',
  'campaign:create',
  'campaign:read',
  'campaign:update',
  'campaign:delete',
  'campaign:start',
  'campaign:stop',
  'campaign:payout-wallet:balance',
  'campaign:users:link:read',
  'campaign:users:link:create',
  'campaign:users:link:remove',
  'campaign:users:link:static',
  'campaign:users:wallet:read',
  'campaign:events:create',
  'campaign:funds:create',
  'campaign:funds:read',
];

function savedTarget(): OncadeTarget & { state: Record<string, string> } {
  const apiKey = process.env.API_KEY;
  assertTestKey(apiKey);
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, string>;
  if (!state.baseUrl || !state.businessId) throw new Error('run "probe" first: no host or business saved yet');
  return { baseUrl: state.baseUrl, apiKey, businessId: state.businessId, state };
}

/** Write: opens a link session so the business owner can grant the scopes. */
async function link(): Promise<void> {
  const { state, ...target } = savedTarget();
  const grants = await send(target, { method: 'GET', path: '/platform/grants' });
  const current = ((grants.body as { grants?: { grantedScopes?: string[] }[] }).grants ?? []).flatMap(
    (g) => g.grantedScopes ?? [],
  );
  const wanted = process.argv[3] === 'all' ? [...WANTED_SCOPES, ...EXPLORE_SCOPES] : WANTED_SCOPES;
  const requestedScopes = [...new Set([...wanted, ...current])];
  const reply = await send(
    { baseUrl: target.baseUrl, apiKey: target.apiKey },
    {
      method: 'POST',
      path: '/platform/link-sessions',
      idempotencyKey: randomUUID(),
      body: { requestedScopes, metadata: { purpose: 'payout-runs-demo' } },
    },
  );
  record('link-session-create', reply);
  show('POST /platform/link-sessions', reply);
  const body = reply.body as { url?: string; sessionId?: string };
  if (reply.status < 300 && body.url && body.sessionId) {
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, linkSessionId: body.sessionId }, null, 2));
    console.log(`\nOpen this link while signed in to the portal (test mode) and approve:\n${body.url}`);
  }
}

/** Read-only: did the owner approve, and which scopes does the grant have now? */
async function linkStatus(): Promise<void> {
  const { state, ...target } = savedTarget();
  const platform = { baseUrl: target.baseUrl, apiKey: target.apiKey };
  if (state.linkSessionId) {
    const session = await send(platform, { method: 'GET', path: `/platform/link-sessions/${state.linkSessionId}` });
    record('link-session-get', session);
    show('GET /platform/link-sessions/{id}', session);
  }
  const grants = await send(platform, { method: 'GET', path: '/platform/grants' });
  record('grants-after-link', grants);
  for (const grant of (grants.body as { grants?: { status?: string; grantedScopes?: string[] }[] }).grants ?? []) {
    const scopes = grant.grantedScopes ?? [];
    const missing = WANTED_SCOPES.filter((s) => !scopes.includes(s));
    console.log(
      `\ngrant ${grant.status}: ${scopes.length} scopes; missing ${missing.length ? missing.join(' ') : 'none'}`,
    );
  }
}

/** Read-only: how many invoices and distributions exist at the provider, by status. */
async function openObjects(): Promise<void> {
  const target: OncadeTarget = savedTarget();
  for (const kind of ['invoices', 'distributions'] as const) {
    const counts: Record<string, number> = {};
    let problem = '';
    for (let page = 1; !problem; page++) {
      const reply = await send(target, { method: 'GET', path: `/platform/${kind}?page=${page}&limit=100` });
      const body = reply.body as (Record<string, unknown> & { pagination?: { totalPages?: number } }) | null;
      const items = body?.[kind] as { status?: string }[] | undefined;
      if (reply.status !== 200 || !Array.isArray(items)) problem = `could not read (${reply.status})`;
      for (const item of items ?? []) {
        const status = item.status ?? 'unknown';
        counts[status] = (counts[status] ?? 0) + 1;
      }
      if (page >= (body?.pagination?.totalPages ?? 1)) break;
    }
    const summary = Object.entries(counts).map(([status, n]) => `${n} ${status}`);
    console.log(`${kind}: ${problem || summary.join(', ') || 'none'}`);
    if (problem) process.exitCode = 1;
  }
}

const command = process.argv[2] ?? 'probe';
const commands: Record<string, () => Promise<void>> = {
  probe,
  link,
  'link-status': linkStatus,
  'open-objects': openObjects,
};
const run = commands[command];
if (!run) {
  console.error(`unknown command "${command}". Use: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
