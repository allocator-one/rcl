/**
 * Reserve bounded terminal work inside the immutable operation lifetime. This
 * is execution tightening, not an extension or a delivery guarantee. Reopening
 * the same saved bounds derives the same cutoff without consulting a clock.
 */
export function retainedPaidCutoff(bounds: { startedAtMs: number; expiresAtMs: number }): number {
  const { startedAtMs, expiresAtMs } = bounds;
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs - startedAtMs < 4 || expiresAtMs - startedAtMs > 2_147_483_647) {
    throw new Error('retained_execution_budget');
  }
  return expiresAtMs - Math.min(120_000, Math.floor((expiresAtMs - startedAtMs) / 4));
}
