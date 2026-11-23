import {
  EXPANSION_LIMITS,
  type ExpansionLimits,
} from '@openfolia/content-model';

/**
 * The injection token of the expansion limits (#726) that `ListChunksAction` and
 * `ContentChecks` cut chunks to: a test seam, not a setting. No module of the app provides it,
 * so they hold content to the content model's `EXPANSION_LIMITS` (the limits of #679), which
 * neither the environment nor a request can change; only a test app provides it
 * (`createTestApp`'s `expansionLimits`), so that its specs cross the same boundaries with
 * content about a hundred times smaller.
 */
export const EXPANSION_LIMITS_TOKEN = Symbol('ExpansionLimits');

/**
 * `given`, checked, or `EXPANSION_LIMITS` when there is none: each limit a whole number from 1
 * up to its value in `EXPANSION_LIMITS`, so the seam can only lower the limits, and a test's
 * mistake fails at start-up instead of passing everything (`NaN`) or nothing.
 */
export function expansionLimitsOf(
  given: ExpansionLimits | undefined,
): ExpansionLimits {
  if (given === undefined) return EXPANSION_LIMITS;
  for (const key of ['nodes', 'chars', 'cells', 'depth'] as const) {
    const value = given[key];
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > EXPANSION_LIMITS[key]
    ) {
      throw new TypeError(
        `expansion limit ${key} must be a whole number from 1 to ${EXPANSION_LIMITS[key]}, not ${String(value)}`,
      );
    }
  }
  return Object.freeze({
    nodes: given.nodes,
    chars: given.chars,
    cells: given.cells,
    depth: given.depth,
  });
}
