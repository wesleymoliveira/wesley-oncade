import { retryFailed } from '../../../../../lib/flows/retry-failed.ts';
import { guarded, json, noSuchRun, refuse, runOf, type RunPath } from '../../../../../lib/http/respond.ts';

export const dynamic = 'force-dynamic';

/** Pays the people who are still unpaid, in new batches. Never resends an old batch. */
export const POST = guarded<RunPath>(async (_request, context) => {
  const reference = await runOf(context);
  const answer = reference ? await retryFailed(reference) : { kind: 'not_found' as const };
  if (answer.kind === 'not_found') return noSuchRun();
  if (answer.kind === 'refused') return refuse(409, 'CANNOT_RETRY', answer.reason);
  return json({ reference, batches: answer.batches, people: answer.people }, 202);
});
