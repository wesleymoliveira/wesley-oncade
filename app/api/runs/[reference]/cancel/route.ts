import { requestCancel } from '../../../../../lib/flows/cancel.ts';
import { guarded, json, noSuchRun, refuse, runOf, type RunPath } from '../../../../../lib/http/respond.ts';

export const dynamic = 'force-dynamic';

/** Asks for a cancel. 202 means "asked": the run is cancelled only when the provider confirms. 200: it already is. */
export const POST = guarded<RunPath>(async (_request, context) => {
  const reference = await runOf(context);
  const answer = reference ? await requestCancel(reference) : { kind: 'not_found' as const };
  if (answer.kind === 'not_found') return noSuchRun();
  if (answer.kind === 'refused') return refuse(409, 'CANNOT_CANCEL', answer.reason);
  return json({ reference, status: answer.status }, answer.status === 'cancelled' ? 200 : 202);
});
