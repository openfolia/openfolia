import { defineDocs } from 'fumadocs-mdx/macro';
import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { i18n } from './i18n';

/**
 * A user guide page's article ID (#447): the editor's in-app help links to a page by it, not by
 * its path, so a page can move without breaking a link (`/guide-index.json`).
 */
export const ArticleId = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    'a lowercase ID, e.g. "writing.edit-a-module"',
  );

const page = pageSchema.extend({
  articleId: ArticleId.optional(),
  /** Planned: a page that marks a stable address another issue fills (its number). */
  planned: z.number().int().positive().optional(),
});

/** The hand-written pages (`content/docs`). */
const written = defineDocs({
  dir: 'content/docs',
  docs: { schema: page, postprocess: { includeProcessedMarkdown: true } },
  meta: { schema: metaSchema },
});

/** The references made from the repository (`generated/content`, `scripts/generate.mjs`). */
const references = defineDocs({
  dir: 'generated/content',
  docs: { schema: page, postprocess: { includeProcessedMarkdown: true } },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: '/',
  i18n,
  source: {
    written: written.toFumadocsSource(),
    references: references.toFumadocsSource(),
  },
});

export type DocsPage = NonNullable<ReturnType<typeof source.getPage>>;

/** An operation page of the API reference (one per operation, generated). */
export const isOperationPage = (page: { data: { _openapi?: unknown } }) =>
  page.data._openapi !== undefined;
