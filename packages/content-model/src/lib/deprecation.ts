import { z } from 'zod';
import { ModuleId, SingleLine } from './ids.js';

/** The longest deprecation reason, in characters (UTF-16 units). */
export const MAX_DEPRECATION_REASON_LENGTH = 500;

/**
 * A module or manual withdrawn or superseded (#266): why, and optionally
 * what replaces it (a module ID for a module, a manual ID for a manual).
 * Deprecated content stays readable and stays in manuals until someone
 * removes it; checks warn where it is still used. The reason is one line
 * of plain text, as people write it, in NFC, 1 to
 * `MAX_DEPRECATION_REASON_LENGTH` characters.
 */
export const Deprecation = z.strictObject({
  reason: SingleLine.overwrite((r) => r.normalize('NFC')).max(
    MAX_DEPRECATION_REASON_LENGTH,
    `a reason has at most ${MAX_DEPRECATION_REASON_LENGTH} characters`,
  ),
  replacedBy: ModuleId.optional(),
});
export type Deprecation = z.infer<typeof Deprecation>;
