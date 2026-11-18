import { viewRun } from '../../../../lib/flows/view.ts';
import { guarded, json, noSuchRun, runOf, type RunPath } from '../../../../lib/http/respond.ts';

export const dynamic = 'force-dynamic';

/** Where is this run? State, money, people (counted), batches and history. */
export const GET = guarded<RunPath>(async (_request, context) => {
  const reference = await runOf(context);
  const view = reference && (await viewRun(reference));
  return view ? json(view) : noSuchRun();
});
