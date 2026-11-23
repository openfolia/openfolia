import type { Request } from 'express';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  singleDocument,
  toPagedDocument,
} from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { CHANGE_KINDS } from '../../change-sets/core/change-set-diff.js';
import {
  toVersionMembers,
  VERSION_MEMBERS,
} from '../../modules/api/module-history.resources.js';
import type { ManualComparison } from '../core/actions/compare-manual-versions.action.js';
import type { ManualHistoryPage } from '../core/actions/get-manual-history.action.js';
import { ManualAttributes, toManualAttributes } from './manual.resources.js';

const Commit = z.string().describe('A commit ID.');

/** A version of a manual: a commit on the ref's first-parent line that changed its manifest. */
export const ManualVersionResource = resourceObject('ManualVersion', {
  ...VERSION_MEMBERS,
  meta: VERSION_MEMBERS.meta.extend({
    readAt: Commit.describe(
      'The commit to read this version at (`GET /manuals/{id}/compare`, `GET /manuals/{id}?ref=`): its own (`attributes.commit`) for a reader of drafts (`content.read.draft`); for a reader of released content only, who is listed only the versions released content holds, the released commit holding it (`main`’s head, else the newest release tag in `releases`).',
    ),
  }),
})
  .describe(
    '`id` is `<manualId>/<commit>`. As a `ModuleVersion`, of the manual’s manifest (`manuals/<id>.yaml`); derived from Git, nothing of it is stored.',
  )
  .meta({ id: 'ManualVersionResource' });

export const ManualVersionPageDocument = z
  .object({
    data: z.array(ManualVersionResource),
    meta: z.object({
      page: PageMeta,
      truncated: z
        .boolean()
        .describe(
          'The ref’s first-parent line goes on past the 1,000 newest commits looked at: older versions are not listed, and, when the manual existed before them, versions carry no revision number.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'ManualVersionPageDocument' });

export function toManualVersionPageDocument(
  req: Request,
  page: PageRequest,
  manualId: string,
  result: ManualHistoryPage,
): z.infer<typeof ManualVersionPageDocument> {
  const document = toPagedDocument(req, page, result, (entry) => {
    const members = toVersionMembers(entry);
    return {
      type: 'ManualVersion' as const,
      id: `${manualId}/${entry.commit}`,
      ...members,
      meta: { ...members.meta, readAt: entry.readAt },
    };
  });
  return {
    ...document,
    meta: { ...document.meta, truncated: result.truncated },
  };
}

/** A manual at two versions, and how it changed between them. */
export const ManualComparisonResource = resourceObject('ManualComparison', {
  attributes: z.object({
    base: ManualAttributes.nullable().describe(
      'The manual at `base`, as the reader sees it on both sides (naming only the modules it may name to them on both); null when it is not there (or cannot be read: `meta.unreadable`).',
    ),
    head: ManualAttributes.nullable().describe(
      'The manual at `head`, likewise.',
    ),
  }),
  meta: z.object({
    base: Commit.describe('The commit `base` named.'),
    head: Commit.describe('The commit `head` named.'),
    change: z
      .enum([...CHANGE_KINDS, 'unchanged'])
      .describe(
        '`added` (not there at `base`), `removed` (not there at `head`), `changed`, or `unchanged` (the same manifest on both sides).',
      ),
    fields: z
      .array(z.string())
      .describe(
        'The manifest’s members that differ (`title`, `audience`, `variants`, `attributes`, `entries`, …), as in a change set’s changes. Empty unless changed.',
      ),
    unreadable: z
      .boolean()
      .describe(
        'A side has a manifest that cannot be read (shown only to a reader of every audience).',
      ),
  }),
})
  .describe(
    '`id` is `<manualId>/<base commit>..<head commit>`. Derived from Git, never stored.',
  )
  .meta({ id: 'ManualComparisonResource' });

export const ManualComparisonDocument = singleDocument(
  ManualComparisonResource,
).meta({ id: 'ManualComparisonDocument' });

export function toManualComparisonDocument(
  manualId: string,
  comparison: ManualComparison,
): z.infer<typeof ManualComparisonDocument> {
  const side = (manifest: ManualComparison['base']['manifest']) =>
    manifest === undefined || manifest === 'unreadable'
      ? null
      : toManualAttributes(manifest);
  const { change } = comparison;
  return {
    data: {
      type: 'ManualComparison',
      id: `${manualId}/${comparison.base.commit}..${comparison.head.commit}`,
      attributes: {
        base: side(comparison.base.manifest),
        head: side(comparison.head.manifest),
      },
      meta: {
        base: comparison.base.commit,
        head: comparison.head.commit,
        change: change?.change ?? 'unchanged',
        fields: change ? [...change.fields] : [],
        unreadable:
          comparison.base.manifest === 'unreadable' ||
          comparison.head.manifest === 'unreadable',
      },
    },
  };
}
