import { z } from 'zod';

/**
 * Unset and blank both mean "not set". Applied around the whole field, so
 * that a blank value reaches `.optional()` / `.default()` as undefined.
 */
export const field = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    schema,
  );

export const text = z.string().trim().min(1);

/** Plain decimal digits within [min, max]; rejects "1e3", "0x10", "-1" and the like. */
export const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,10}$/, `must be a whole number from ${min} to ${max}`)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** `true` or `false`, nothing else, so a typo cannot silently mean either. */
export const flag = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false'], 'must be true or false'))
  .transform((value) => value === 'true');
