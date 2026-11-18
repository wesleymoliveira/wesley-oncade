// What every exploration script shares: one call to the Oncade test API,
// saved and summarised, and the questions the family answered.
//
// Raw replies go to .local/raw/explore (never committed). What is committed,
// in explore/results, holds statuses, codes and field names only.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertTestKey, send } from '../lib/oncade/http.ts';
import { scrubText } from '../scripts/lib/shape.ts';

const ROOT = join(import.meta.dirname, '..');
const RAW = join(ROOT, '.local', 'raw');
const RESULTS = join(import.meta.dirname, 'results');

export interface Answer {
  status: number;
  code: string | null;
  body: any;
}

interface CallOptions {
  body?: unknown;
  query?: string;
  /** The Idempotency-Key. A new one per call unless the question is about repeating it. */
  key?: string;
  /** Without X-Target-Business-Id: calls about the platform itself. */
  asPlatform?: boolean;
  /** Another key than the one in .env: only for a key this session created, held in memory. */
  withKey?: string;
}

/** A key or a secret in a reply never reaches the disk. */
function redact(value: unknown, name = ''): unknown {
  if (typeof value === 'string') {
    return /secret|apikey|rawkey|^key$|token/i.test(name) || /oncade_platform_(test|live)_/.test(value)
      ? '<redacted>'
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, name));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function explore(family: string) {
  const apiKey = process.env.API_KEY;
  assertTestKey(apiKey);
  const saved = JSON.parse(readFileSync(join(ROOT, '.local', 'oncade.json'), 'utf8')) as {
    baseUrl: string;
    businessId: string;
  };
  const startedAt = Date.now();
  const calls: { endpoint: string; status: number; code: string | null; asked: string }[] = [];
  const answers: Record<string, string> = {};
  mkdirSync(join(RAW, 'explore', family), { recursive: true });

  return {
    /** Marks what this session creates, so it can be found and removed. */
    tag: `EXPLORE-${startedAt.toString(36)}`,
    businessId: saved.businessId,

    /**
     * One call. `endpoint` is written as in the reference, for example
     * "POST /invoices/{invoiceId}/send", so the coverage table can count it.
     * `asked` says in a few words why the call was made.
     */
    async call(
      asked: string,
      endpoint: string,
      params: Record<string, string> = {},
      options: CallOptions = {},
    ): Promise<Answer> {
      const [method, template] = endpoint.split(' ') as ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];
      const path = template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? name));
      const reply = await send(
        {
          baseUrl: saved.baseUrl,
          apiKey: options.withKey ?? apiKey,
          businessId: options.asPlatform ? undefined : saved.businessId,
        },
        {
          method,
          path: `/platform${path}${options.query ?? ''}`,
          body: options.body,
          idempotencyKey: method === 'GET' ? undefined : (options.key ?? randomUUID()),
        },
      );
      const body = reply.body as { code?: string; error?: string; status?: string } | null;
      // Only an error has a code. A success may have a field called `code` too (an invite code): never keep that.
      const code = reply.status >= 400 && typeof body?.code === 'string' ? body.code : null;
      calls.push({ endpoint, status: reply.status, code, asked });
      const file = `${String(calls.length).padStart(2, '0')}-${asked.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
      writeFileSync(join(RAW, 'explore', family, file), JSON.stringify(redact(reply), null, 2));

      // A success shows its status, or failing that the names of its fields. Never a value.
      const fields = body !== null && typeof body === 'object' ? Object.keys(body).slice(0, 10).join(', ') : '';
      const detail =
        reply.status < 300
          ? typeof body?.status === 'string'
            ? `status ${body.status}`
            : fields && `fields ${fields}`
          : scrubText(`${code ?? ''} ${body?.error ?? ''}`.trim()).slice(0, 110);
      console.log(`${String(reply.status).padEnd(4)} ${endpoint.padEnd(46)} ${asked}${detail ? `: ${detail}` : ''}`);
      return { status: reply.status, code, body: reply.body };
    },

    /** One of the questions every family is asked, and what the API answered. */
    answer(question: string, text: string): void {
      answers[question] = text;
    },

    /** Waits for late webhooks, then writes what is safe to commit. */
    async finish(): Promise<void> {
      // Deliveries are recorded by the running API. Without it, "none arrived" would not be a fact.
      const receiver = await fetch(`${process.env.APP_URL ?? 'http://127.0.0.1:3300'}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((response) => response.json() as Promise<{ recordsWebhooks?: boolean }>)
        .catch(() => null);
      await sleep(6_000);
      const webhooks = readdirSync(RAW)
        .filter((file) => file.includes('-webhook-') && statSync(join(RAW, file)).mtimeMs >= startedAt)
        .map((file) => file.replace(/^\d+-webhook-/, '').replace(/\.json$/, ''));
      const counts = new Map<string, number>();
      for (const event of webhooks) counts.set(event, (counts.get(event) ?? 0) + 1);
      answers['webhooks delivered'] = !receiver?.recordsWebhooks
        ? 'not listening: no receiver was recording deliveries'
        : [...counts].map(([event, n]) => `${event} × ${n}`).join(', ') || 'none';
      mkdirSync(RESULTS, { recursive: true });
      const result = { family, at: new Date(startedAt).toISOString().slice(0, 10), calls, answers };
      writeFileSync(join(RESULTS, `${family}.json`), `${JSON.stringify(result, null, 2)}\n`);
      console.log(`\n=== ${family}: what the API answered`);
      for (const [question, text] of Object.entries(answers)) console.log(`  ${question.padEnd(22)} ${text}`);
    },
  };
}

/** "201 draft", "422 INVOICE_INVALID_STATUS": an answer in a few words. */
export function brief(answer: Answer): string {
  const status = typeof answer.body?.status === 'string' ? ` ${answer.body.status}` : '';
  return `${answer.status}${answer.code ? ` ${answer.code}` : status}`;
}
