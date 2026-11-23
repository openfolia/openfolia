import { z } from 'zod';
import { VERSION_PATTERN } from './condition-check.js';
import { ConfigKey } from './ids.js';

/**
 * A variant condition. Stored in AsciiDoc as a readable expression
 * (`model in (a, b) && software >= 2.3`); this is its parsed form.
 *
 * - `in`  for enum attributes (model, market, option): true if the variant's value is listed.
 * - `cmp` for version attributes: compares dotted versions numerically.
 *
 * On a version attribute, `in` is numeric equality too: "2.3" matches "2.3.0".
 */
export type Condition =
  | { op: 'all'; of: Condition[] }
  | { op: 'any'; of: Condition[] }
  | { op: 'not'; of: Condition }
  | { op: 'in'; attr: string; values: string[] }
  | { op: 'cmp'; attr: string; cmp: '<' | '<=' | '>' | '>='; value: string };

export const Version = z
  .string()
  .regex(VERSION_PATTERN, 'dotted version, e.g. "2.3" or "2.3.1"');

export const Condition: z.ZodType<Condition, Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('all'), of: z.array(Condition).min(2) }),
    z.object({ op: z.literal('any'), of: z.array(Condition).min(2) }),
    z.object({ op: z.literal('not'), of: Condition }),
    z.object({
      op: z.literal('in'),
      attr: ConfigKey,
      values: z.array(z.string().min(1)).min(1),
    }),
    z.object({
      op: z.literal('cmp'),
      attr: ConfigKey,
      cmp: z.enum(['<', '<=', '>', '>=']),
      value: Version,
    }),
  ]),
);
