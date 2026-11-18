// Oncade pays at most 20 people per distribution, so a run is split in batches.

/** From the Platform API reference: more than this returns 400 TOO_MANY_RECIPIENTS. */
export const MAX_RECIPIENTS = 20;

/** Splits a list into groups of at most `size`, keeping the order. */
export function chunk<T>(items: readonly T[], size: number = MAX_RECIPIENTS): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer: ${size}`);
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

/**
 * The id of a batch, which is also our own reference for the send. It is
 * written to the database before the call and travels in the distribution's
 * memo, so after a crash we can ask Oncade whether that send exists.
 * Example: "PR-2026-11/a1/b07" is attempt 1, batch 7 of run PR-2026-11.
 */
export function batchId(runId: string, attempt: number, index: number): string {
  return `${runId}/a${attempt}/b${String(index).padStart(2, '0')}`;
}

export function payeeId(runId: string, index: number): string {
  return `${runId}/p${String(index).padStart(3, '0')}`;
}
