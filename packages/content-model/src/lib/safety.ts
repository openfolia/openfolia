/**
 * The hazard levels of a safety message (`Safety.severity`), most severe first: the signal words
 * of ANSI Z535 and ISO 3864 (`DANGER`, `WARNING`, `CAUTION`, `NOTICE`; their printed words are
 * the output labels of the same keys, per language). Schema-free, so `@openfolia/content-model/core`
 * has it.
 */
export const SAFETY_SEVERITIES = [
  'danger',
  'warning',
  'caution',
  'notice',
] as const;
