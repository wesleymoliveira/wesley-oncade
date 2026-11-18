// Turns raw replies and webhook deliveries (saved under .local/raw, never
// committed) into fixtures that can be committed: the same structure and
// the same enumerated values, and nothing that identifies a person or an
// account.
//
//   npm run fixtures -- <raw file> <fixture name> [<raw file> <fixture name> ...]
//
// Files given together share one id map, so two objects that differ in the
// raw replies still differ in the fixtures. tests/contract reads the result.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubText } from './lib/shape.ts';

const OUT = join(import.meta.dirname, '..', 'tests', 'contract', 'fixtures');

/** Values that are part of the contract and safe to keep as they are. */
const KEEP = new Set([
  'event',
  'status',
  'environment',
  'code',
  'error',
  'payToTarget',
  'currency',
  'mode',
  'payoutPath',
  'method',
  'feeType',
  'ready',
]);

const ids = new Map<string, string>();
const fakeId = (real: string) => {
  if (!ids.has(real)) ids.set(real, String(ids.size + 1).padStart(24, '0'));
  return ids.get(real)!;
};

function scrub(value: unknown, key = ''): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => scrub(item, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  }
  const text = String(value);
  if (KEEP.has(key) || /scope/i.test(key)) return scrubText(text);
  if (/^[0-9a-f]{24}$/.test(text)) return fakeId(text);
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return `0x${'0'.repeat(40)}`;
  if (/^[^@\s]+@[^@\s]+$/.test(text)) return 'person@example.com';
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.length > 10 ? '2026-11-16T12:00:00.000Z' : '2026-11-16';
  if (/^https?:\/\//.test(text)) return `https://${new URL(text).host}/…`;
  return 'text';
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('usage: npm run fixtures -- <raw file> <fixture name> [<raw file> <fixture name> ...]');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (let i = 0; i < args.length; i += 2) {
  const reply = JSON.parse(readFileSync(args[i]!, 'utf8')) as { status: number; body: unknown };
  const fixture = { status: reply.status, body: scrub(reply.body) };
  writeFileSync(join(OUT, `${args[i + 1]}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}
console.log(`${args.length / 2} fixture(s) written to tests/contract/fixtures. Now run: npm run format`);
