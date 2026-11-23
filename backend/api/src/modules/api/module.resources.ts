import {
  Deprecation,
  LanguageTag,
  Module,
  ModuleId,
  ModuleMeta,
  type Issue as IssueValue,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { Issue } from '../../base/api/schemas.js';
import { ChangeSetState } from '../../change-sets/core/change-set.js';
import type { ModuleStatus as ModuleStatusValue } from '../core/actions/get-module-statuses.action.js';
import type { ModuleListEntry } from '../core/actions/list-modules.action.js';
import {
  MAX_USED_IN,
  type ModuleUsage as ModuleUsageValue,
} from '../core/readable-module-index.js';

/**
 * A module file, flattened: JSON:API reserves `id` and `type`, so the
 * module's own ID and type are `moduleId` and `moduleType`.
 */
export const ModuleAttributes = z
  .object({
    moduleId: ModuleId,
    lang: LanguageTag,
    schemaVersion: Module.shape.schemaVersion,
    title: ModuleMeta.shape.title,
    moduleType: ModuleMeta.shape.type.describe(
      'One of the configured module types, e.g. `procedure`.',
    ),
    audience: ModuleMeta.shape.audience,
    facets: ModuleMeta.shape.facets,
    keywords: ModuleMeta.shape.keywords.describe(
      'Free-form keywords in the module’s language; absent when there are none.',
    ),
    source: ModuleMeta.shape.source,
    deprecated: ModuleMeta.shape.deprecated.describe(
      'This file’s deprecation, as stored (#266): absent when it has none. The module’s own is its source-language file’s (`meta.status.deprecated`).',
    ),
    blocks: Module.shape.blocks,
  })
  .meta({ id: 'ModuleAttributes' });

const Commit = z.string().describe('A commit ID.');

export const ModuleStatus = z
  .object({
    release: z
      .object({
        tag: z.string().describe('The release tag.'),
        commit: Commit,
        same: z
          .boolean()
          .describe('Whether the module there is exactly the one read.'),
      })
      .nullable()
      .describe(
        'The newest release (tag) holding the module as the reader may see it there; null when none of the 50 newest does.',
      ),
    main: z
      .object({
        commit: Commit,
        same: z
          .boolean()
          .describe('Whether the module there is exactly the one read.'),
      })
      .nullable()
      .describe(
        'The module on `main` (approved content), as the reader may see it there; null when it is not there.',
      ),
    changeSets: z
      .array(
        z.object({
          id: z.string().describe('The change set’s ID.'),
          state: ChangeSetState.exclude(['merged', 'abandoned']),
        }),
      )
      .optional()
      .describe(
        'The open change sets (draft, in review or approved) changing the module, newest first: only those the reader may read (all of them with `content.read.draft`, else their own), and only where the reader may see the module on the change set’s head or base. Left out for a reader who holds neither `content.read.draft` nor `content.edit` (a consumer of released content).',
      ),
    deprecated: Deprecation.nullable().describe(
      'The module’s deprecation at the ref read (#266), with its reason and replacement: its source-language file’s as the reader may see it (else this file’s own); null when it is not deprecated. Read on `main`, it says what was merged.',
    ),
  })
  .describe(
    'Where the module stands, derived from Git (never stored): released, on `main`, in change sets, deprecated.',
  )
  .meta({ id: 'ModuleStatus' });

export const ModuleUse = z
  .object({
    kind: z
      .enum(['manual', 'module'])
      .describe('A manual including the module, or a module referring to it.'),
    id: z.string().describe('The manual’s or the module’s ID.'),
    title: z
      .string()
      .describe(
        'Its title (a module’s in the source language, else in its first language).',
      ),
    direct: z
      .boolean()
      .describe(
        'A manual: true when one of its entries names the module, false when it includes it only through module references. A module: always true.',
      ),
    deprecated: z
      .boolean()
      .describe(
        'Whether the manual or module using it is deprecated (#266), from the module index: a manual by its manifest, a module by its source-language file.',
      ),
  })
  .meta({ id: 'ModuleUse' });

export const ModuleUsage = z
  .object({
    manuals: z
      .number()
      .int()
      .describe(
        'The manuals including the module, directly or through module references.',
      ),
    modules: z
      .number()
      .int()
      .describe('The modules whose module reference blocks name it.'),
  })
  .describe(
    'How many manuals and modules use the module (by ID, in any language), from the module index; only what the reader may see counts.',
  )
  .meta({ id: 'ModuleUsage' });

export const ModuleResource = resourceObject('Module', {
  attributes: ModuleAttributes,
  meta: z.object({
    issues: z
      .array(Issue)
      .describe('Problems found checking it against the configuration.'),
    status: ModuleStatus,
    usage: ModuleUsage,
    usedIn: z
      .array(ModuleUse)
      .max(MAX_USED_IN)
      .describe(
        `Where the module is used (FR-19): manuals first, then modules, each by title; at most ${MAX_USED_IN} (\`usage\` counts them all). Only manuals and modules the reader may see are named, and a manual counts through module references only where the reader may see every module on the way.`,
      ),
  }),
})
  .describe('`id` is `<lang>/<moduleId>`, as in the URL.')
  .meta({ id: 'ModuleResource' });

/** A module file that cannot be read; listed so it does not hide the others. */
export const UnreadableModuleResource = resourceObject('Module', {
  attributes: z.object({ moduleId: z.string(), lang: z.string() }),
  meta: z.object({ error: z.string().describe('Why it cannot be read.') }),
}).meta({ id: 'UnreadableModuleResource' });

export const ModuleDocument = singleDocument(ModuleResource).meta({
  id: 'ModuleDocument',
});

export const ModulePageDocument = pagedDocument(
  z.union([ModuleResource, UnreadableModuleResource]),
).meta({ id: 'ModulePageDocument' });

/** A module file as `ModuleAttributes`. */
export function toModuleAttributes(
  module: Module,
): z.infer<typeof ModuleAttributes> {
  const { meta } = module;
  return {
    moduleId: module.id,
    lang: meta.lang,
    schemaVersion: module.schemaVersion,
    title: meta.title,
    moduleType: meta.type,
    ...(meta.audience === undefined ? {} : { audience: meta.audience }),
    facets: meta.facets,
    ...(meta.keywords?.length ? { keywords: meta.keywords } : {}),
    ...(meta.source === undefined ? {} : { source: meta.source }),
    ...(meta.deprecated === undefined ? {} : { deprecated: meta.deprecated }),
    blocks: module.blocks,
  };
}

export function toModuleResource(
  module: Module,
  issues: IssueValue[],
  status: ModuleStatusValue,
  usage: ModuleUsageValue,
): z.infer<typeof ModuleResource> {
  return {
    type: 'Module',
    id: `${module.meta.lang}/${module.id}`,
    attributes: toModuleAttributes(module),
    meta: {
      issues,
      status: {
        release: status.release,
        main: status.main,
        deprecated: status.deprecated,
        ...(status.changeSets && {
          changeSets: status.changeSets.map(({ id, state }) => ({
            id,
            state: state as 'draft' | 'in-review' | 'approved',
          })),
        }),
      },
      usage: { manuals: usage.manuals, modules: usage.modules },
      usedIn: usage.uses.slice(0, MAX_USED_IN).map((use) => ({ ...use })),
    },
  };
}

export function toModuleListResource(
  entry: ModuleListEntry,
): z.infer<typeof ModulePageDocument>['data'][number] {
  if ('error' in entry) {
    return {
      type: 'Module',
      id: `${entry.lang}/${entry.id}`,
      attributes: { moduleId: entry.id, lang: entry.lang },
      meta: { error: entry.error },
    };
  }
  return toModuleResource(
    entry.module,
    entry.issues,
    entry.status,
    entry.usage,
  );
}
