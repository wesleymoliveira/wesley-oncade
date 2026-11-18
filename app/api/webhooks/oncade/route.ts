import { acceptWebhook } from '../../../../lib/flows/webhook.ts';
import { json } from '../../../../lib/http/respond.ts';

export const dynamic = 'force-dynamic';

/**
 * Webhooks from Oncade. No token here: the signature is the proof. The body
 * is read as raw text, never as parsed JSON, because the signature covers
 * the exact bytes.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const answer = await acceptWebhook(rawBody, request.headers.get('x-oncade-signature'));
  return json(answer.body, answer.status);
}
