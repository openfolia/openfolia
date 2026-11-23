import { z } from 'zod';
import { Paged, parseAnswer } from '../api-client.js';
import { RefArgument, ReleasesPage } from '../released.js';
import { languagesAt } from './manuals.js';
import {
  ConfigKey,
  defineTool,
  LocalizedText,
  localizedFields,
  nextPage,
  PageCursor,
  pageOf,
} from './tool.js';

/** A label for a tool's answer: `label`, and `labels` when it is written per language (#731). */
function labelFields(
  label: LocalizedText,
  source: string,
): { label: string; labels?: Record<string, string> } {
  const { text, byLanguage } = localizedFields(label, source);
  return { label: text, ...(byLanguage && { labels: byLanguage }) };
}

/** Items per page of `list_variants` and `list_releases`. */
export const LIST_PAGE_SIZE = 50;

const VariantPage = Paged.extend({
  data: z.array(
    z.looseObject({
      id: z.string(),
      attributes: z.looseObject({
        kind: z.string(),
        label: LocalizedText,
        values: z
          .array(
            z.looseObject({
              id: z.string(),
              label: LocalizedText,
              archived: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
});

export const listVariantsTool = defineTool({
  name: 'list_variants',
  title: 'List the variant attributes',
  description:
    'The configured variant attributes (`GET /variants`), up to 50 per call, in the configured order: each with its `id`, `kind` (`enum`, or `version`: compared numerically, no values) and `label` (in the source language; `labels` gives every language’s when it is written per language), and for an `enum` its `values` (`id`, `label`, `labels`, `archived`). A variant slug (`read_manual`, `read_module`, `get_chunks`) is `<attribute>=<value>` joined by `,`. `nextCursor` gives the next page (null after the last).',
  inputSchema: {
    ref: RefArgument.optional(),
    cursor: PageCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const { body, commit } = await api.get('/variants', {
      ref,
      'page[number]': String(pageOf(args.cursor)),
      'page[size]': String(LIST_PAGE_SIZE),
    });
    const page = parseAnswer(VariantPage, body);
    // The source language is needed only for a label written per language.
    const perLanguage = page.data.some(
      ({ attributes: a }) =>
        typeof a.label !== 'string' ||
        (a.values ?? []).some((v) => typeof v.label !== 'string'),
    );
    const source = perLanguage ? ((await languagesAt(api, ref))[0] ?? '') : '';
    return {
      structured: {
        ref,
        commit: commit ?? null,
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        attributes: page.data.map(({ id, attributes: a }) => ({
          id,
          kind: a.kind,
          ...labelFields(a.label, source),
          ...(a.values && {
            values: a.values.map((v) => ({
              id: v.id,
              ...labelFields(v.label, source),
              archived: v.archived ?? false,
            })),
          }),
        })),
      },
    };
  },
});

export const listReleasesTool = defineTool({
  name: 'list_releases',
  title: 'List the releases',
  description:
    'The releases (`GET /releases`), newest first, up to 50 per call: each with its `tag` (the `ref` other tools take), `product`, `revision`, `publishedAt`, `major`, its release `notes` and `withdrawn` (null, or when and why it was withdrawn: a withdrawn release’s tag is refused as a `ref`). `nextCursor` gives the next page (null after the last).',
  inputSchema: {
    product: ConfigKey.optional().describe(
      'Only releases of this product (a value of the product facet).',
    ),
    cursor: PageCursor.optional(),
  },
  async run({ api }, args) {
    const { body } = await api.get('/releases', {
      'filter[product]': args.product,
      'page[number]': String(pageOf(args.cursor)),
      'page[size]': String(LIST_PAGE_SIZE),
    });
    const page = parseAnswer(ReleasesPage, body);
    return {
      structured: {
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        releases: page.data.map(({ id, attributes: a }) => ({
          id,
          tag: a.tag,
          product: a.product,
          revision: a.revision,
          publishedAt: a.publishedAt,
          major: a.major ?? false,
          notes: a.notes ?? null,
          withdrawn: a.withdrawal
            ? { at: a.withdrawal.at, reason: a.withdrawal.reason }
            : null,
        })),
      },
    };
  },
});
