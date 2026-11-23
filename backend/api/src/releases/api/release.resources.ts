import { ConfigKey, LanguageTag, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { CHANGE_KINDS } from '../../change-sets/core/change-set-diff.js';
import type {
  ChangelogEntry,
  ReleaseChangesPage,
} from '../core/actions/release-changes.action.js';
import {
  type OutputsProgress,
  OUTPUTS_STATES,
  PLAN_REFUSAL_REASONS,
} from '../core/release-output.js';
import {
  MAX_MESSAGE,
  MAX_NOTES,
  MAX_REASON,
  type Release,
  ReleaseNotes,
  ReleaseRevision,
  WithdrawalReason,
} from '../core/release.js';
import type { ReleaseChange } from '../core/release-changes.js';

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });

export const ReleaseAttributes = z
  .object({
    product: z
      .string()
      .describe(
        'The product: a value of `productFacet` (`release.productFacet` in `openfolia.yaml`, else the first facet).',
      ),
    productFacet: z
      .string()
      .describe('The facet the product is a value of, as configured then.'),
    revision: z.string().describe('The product revision, e.g. `2.1`.'),
    tag: z
      .string()
      .describe(
        'The release’s annotated tag (named by `CCMS_RELEASE_TAG`, default `release/{product}/{revision}`): pass it as `?ref=` to read the content as released.',
      ),
    tagObject: z.string().describe('The annotated tag object’s ID.'),
    commit: z
      .string()
      .describe(
        'The commit released: `main`’s head when it was cut, or a maintenance line’s.',
      ),
    notes: z
      .string()
      .nullable()
      .describe(
        'The publisher’s summary (plain text with line breaks); also the tag message’s body. Null when none was given.',
      ),
    notesByLanguage: z
      .record(z.string(), z.string())
      .describe(
        'Summaries per language, by language tag (plain text with line breaks); each also in the tag message, after a line `[notes:<lang>]`. Empty when none were given.',
      ),
    major: z
      .boolean()
      .describe(
        'Marked a major change by its publisher: its readers are told (a notification), and the tag message’s title ends in ` (major)`.',
      ),
    publishedBy: Who.describe('Who cut it.'),
    publishedAt: z.iso
      .datetime({ offset: true })
      .describe('When it was cut: the tag’s date, to the second.'),
    withdrawal: z
      .object({
        by: Who.describe('Who withdrew it.'),
        at: z.iso.datetime({ offset: true }).describe('When.'),
        reason: z.string().describe('Why, in their words.'),
      })
      .nullable()
      .describe(
        'Set once the release is withdrawn: its tag stays readable, but it no longer counts as a module’s latest release. Null while it stands.',
      ),
  })
  .meta({ id: 'ReleaseAttributes' });

export const ReleaseResource = resourceObject('Release', {
  attributes: ReleaseAttributes,
}).meta({ id: 'ReleaseResource' });

export const ReleaseDocument = singleDocument(ReleaseResource).meta({
  id: 'ReleaseDocument',
});

export const ReleasePageDocument = pagedDocument(ReleaseResource).meta({
  id: 'ReleasePageDocument',
});

const count = (what: string) => z.number().int().nonnegative().describe(what);

/** Where a release's outputs stand, for the reader (`GET /releases/{releaseId}`, #456). */
export const ReleaseOutputsProgress = z
  .object({
    state: z
      .enum(OUTPUTS_STATES)
      .describe(
        '`planning`: the outputs are still being planned (there may be none yet); `rendering`: some are queued or rendering; `failed`: none is under way and some failed (or planning failed for good, with none planned: plan them again; or planning was refused: `refused`); `done`: all are done (`total` 0: the release has no outputs you may read, no manuals at its tag, or none you read whole).',
      ),
    total: count(
      'The outputs you may read (`GET /releases/{releaseId}/outputs`).',
    ),
    queued: count('Of those, queued.'),
    rendering: count('Of those, rendering.'),
    done: count('Of those, done.'),
    failed: count('Of those, failed.'),
    refused: z
      .object({
        reason: z
          .enum(PLAN_REFUSAL_REASONS)
          .describe(
            '`too-many-outputs`: the release would have more outputs (every manual at its tag × its variants × the configured languages) than a release may have (`CCMS_RELEASE_MAX_OUTPUTS`), so none were planned. Planning it again (`POST /releases/{releaseId}/outputs/plan`) works once the limit is raised.',
          ),
        wanted: count(
          'The outputs the release would have. Only for one who may plan it again (`release.publish` for its product); null for other readers, as it counts manuals they may not read.',
        ).nullable(),
        max: count(
          'The limit now (`CCMS_RELEASE_MAX_OUTPUTS`), as planning it again is judged. A refusal the limit was raised past is no longer told: the state is then `failed` with `refused` null, until the release is planned again.',
        ),
      })
      .nullable()
      .describe(
        'Why the release’s outputs were not planned (#477); null when they were, or are being planned again.',
      ),
    queue: z
      .object({
        ahead: count(
          'How many outputs of the same product’s releases cut after this one are still to render (queued or rendering): they go first, newest release first. 0 while it is planned and has no queued outputs of its own.',
        ),
        releases: count(
          'While its planning waits (`state` `planning`): how many of the same product’s releases cut before this one are still to be planned (at most the 200 nearest are looked at). Releases are planned strictly in the order they were cut, so these go before it. 0 while it renders.',
        ),
      })
      .nullable()
      .describe(
        'What the release waits for (#497), for one who may plan the release again (`release.publish` for its product), as it counts manuals other readers may not read: while its planning waits, the earlier releases planned first (`releases`); while it renders and some of its outputs are queued, the later releases’ outputs rendered first (`ahead`). Null otherwise (another reader, nothing ahead of it, or a list of releases, which leaves it out).',
      ),
  })
  .meta({ id: 'ReleaseOutputsProgress' });

/** A release as `GET /releases/{releaseId}` reads it: with where its outputs stand. */
export const ReleaseDetailResource = ReleaseResource.extend({
  meta: z.object({
    outputs: ReleaseOutputsProgress.nullable().describe(
      'Where the release’s outputs stand, counted as you may read them (as `GET /releases/{releaseId}/outputs` lists them, so no count tells of one outside your scope). Null when its tag cannot be read.',
    ),
  }),
}).meta({ id: 'ReleaseDetailResource' });

export const ReleaseDetailDocument = singleDocument(ReleaseDetailResource).meta(
  { id: 'ReleaseDetailDocument' },
);

/** `GET /releases`: each release with where its outputs stand, as its own read gives it (#481). */
export const ReleaseListPageDocument = pagedDocument(
  ReleaseDetailResource,
).meta({ id: 'ReleaseListPageDocument' });

export function toReleaseDetailResource(
  release: Release,
  outputs: OutputsProgress | null,
): z.infer<typeof ReleaseDetailResource> {
  return { ...toReleaseResource(release), meta: { outputs } };
}

export function toReleaseResource(
  release: Release,
): z.infer<typeof ReleaseResource> {
  return {
    type: 'Release',
    id: release.id,
    attributes: {
      product: release.product,
      productFacet: release.productFacet,
      revision: release.revision,
      tag: release.tag,
      tagObject: release.tagObject,
      commit: release.commit,
      notes: release.notes,
      notesByLanguage: { ...release.notesByLanguage },
      major: release.major,
      publishedBy: release.publishedBy,
      publishedAt: release.publishedAt.toISOString(),
      withdrawal: release.withdrawal && {
        by: release.withdrawal.by,
        at: release.withdrawal.at.toISOString(),
        reason: release.withdrawal.reason,
      },
    },
  };
}

/** `POST /releases`: the product, the revision and, optionally, notes. */
export const CreateReleaseDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Release'),
      attributes: z.strictObject({
        product: ConfigKey.describe(
          'A value of the product facet (`release.productFacet` in `openfolia.yaml`, else the first facet) at `main`.',
        ),
        revision: ReleaseRevision.describe(
          'The product revision: 1 to 100 characters of `A-Za-z0-9._-`, starting with a letter, digit or `_`, without `..`, not ending in `.` or `.lock`.',
        ),
        notes: ReleaseNotes.nullable()
          .optional()
          .describe(
            `A summary for readers: plain text with line breaks, 1 to ${MAX_NOTES.toLocaleString('en')} characters once trimmed, no line starting with \`---\` and none of the form \`[notes:<lang>]\`, not ending in \`Key: value\` lines.`,
          ),
        notesByLanguage: z
          .record(LanguageTag, ReleaseNotes)
          .refine((notes) => Object.keys(notes).length <= 100, {
            message: 'at most 100 languages',
          })
          .optional()
          .describe(
            `Summaries per language, by a language tag configured in \`openfolia.yaml\` at \`main\` (else 422 \`invalid-language\`), each as \`notes\`. All notes together make at most ${MAX_MESSAGE.toLocaleString('en')} characters.`,
          ),
        major: z
          .boolean()
          .optional()
          .describe(
            'A major change (default false): readers of the manuals it changed are told.',
          ),
        maintenanceLine: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A maintenance line’s ID (#60): cut the release from the head of its branch instead of `main`. The product must be the line’s.',
          ),
      }),
    }),
  })
  .meta({ id: 'CreateReleaseDocument' });
export type CreateReleaseDocument = z.output<typeof CreateReleaseDocument>;

/** Filter parameters of `GET /releases` and `GET /changelog`, validated before any query. */
export const releaseFilters = {
  product: ConfigKey,
  manual: ModuleId,
  lang: LanguageTag,
  major: z
    .enum(['true', 'false'], 'true or false')
    .transform((value) => value === 'true'),
  state: z
    .enum(['published', 'withdrawn'], 'published or withdrawn')
    .transform((value) => value === 'withdrawn'),
};

/** `POST /releases/:releaseId/withdraw`: why (required). */
export const WithdrawReleaseDocument = z
  .strictObject({
    meta: z.strictObject({
      reason: WithdrawalReason.describe(
        `Why the release is withdrawn, shown to every reader with it and recorded in the audit log: plain text with line breaks, 1 to ${MAX_REASON.toLocaleString('en')} characters once trimmed. Required.`,
      ),
    }),
  })
  .meta({ id: 'WithdrawReleaseDocument' });
export type WithdrawReleaseDocument = z.output<typeof WithdrawReleaseDocument>;

const ChangeKind = z.enum(CHANGE_KINDS);

/** A manual in one language that a release changed. */
export const ReleaseChangeResource = resourceObject('ReleaseChange', {
  attributes: z.object({
    manual: z.string().describe('The manual’s ID.'),
    lang: z.string().describe('The language, a language tag.'),
  }),
  meta: z.object({
    change: ChangeKind.describe(
      '`added` (new since the previous release, or every manual of a product’s first release), `removed`, or `changed` (its manifest, or a module it names in this language).',
    ),
    fields: z
      .array(z.string())
      .describe(
        'The manifest’s members that differ (`title`, `entries`, `variants`, …); empty unless `changed`.',
      ),
    modules: z
      .array(
        z.object({
          moduleId: z.string(),
          change: ChangeKind,
          fields: z
            .array(z.string())
            .describe(
              'Its metadata that differs (`title`, `type`, `audience`, …); empty when added or removed.',
            ),
          blocks: z
            .array(z.object({ blockId: z.string(), change: ChangeKind }))
            .describe(
              'Its blocks, list items and procedure steps that differ, by ID (as a change set’s changes list them).',
            ),
        }),
      )
      .describe(
        'The modules the manual names (in either release) whose file in this language changed, by ID; empty unless `changed`.',
      ),
  }),
})
  .describe(
    '`id` is `<lang>/<manualId>`. Derived from Git, as the reader sees both releases: nothing of it is stored.',
  )
  .meta({ id: 'ReleaseChangeResource' });

const PreviousRelease = z
  .object({
    id: z.string(),
    revision: z.string(),
    tag: z.string(),
    commit: z.string(),
  })
  .nullable()
  .describe(
    'The release the changes are counted from: the product’s newest release before this one that is not withdrawn. Null for the product’s first.',
  );

export const ReleaseChangePageDocument = z
  .object({
    data: z.array(ReleaseChangeResource),
    meta: z.object({ page: PageMeta, previous: PreviousRelease }),
    links: PageLinks,
  })
  .meta({ id: 'ReleaseChangePageDocument' });

export function toReleaseChangeResource(
  change: ReleaseChange,
): z.infer<typeof ReleaseChangeResource> {
  return {
    type: 'ReleaseChange',
    id: `${change.lang}/${change.manualId}`,
    attributes: { manual: change.manualId, lang: change.lang },
    meta: {
      change: change.change,
      fields: [...change.fields],
      modules: change.modules.map((m) => ({
        moduleId: m.moduleId,
        change: m.change,
        fields: [...m.fields],
        blocks: m.blocks.map((b) => ({ ...b })),
      })),
    },
  };
}

export function toPreviousRelease(
  previous: ReleaseChangesPage['previous'],
): z.infer<typeof PreviousRelease> {
  return (
    previous && {
      id: previous.id,
      revision: previous.revision,
      tag: previous.tag,
      commit: previous.commit,
    }
  );
}

/** A release in the changelog: the release, with how many manuals it changed. */
export const ChangelogEntryResource = ReleaseResource.extend({
  meta: z.object({
    changedManuals: z
      .number()
      .int()
      .nullable()
      .describe(
        'How many manuals it changed, as you see them (`GET /releases/{releaseId}/changes`); null when too many files changed to compare.',
      ),
  }),
}).meta({ id: 'ChangelogEntryResource' });

export const ChangelogPageDocument = z
  .object({
    data: z.array(ChangelogEntryResource),
    meta: z.object({
      page: PageMeta,
      truncated: z
        .boolean()
        .describe(
          'Filtered by manual or language, only the newest releases matching the other filters are looked through; true when there were more.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'ChangelogPageDocument' });

export function toChangelogEntryResource(
  entry: ChangelogEntry,
): z.infer<typeof ChangelogEntryResource> {
  return {
    ...toReleaseResource(entry.release),
    meta: { changedManuals: entry.changedManuals },
  };
}
