// The one place that talks HTTP to Oncade. It adds the headers every call
// needs and returns what came back. It does not retry and does not decide
// what a status means: lib/oncade/client.ts does that.

export const TEST_KEY = /^oncade_platform_test_[0-9a-f]+$/;

export interface OncadeTarget {
  baseUrl: string;
  apiKey: string;
  businessId?: string;
}

export interface OncadeCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Required by the API on POST, PUT and PATCH. */
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface OncadeReply {
  status: number;
  contentType: string;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown;
  /** Set on a 3xx. We never follow it: fetch drops Authorization across hosts. */
  location?: string;
  ms: number;
}

/**
 * Refuses anything that is not a test key before a single byte leaves the
 * machine. The message never contains the key.
 */
export function assertTestKey(apiKey: string | undefined): asserts apiKey is string {
  if (!apiKey) throw new Error('API_KEY is not set');
  if (apiKey.startsWith('oncade_platform_live_')) {
    throw new Error('API_KEY is a live key. This project only runs with a test key.');
  }
  if (!TEST_KEY.test(apiKey)) {
    throw new Error(
      'API_KEY does not look like oncade_platform_test_<hex>. ' +
        'Check that the line in .env ends with a line break and has no quotes or spaces.',
    );
  }
}

export async function send(target: OncadeTarget, call: OncadeCall): Promise<OncadeReply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.apiKey}`,
    'x-oncade-api-version': 'v1',
    accept: 'application/json',
    'user-agent': 'payout-runs-demo/0.1',
  };
  if (target.businessId) headers['x-target-business-id'] = target.businessId;
  if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
  if (call.body !== undefined) headers['content-type'] = 'application/json';

  const started = performance.now();
  const res = await fetch(new URL(`/api/v1${call.path}`, target.baseUrl), {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(call.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  let body: unknown = text;
  if (contentType.includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    contentType,
    body,
    location: res.headers.get('location') ?? undefined,
    ms: Math.round(performance.now() - started),
  };
}
