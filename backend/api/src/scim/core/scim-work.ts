import { ScimInvalidValueError } from './scim-errors.js';

/**
 * What one PATCH, one list filter or one selection of attributes may cost: these run on the one
 * event loop, a PATCH under the access lock, and what they cost depends on the stored resources
 * as much as on the request (a thousand filtered removes walk a large group a thousand times).
 *
 * The bound is the CPU time of the thread, so it holds whatever the request's shape and however
 * busy the machine is. The steps that do the walking (`scim-json.ts`, `scim-filter.ts`,
 * `scim-patch.ts`) call `spend` with about what they cost, one unit per key, value or comparison
 * visited and per 16 characters read: that says when to look at the clock, and `MAX_WORK` of
 * them bounds how large a result may grow. Outside `withBudget` nothing is charged.
 */
export const MAX_CPU_MS = 2000;
export const MAX_WORK = 100_000_000;
/** How much work passes between two looks at the clock. */
const CHECK_EVERY = 5000;

let budget:
  | {
      left: number;
      unchecked: number;
      readonly start: NodeJS.CpuUsage;
    }
  | undefined;

/** Runs `run` (synchronous) on a budget, the one already running if any: 400 past it. */
export function withBudget<T>(run: () => T): T {
  if (budget) return run();
  budget = { left: MAX_WORK, unchecked: 0, start: process.threadCpuUsage() };
  try {
    return run();
  } finally {
    budget = undefined;
  }
}

/** Charges `units` of work to the running budget. */
export function spend(units: number): void {
  if (!budget) return;
  budget.left -= units;
  budget.unchecked += units + 1;
  if (budget.unchecked >= CHECK_EVERY) {
    budget.unchecked = 0;
    const { user, system } = process.threadCpuUsage(budget.start);
    if ((user + system) / 1000 > MAX_CPU_MS) budget.left = -1;
  }
  if (budget.left < 0) {
    throw new ScimInvalidValueError(
      'The request is too much work at once: send its operations in smaller requests, a shorter filter or fewer attributes.',
    );
  }
}

const inOrder = (_key: string, value: unknown): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    : value;

/** What reading `text` costs. */
export const weightOf = (text: string): number => text.length >> 4;

/** The JSON of `value`, its attributes in one order (equal values, equal JSON), charged by its length. */
export function jsonOf(value: unknown): string | undefined {
  const text = JSON.stringify(value, inOrder) as string | undefined;
  if (text !== undefined) spend(1 + weightOf(text));
  return text;
}
