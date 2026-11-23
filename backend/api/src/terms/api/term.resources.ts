import {
  TERM_SCHEMA_VERSION,
  TERM_STATUSES,
  TermLanguage,
  type Issue as IssueValue,
  type Term,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { Issue } from '../../base/api/schemas.js';
import type { TermEntry } from '../core/actions/list-terms.action.js';
import {
  MAX_USED_IN,
  type TermUsage as TermUsageValue,
} from '../../modules/core/readable-module-index.js';

export const TermUse = z
  .object({
    moduleId: z.string(),
    lang: z.string(),
    title: z.string().describe('The module file’s title.'),
  })
  .describe('A module file whose term links name the term (#245).')
  .meta({ id: 'TermUse' });

export const TermAttributes = z.object({
  schemaVersion: z.literal(TERM_SCHEMA_VERSION),
  status: z
    .enum(TERM_STATUSES)
    .describe(
      '`proposed` (not agreed yet), `approved` (use it), `deprecated` (no longer use it; `replacedBy` may name the term to use instead).',
    ),
  domain: z
    .string()
    .optional()
    .describe('The subject field the term belongs to, e.g. `charging`.'),
  replacedBy: z
    .string()
    .optional()
    .describe(
      'A deprecated term’s successor: the ID of the term to use instead (not checked to exist here).',
    ),
  languages: z
    .record(z.string(), TermLanguage)
    .describe(
      'Per language tag (canonical case): the preferred variant, the allowed and forbidden ones (each with an optional note), the definition (inline content: text runs with marks, and line breaks) and a usage note.',
    ),
});

export const TermResource = resourceObject('Term', {
  attributes: TermAttributes,
  meta: z.object({
    issues: z
      .array(Issue)
      .describe(
        'Problems found checking it against the configuration (a language it does not hold: `unknown-language`).',
      ),
  }),
})
  .describe('`id` is the term’s ID, its file name (`terms/<id>.yaml`).')
  .meta({ id: 'TermResource' });

/** A file in `terms/` that is no term; listed so it does not hide. */
export const UnreadableTermResource = resourceObject('Term', {
  attributes: z.object({}),
  meta: z.object({ error: z.string().describe('Why it cannot be read.') }),
}).meta({ id: 'UnreadableTermResource' });

/** One term as `GET /terms/:termId` serves it: with where it is linked. */
export const TermDetailResource = resourceObject('Term', {
  attributes: TermAttributes,
  meta: z.object({
    issues: TermResource.shape.meta.shape.issues,
    usage: z
      .object({
        modules: z
          .number()
          .int()
          .describe('The module files (each language apart) linking it.'),
      })
      .describe(
        'How many module files link the term (#245), from the module index; only what the reader may see counts.',
      ),
    linkedIn: z
      .array(TermUse)
      .max(MAX_USED_IN)
      .describe(
        `The module files whose term links name it, by title; at most ${MAX_USED_IN} (\`usage\` counts them all). Only module files the reader may see are named. A term still linked cannot be deleted (422 \`term-in-use\` on the commit).`,
      ),
  }),
})
  .describe('`id` is the term’s ID, its file name (`terms/<id>.yaml`).')
  .meta({ id: 'TermDetailResource' });

export const TermDocument = singleDocument(TermDetailResource).meta({
  id: 'TermDocument',
});

export const TermPageDocument = pagedDocument(
  z.union([TermResource, UnreadableTermResource]),
).meta({ id: 'TermPageDocument' });

export function toTermResource(
  term: Term,
  issues: IssueValue[],
): z.infer<typeof TermResource> {
  return {
    type: 'Term',
    id: term.id,
    attributes: {
      schemaVersion: term.schemaVersion,
      status: term.status,
      ...(term.domain === undefined ? {} : { domain: term.domain }),
      ...(term.replacedBy === undefined ? {} : { replacedBy: term.replacedBy }),
      languages: term.languages,
    },
    meta: { issues },
  };
}

export function toTermDetailResource(
  term: Term,
  issues: IssueValue[],
  usage: TermUsageValue,
): z.infer<typeof TermDetailResource> {
  const { attributes } = toTermResource(term, issues);
  return {
    type: 'Term',
    id: term.id,
    attributes,
    meta: {
      issues,
      usage: { modules: usage.modules },
      linkedIn: usage.uses.slice(0, MAX_USED_IN).map((u) => ({ ...u })),
    },
  };
}

export function toTermListResource(
  entry: TermEntry,
): z.infer<typeof TermResource> | z.infer<typeof UnreadableTermResource> {
  return 'error' in entry
    ? {
        type: 'Term',
        id: entry.id,
        attributes: {},
        meta: { error: entry.error },
      }
    : toTermResource(entry.term, entry.issues);
}
