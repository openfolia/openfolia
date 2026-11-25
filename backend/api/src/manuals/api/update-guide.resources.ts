import { Block, Condition, UPDATE_PHASES } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { ResolveIssue } from '../../base/api/schemas.js';
import type {
  UpdateGuideStepView,
  UpdateGuideView,
} from '../core/actions/get-update-guide.action.js';

const Label = z
  .object({
    id: z.string(),
    label: z
      .string()
      .describe('In the guide’s language, else the source language’s.'),
  })
  .meta({ id: 'UpdateGuideLabel' });

export const UpdateGuideResource = resourceObject('UpdateGuide', {
  attributes: z.object({
    title: z.string(),
    lang: z.string(),
    attribute: Label.describe(
      'The version attribute the guide follows (`guide.attribute`), e.g. `{ "id": "software", "label": "Software" }`.',
    ),
    versions: z
      .array(z.string())
      .describe(
        'The versions a reader picks from and to, oldest first. A step applies to a jump from `from` to `to` when `from < version <= to`, compared numerically (`2.10` is after `2.9`).',
      ),
    levels: z
      .array(Label)
      .describe(
        'The levels a reader picks from: the configured audience levels up to the guide’s audience, least restricted first. A step with a `level` is for that level and the more restricted ones.',
      ),
    options: z
      .array(Label.extend({ values: z.array(Label) }))
      .describe(
        'The options the steps’ conditions test: each an enum variant attribute with its values. A condition on an option the reader has not set is false.',
      ),
  }),
  relationships: z.object({ manual: toOne('Manual') }),
  meta: z.object({
    stepCount: z
      .number()
      .int()
      .min(0)
      .describe('How many steps the reader may see (`…/steps` lists them).'),
    issues: z.array(ResolveIssue),
  }),
})
  .describe('`id` is `<manual>/<lang>`, as in the URL.')
  .meta({ id: 'UpdateGuideResource' });

export const UpdateGuideDocument = singleDocument(UpdateGuideResource).meta({
  id: 'UpdateGuideDocument',
});

export const UpdateGuideStepResource = resourceObject('UpdateGuideStep', {
  attributes: z.object({
    module: z.string().describe('The module holding the step’s text.'),
    title: z.string(),
    lang: z
      .string()
      .describe('Differs from the guide when a translation is missing.'),
    version: z.string().describe('The release that needs the step.'),
    phase: z
      .enum(UPDATE_PHASES)
      .describe('`before`, `during` or `after` the update.'),
    level: z
      .string()
      .nullable()
      .describe(
        'The least restricted level the step is for (an audience ID); null: every level.',
      ),
    when: Condition.nullable().describe(
      'The condition on the reader’s options; null: every setup.',
    ),
    condition: z
      .string()
      .nullable()
      .describe('`when` as written in the manifest, e.g. `cluster in (yes)`.'),
    blocks: z
      .array(Block)
      .describe(
        'The step’s body, resolved as in a resolved manual (IDs `module--block`), for the guide’s first variant.',
      ),
  }),
})
  .describe(
    '`id` is the step’s module ID, with `--2`, `--3`, … for its later steps in the guide; stable while the guide’s steps are not reordered.',
  )
  .meta({ id: 'UpdateGuideStepResource' });

export const UpdateGuideStepPageDocument = pagedDocument(
  UpdateGuideStepResource,
).meta({ id: 'UpdateGuideStepPageDocument' });

export function toUpdateGuideResource(
  view: UpdateGuideView,
): z.infer<typeof UpdateGuideResource> {
  return {
    type: 'UpdateGuide',
    id: `${view.id}/${view.lang}`,
    attributes: {
      title: view.title,
      lang: view.lang,
      attribute: view.attribute,
      versions: view.versions,
      levels: view.levels,
      options: view.options,
    },
    relationships: { manual: { data: { type: 'Manual', id: view.id } } },
    meta: { stepCount: view.steps.length, issues: view.issues },
  };
}

export function toUpdateGuideStepResource({
  id,
  ...attributes
}: UpdateGuideStepView): z.infer<typeof UpdateGuideStepResource> {
  return { type: 'UpdateGuideStep', id, attributes };
}
