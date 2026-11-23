import { z } from 'zod';
import {
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import type { ModuleReferences } from '../core/actions/get-module-references.action.js';
import type { ModuleRenameOutcome } from '../core/actions/rename-module.action.js';
import { LockSubject } from '../core/lock.js';

/**
 * An ID as the client sends it: checked by the action, so one that is no
 * module ID is 422 `invalid-id`, not a malformed body.
 */
const SentId = (describe: string) => z.string().max(1000).describe(describe);

/** `POST /change-sets/{id}/module-renames`: which module, and its new ID. */
export const CreateModuleRenameDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ModuleRename'),
      attributes: z.strictObject({
        from: SentId('The module’s ID now.'),
        to: SentId(
          'Its new ID: a lowercase slug (`a-z`, `0-9`, single hyphens) of at most 100 characters, no module’s yet.',
        ),
      }),
    }),
  })
  .meta({ id: 'CreateModuleRenameDocument' });
export type CreateModuleRenameDocument = z.output<
  typeof CreateModuleRenameDocument
>;

const Subjects = (describe: string) => z.array(LockSubject).describe(describe);

/** A module renamed in a change set: its commit. */
export const ModuleRenameResource = resourceObject('ModuleRename', {
  attributes: z.object({
    from: z.string(),
    to: z.string(),
    branch: z.string().describe('The change set’s branch.'),
    parent: z.string().describe('The branch head the commit was made on.'),
    message: z.string(),
    languages: z
      .array(z.string())
      .describe('The languages the module was moved in.'),
    rewritten: Subjects(
      'The other modules (per language) and the manuals rewritten to name the new ID.',
    ),
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
  meta: z.object({
    comments: z
      .number()
      .int()
      .describe('How many of the change set’s comments moved to the new ID.'),
  }),
})
  .describe('`id` is the rename’s commit.')
  .meta({ id: 'ModuleRenameResource' });

/** `POST /change-sets/{id}/module-renames`, 201. */
export const ModuleRenameDocument = singleDocument(ModuleRenameResource).meta({
  id: 'ModuleRenameDocument',
});

export function toModuleRenameDocument(
  outcome: ModuleRenameOutcome,
): z.infer<typeof ModuleRenameDocument> {
  return {
    data: {
      type: 'ModuleRename',
      id: outcome.commit,
      attributes: {
        from: outcome.from,
        to: outcome.to,
        branch: outcome.branch,
        parent: outcome.parent,
        message: outcome.message,
        languages: [...outcome.languages],
        rewritten: [...outcome.rewritten],
      },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: outcome.changeSetId } },
      },
      meta: { comments: outcome.comments },
    },
  };
}

/** What renaming a module would touch at the change set's branch head. */
export const ModuleReferencesResource = resourceObject('ModuleReferences', {
  attributes: z.object({
    languages: z
      .array(z.string())
      .describe('The languages the module has a file in.'),
    references: Subjects(
      'The other modules (per language) and the manuals whose module references, cross-references or entries name it, and the other modules deprecated in favour of it (their `replacedBy`): a rename rewrites them (one commit changes at most 1,000 files, so a rename of a module named in more is refused).',
    ),
    translations: Subjects(
      'The modules, each in a target language, whose translation records the rename brings up to date (a cross-reference rewritten changes the source hash of its block): it needs their locks too.',
    ),
  }),
  meta: z.object({
    head: z.string().describe('The branch head this was worked out at.'),
    workingCopies: Subjects(
      'The module’s languages, the references and the translations above that have a working copy in the change set: a rename refuses them until they are committed or discarded.',
    ),
  }),
})
  .describe('`id` is the module’s ID.')
  .meta({ id: 'ModuleReferencesResource' });

/** `GET /change-sets/{id}/module-references/{moduleId}`. */
export const ModuleReferencesDocument = singleDocument(
  ModuleReferencesResource,
).meta({ id: 'ModuleReferencesDocument' });

export function toModuleReferencesDocument(
  found: ModuleReferences,
): z.infer<typeof ModuleReferencesDocument> {
  return {
    data: {
      type: 'ModuleReferences',
      id: found.moduleId,
      attributes: {
        languages: [...found.languages],
        references: [...found.references],
        translations: [...found.translations],
      },
      meta: { head: found.head, workingCopies: [...found.workingCopies] },
    },
  };
}
