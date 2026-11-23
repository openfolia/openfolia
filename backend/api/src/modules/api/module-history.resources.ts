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
import type {
  ModuleHistoryEntry,
  ModuleHistoryPage,
} from '../core/actions/get-module-history.action.js';
import type { ModuleComparison } from '../core/actions/compare-module-versions.action.js';
import { ModuleAttributes, toModuleAttributes } from './module.resources.js';

const Commit = z.string().describe('A commit ID.');
const ActorRef = z.object({
  kind: z.enum(['user', 'service']),
  id: z.string(),
});
const ChangeKind = z.enum(CHANGE_KINDS);

/** `{ data: { type, id } | null }`: a to-one relationship that may be empty. */
const toOneOrNone = <T extends string>(type: T) =>
  z.object({
    data: z.object({ type: z.literal(type), id: z.string() }).nullable(),
  });

/**
 * What a version holds, of a module (`ModuleVersion`) or a manual
 * (`ManualVersion`): a commit on the ref's first-parent line that changed
 * its file.
 */
export const VERSION_MEMBERS = {
  attributes: z.object({
    commit: Commit,
    committedAt: z
      .string()
      .describe('When it was committed (ISO 8601, the committer’s offset).'),
    message: z
      .string()
      .describe(
        'The commit message without its trailers: for a merge, the change set’s title and a line naming it.',
      ),
    merge: z
      .boolean()
      .describe('Whether it is a merge (a change set merged into the ref).'),
    actor: ActorRef.nullable().describe(
      'Who made it, as the commit’s trailers claim (`Merged-by`, else `Actor` for a save point); null when they name no one. Recorded by the server for the commits it makes, but a commit pushed from outside can claim anything.',
    ),
    approvedBy: z
      .array(ActorRef)
      .describe(
        'Who approved it, as its `Approved-by` trailers claim, in order: the approvers of a merged change set.',
      ),
  }),
  relationships: z.object({
    actor: toOneOrNone('User').describe(
      '`actor` when it is a user the server knows; else empty.',
    ),
    changeSet: toOneOrNone('ChangeSet').describe(
      'The change set it came from (`Merged-change-set`, else `Change-set`); empty when its trailers name none.',
    ),
    approvers: z
      .object({
        data: z.array(z.object({ type: z.literal('User'), id: z.string() })),
      })
      .describe('The users among `approvedBy` the server knows.'),
  }),
  meta: z.object({
    revision: z
      .number()
      .int()
      .nullable()
      .describe(
        'The version’s number, counted from the oldest (1): derived, never stored. Null when the history was cut (`meta.truncated` on the document) while the module already existed before the oldest commit looked at, as the count would not start at the first.',
      ),
    change: ChangeKind.describe(
      'How the module as the reader sees it differs from the version before: `added` (also back after a removal), `changed`, `removed` (deleted, or moved out of the reader’s scope).',
    ),
    releases: z
      .array(z.object({ tag: z.string(), commit: Commit }))
      .describe(
        'The release tags (of the 50 newest) whose commit holds exactly this file, as the reader may see it there; newest first.',
      ),
    unreadable: z
      .boolean()
      .describe(
        'The file after this commit cannot be read (shown only to a reader of all of its language).',
      ),
  }),
};

/** A version of a module: a commit on the ref's first-parent line that changed it. */
export const ModuleVersionResource = resourceObject(
  'ModuleVersion',
  VERSION_MEMBERS,
)
  .describe(
    '`id` is `<lang>/<moduleId>/<commit>`. Derived from Git: nothing of it is stored by the server.',
  )
  .meta({ id: 'ModuleVersionResource' });

export const ModuleVersionPageDocument = z
  .object({
    data: z.array(ModuleVersionResource),
    meta: z.object({
      page: PageMeta,
      truncated: z
        .boolean()
        .describe(
          'The ref’s first-parent line goes on past the 1,000 newest commits looked at: older versions are not listed, and, when the module existed before them, versions carry no revision number.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'ModuleVersionPageDocument' });

export function toModuleVersionPageDocument(
  req: Request,
  page: PageRequest,
  lang: string,
  moduleId: string,
  result: ModuleHistoryPage,
): z.infer<typeof ModuleVersionPageDocument> {
  const document = toPagedDocument(req, page, result, (entry) =>
    toModuleVersionResource(lang, moduleId, entry),
  );
  return {
    ...document,
    meta: { ...document.meta, truncated: result.truncated },
  };
}

function toModuleVersionResource(
  lang: string,
  moduleId: string,
  entry: ModuleHistoryEntry,
): z.infer<typeof ModuleVersionResource> {
  return {
    type: 'ModuleVersion',
    id: `${lang}/${moduleId}/${entry.commit}`,
    ...toVersionMembers(entry),
  };
}

/** A version's members (`VERSION_MEMBERS`), of a module or a manual. */
export function toVersionMembers(
  entry: ModuleHistoryEntry,
): Omit<z.infer<typeof ModuleVersionResource>, 'type' | 'id'> {
  return {
    attributes: {
      commit: entry.commit,
      committedAt: entry.committedAt,
      message: entry.message,
      merge: entry.parents > 1,
      actor: entry.actor ? { ...entry.actor } : null,
      approvedBy: entry.approvedBy.map((a) => ({ ...a })),
    },
    relationships: {
      actor: {
        data:
          entry.actorKnown && entry.actor
            ? { type: 'User', id: entry.actor.id }
            : null,
      },
      changeSet: {
        data: entry.changeSetId
          ? { type: 'ChangeSet', id: entry.changeSetId }
          : null,
      },
      approvers: {
        data: entry.knownApprovers.map((id) => ({ type: 'User', id })),
      },
    },
    meta: {
      revision: entry.revision ?? null,
      change: entry.change,
      releases: entry.releases.map((r) => ({ ...r })),
      unreadable: entry.unreadable,
    },
  };
}

/** A module at two versions, and how it changed between them. */
export const ModuleComparisonResource = resourceObject('ModuleComparison', {
  attributes: z.object({
    base: ModuleAttributes.nullable().describe(
      'The module at `base`, as the reader sees it on both sides; null when it is not there (or cannot be read: `meta.unreadable`).',
    ),
    head: ModuleAttributes.nullable().describe(
      'The module at `head`, likewise.',
    ),
  }),
  meta: z.object({
    base: Commit.describe('The commit `base` named.'),
    head: Commit.describe('The commit `head` named.'),
    change: z
      .enum([...CHANGE_KINDS, 'unchanged'])
      .describe(
        '`added` (not there at `base`), `removed` (not there at `head`), `changed`, or `unchanged` (the same module on both sides).',
      ),
    fields: z
      .array(z.string())
      .describe(
        'The module’s metadata fields that differ (`title`, `type`, `audience`, …), as in a change set’s changes. Empty unless changed.',
      ),
    blocks: z
      .array(z.object({ blockId: z.string(), change: ChangeKind }))
      .describe(
        'The blocks, list items and procedure steps that differ, by ID, exactly as in a change set’s changes: in the head’s order, then the removed ones. Empty unless changed.',
      ),
    unreadable: z
      .boolean()
      .describe(
        'A side has a file that cannot be read (shown only to a reader of all of its language).',
      ),
  }),
})
  .describe(
    '`id` is `<lang>/<moduleId>/<base commit>..<head commit>`. Derived from Git, never stored.',
  )
  .meta({ id: 'ModuleComparisonResource' });

export const ModuleComparisonDocument = singleDocument(
  ModuleComparisonResource,
).meta({ id: 'ModuleComparisonDocument' });

export function toModuleComparisonDocument(
  lang: string,
  moduleId: string,
  comparison: ModuleComparison,
): z.infer<typeof ModuleComparisonDocument> {
  const side = (module: ModuleComparison['base']['module']) =>
    module === undefined || module === 'unreadable'
      ? null
      : toModuleAttributes(module);
  const { change } = comparison;
  const unreadable =
    comparison.base.module === 'unreadable' ||
    comparison.head.module === 'unreadable';
  return {
    data: {
      type: 'ModuleComparison',
      id: `${lang}/${moduleId}/${comparison.base.commit}..${comparison.head.commit}`,
      attributes: {
        base: side(comparison.base.module),
        head: side(comparison.head.module),
      },
      meta: {
        base: comparison.base.commit,
        head: comparison.head.commit,
        change: change?.change ?? 'unchanged',
        fields: change ? [...change.fields] : [],
        blocks: change ? change.blocks.map((b) => ({ ...b })) : [],
        unreadable,
      },
    },
  };
}
