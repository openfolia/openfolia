import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toPagedDocument,
} from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ContentSubject } from '../../change-sets/core/lock.js';
import {
  CHECK_CATEGORIES,
  CHECK_CODES,
  CHECK_SEVERITIES,
  categoryOf,
  checkKey,
  severityOf,
  type Check,
  type CheckCode,
} from '../core/check.js';
import type { CheckPage } from '../core/check-page.js';

const CODES = Object.keys(CHECK_CODES) as [CheckCode, ...CheckCode[]];

/** The codes with their severity, for the API reference. */
const CODE_TABLE = CODES.map(
  (code) =>
    `\`${code}\` (${CHECK_CODES[code].severity}): ${CHECK_CODES[code].description}`,
).join(' ');

export const CheckSeverity = z
  .enum(CHECK_SEVERITIES)
  .describe(
    '`blocking`: holds up review and release until it is fixed; `warning`: worth a look, holds up nothing.',
  );

export const CheckResource = resourceObject('Check', {
  attributes: z.object({
    code: z
      .enum(CODES)
      .describe(
        `Stable. Its severity is fixed per code (in brackets below), but for \`forbidden-term\` and \`style-rule\`, whose severity the configuration decides (#55): \`terminology.forbiddenIsBlocking\`, a style rule's \`severity\`. ${CODE_TABLE}`,
      ),
    severity: CheckSeverity,
    category: z.enum(CHECK_CATEGORIES),
    subject: ContentSubject.describe(
      'The module (in one language), the manual or the page design (its own template, #396) the problem is in: where to fix it.',
    ).meta({ id: 'ContentSubject' }),
    blockId: z
      .string()
      .nullable()
      .describe(
        'The block, list item or procedure step, by its ID; null for the subject as a whole.',
      ),
    message: z
      .string()
      .describe(
        'In English, for logs; clients show their own text for `code`.',
      ),
    params: z
      .record(z.string(), z.string())
      .describe(
        "What the code is about: `module` (a module referred to), `block`, `lang` (a language without a translation, or an outdated one), `blocks` (how many blocks of an outdated translation: part of what makes the check, so its `id` changes with the count), `asset` (an image), `at` (where in a manifest), `problem` (why the PDF cannot meet PDF/UA-1, in the renderer's English), `reason` (the PDF route's error code for a PDF not checked), `address`, `manual` and `as` (a stable address taken, the other manual, `slug` or `formerly`), `access` and `maxAccess` (`delivery.access` and the deployment's cap), `chars`, `nodes` and `kept` (what a module's retrieval chunks expanded to in a chunk set too large together, and whether the room for the text kept was the one passed), `modules` (how many module files, a module in one language each, whose chunks were not checked), and for the writing checks (#55) `term`, `rule`, `status`, `text`, `replacement`, `note`, `message`, `words` and `max`, and `field`, `start` and `end` (which text of the block, and the UTF-16 offsets of what was found in its plain text), `stopped` (why they stopped).",
      ),
  }),
  meta: z.object({
    variants: z
      .array(z.string())
      .describe(
        'The manual’s variants (slugs) it was found in; empty when it does not depend on one.',
      ),
    languages: z
      .array(z.string())
      .describe(
        'The manual’s languages it was found in; empty when it does not depend on one.',
      ),
    title: z
      .string()
      .nullable()
      .describe(
        'The subject’s title (the module in its language, or the manual), as the reader reads it; null when it cannot be read.',
      ),
  }),
})
  .describe(
    'A problem found in content: derived on every request, never stored.',
  )
  .meta({ id: 'CheckResource' });

export const CheckPageDocument = z
  .object({
    data: z.array(CheckResource),
    meta: z.object({
      page: PageMeta,
      counts: z
        .object({ blocking: z.number().int(), warning: z.number().int() })
        .describe('Every check found, by severity, before `filter[severity]`.'),
      modules: z
        .object({
          checked: z.number().int(),
          withoutIssues: z.number().int(),
        })
        .describe(
          'The modules checked (by ID, in any language the reader may read), and how many of them no check names.',
        ),
      commit: z.string().describe('The commit checked.'),
    }),
    links: PageLinks,
  })
  .meta({ id: 'CheckPageDocument' });

export const checkFilters = {
  severity: z.enum(CHECK_SEVERITIES),
};

export function toCheckResource(check: Check): z.infer<typeof CheckResource> {
  return {
    type: 'Check',
    id: createHash('sha256')
      .update(checkKey(check))
      .digest('base64url')
      .slice(0, 22),
    attributes: {
      code: check.code,
      severity: severityOf(check),
      category: categoryOf(check),
      subject: check.subject,
      blockId: check.blockId ?? null,
      message: check.message,
      params: { ...check.params },
    },
    meta: {
      variants: [...check.variants],
      languages: [...check.languages],
      title: check.title ?? null,
    },
  };
}

export function toCheckPageDocument(
  req: Request,
  page: PageRequest,
  result: CheckPage,
): z.infer<typeof CheckPageDocument> {
  const document = toPagedDocument(req, page, result, toCheckResource);
  return {
    ...document,
    meta: {
      ...document.meta,
      counts: result.counts,
      modules: result.modules,
      commit: result.commit,
    },
  };
}
