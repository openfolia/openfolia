import { z } from 'zod';
import {
  parseTypeRules,
  type TypeRule,
} from '../assets/core/attachment-types.js';

/**
 * A comma-separated list of attachment type rules (`application/zip`,
 * `text/*`, `.zip`), lowercase; see `parseTypeRules`.
 */
export const attachmentTypeRules = z
  .string()
  .trim()
  .transform((value, ctx): TypeRule[] => {
    const rules = parseTypeRules(value);
    if (typeof rules === 'string') {
      ctx.addIssue({ code: 'custom', message: rules });
      return z.NEVER;
    }
    return rules;
  });

/**
 * An allow list: as `attachmentTypeRules`, but one of only commas and
 * spaces (which would take no file at all) is refused at startup.
 */
export const attachmentAllowRules = attachmentTypeRules.refine(
  (rules) => rules.length > 0,
  'an allow list names at least one type or extension (leave it unset to take every type)',
);
