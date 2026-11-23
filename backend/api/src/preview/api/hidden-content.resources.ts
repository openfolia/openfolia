import { Condition, formatCondition } from '@openfolia/content-model';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toPagedDocument,
} from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import type { HiddenPage } from '../core/actions/list-hidden-content.action.js';
import { LABEL_LENGTH, type HiddenItem } from '../core/hidden-content.js';

export const HiddenContentResource = resourceObject('HiddenContent', {
  attributes: z.object({
    kind: z
      .enum(['block', 'module', 'group'])
      .describe(
        '`block`: a variant block of a module; `module`: a module entry of the manual; `group`: a group of the manual, with everything in it.',
      ),
    module: z
      .string()
      .nullable()
      .describe(
        'The module the block is in, or the module entry; null for a group.',
      ),
    blockId: z
      .string()
      .nullable()
      .describe(
        'The variant block’s own ID in its module; null unless `kind` is `block`.',
      ),
    // The shared `Condition` schema as it is (a description would make a copy without its name).
    condition: Condition,
  }),
  meta: z.object({
    label: z
      .string()
      .describe(
        `How a person recognises it, as plain text (never markup): a block’s first text, at most ${LABEL_LENGTH} characters, or a module’s or group’s title. Empty when a block holds no text.`,
      ),
    expression: z
      .string()
      .describe(
        'The condition as people read and write it (`model in (large) && software >= 2.3`).',
      ),
  }),
})
  .describe(
    'Content the conditions leave out for the variant: derived on every request, never stored.',
  )
  .meta({ id: 'HiddenContentResource' });

export const HiddenContentPageDocument = z
  .object({
    data: z.array(HiddenContentResource),
    meta: z.object({
      page: PageMeta,
      commit: z.string().describe('The commit read.'),
    }),
    links: PageLinks,
  })
  .meta({ id: 'HiddenContentPageDocument' });

function idOf(item: HiddenItem, index: number): string {
  switch (item.kind) {
    case 'block':
      return `block:${item.module ?? ''}#${item.block ?? ''}`;
    case 'module':
      return `module:${item.module ?? ''}`;
    case 'group':
      // Groups have no ID of their own: their place among what is hidden.
      return `group:${index}`;
    default:
      return item.kind satisfies never;
  }
}

export function toHiddenContentPageDocument(
  req: Request,
  page: PageRequest,
  result: HiddenPage,
): z.infer<typeof HiddenContentPageDocument> {
  const offset = (page.number - 1) * page.size;
  let index = offset;
  const document = toPagedDocument(
    req,
    page,
    result,
    (item): z.infer<typeof HiddenContentResource> => ({
      type: 'HiddenContent',
      id: idOf(item, index++),
      attributes: {
        kind: item.kind,
        module: item.module ?? null,
        blockId: item.block ?? null,
        condition: item.when,
      },
      meta: { label: item.label, expression: formatCondition(item.when) },
    }),
  );
  return { ...document, meta: { ...document.meta, commit: result.commit } };
}
