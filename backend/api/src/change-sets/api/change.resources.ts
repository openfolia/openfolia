import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toOne,
} from '../../base/api/json-api.js';
import { CHANGE_KINDS, type SubjectChange } from '../core/change-set-diff.js';
import { subjectName } from '../core/lock.js';
import { SubjectSchema } from './lock.resources.js';

const ChangeKind = z.enum(CHANGE_KINDS);

/** A module, manual, term or the configuration a change set changes, compared with its base. */
export const ChangeSetChangeResource = resourceObject('ChangeSetChange', {
  attributes: z.object({
    subject: SubjectSchema,
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
  meta: z.object({
    change: ChangeKind.describe(
      '`added`, `changed` or `removed`, as the reader sees each side: one they may not see on a side is not there, exactly like a missing one.',
    ),
    fields: z
      .array(z.string())
      .describe(
        'What differs besides the blocks: the module’s metadata (`title`, `type`, `audience`, `facets`, `source`, …), the manifest’s members (`title`, `entries`, `variants`, …), the configuration’s members (an item of a list with IDs as `<member>/<id>`, e.g. `variantAttributes/model`; the member alone when only the order changed; `languages`, `outputLabels`, `maxHeadingLevel` by name) or the term’s (`status`, `domain`, a language as `languages/<lang>`). Empty when added, removed or unreadable.',
      ),
    blocks: z
      .array(
        z.object({
          blockId: z.string(),
          change: ChangeKind,
        }),
      )
      .describe(
        'A module’s blocks, list items and procedure steps that differ, by ID: `changed` when its own content (not that of the blocks with IDs inside it) or its parent differs. Unchanged blocks keep their IDs and are not listed. In the head’s order, then the removed ones. Empty for a manual and when added, removed or unreadable.',
      ),
    unreadable: z
      .boolean()
      .describe(
        'A side has a file that cannot be read (for a module or manual, shown only to a reader of all of its language, or of every audience).',
      ),
  }),
})
  .describe(
    '`id` is `module/<lang>/<moduleId>`, `manual/<manualId>`, `config` (`openfolia.yaml`) or `term/<termId>`. Derived from Git: nothing of it is stored.',
  )
  .meta({ id: 'ChangeSetChangeResource' });

export const ChangeSetChangePageDocument = z
  .object({
    data: z.array(ChangeSetChangeResource),
    meta: z.object({
      page: PageMeta,
      base: z.string().describe('The change set’s base commit.'),
      head: z
        .string()
        .describe(
          'The commit compared with it: the review head once submitted, else the branch’s head.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'ChangeSetChangePageDocument' });

export function toChangeSetChangeResource(
  changeSetId: string,
): (change: SubjectChange) => z.infer<typeof ChangeSetChangeResource> {
  return (change) => {
    return {
      type: 'ChangeSetChange',
      id: subjectName(change.subject),
      attributes: { subject: change.subject },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: changeSetId } },
      },
      meta: {
        change: change.change,
        fields: [...change.fields],
        blocks: change.blocks.map((b) => ({ ...b })),
        unreadable: change.unreadable,
      },
    };
  };
}
