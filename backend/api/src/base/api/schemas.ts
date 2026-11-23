import { LanguageTag, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';

/** A problem found while checking content against the project configuration. */
export const Issue = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z
      .string()
      .describe('Stable machine-readable code, e.g. `unknown-audience`.'),
    message: z.string(),
    at: z
      .string()
      .optional()
      .describe('ID of the block or item concerned; absent for metadata.'),
  })
  .meta({ id: 'Issue' });

/** A problem found while assembling a manual. */
export const ResolveIssue = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z
      .string()
      .describe('Stable machine-readable code, e.g. `missing-module`.'),
    message: z.string(),
    module: z.string().optional().describe('The module concerned.'),
  })
  .meta({ id: 'ResolveIssue' });

/** Path and filter parameters, validated before any lookup. */
export const params = {
  moduleId: ModuleId,
  lang: LanguageTag,
  manualId: ModuleId,
  variant: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Variant slug as listed by `GET /manuals/{id}`, e.g. `model=large`.',
    ),
  assetHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, '64 lowercase hex characters (SHA-256)'),
};
