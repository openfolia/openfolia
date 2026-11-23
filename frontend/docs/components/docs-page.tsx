import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { Callout } from 'fumadocs-ui/components/callout';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getMDXComponents } from './mdx';
import { OpenAPIPage } from './api-page';
import { isOperationPage, source } from '@/lib/source';
import { openapi } from '@/lib/openapi';
import type { Lang } from '@/lib/i18n';
import { t } from '@/lib/translations';
import { pagesOf } from '@/lib/tree';
import { FEED_PATH } from '../scripts/lib/changelog.mjs';
import { markdownPath } from '@/lib/markdown-pages';
import { siteUrl } from '@/lib/llms';
import type { ComponentProps } from 'react';

function pageOf(lang: Lang, slug: string[] | undefined) {
  const page = source.getPage(slug, lang);
  if (!page || (lang !== 'en' && isOperationPage(page))) notFound();
  return page;
}

/** A page of the site in a language (the routes `app/(en)/…` and `app/de/…`). */
export async function DocsRoute({
  lang,
  slug,
}: {
  lang: Lang;
  slug?: string[];
}) {
  const page = pageOf(lang, slug);
  const MDX = page.data.body;
  // A page without a German file is the English one under `/de/` (the storage inherits it): the
  // same data, so it says it is in English.
  const english =
    lang !== 'en' && source.getPage(slug, 'en')?.data === page.data;
  const operation = isOperationPage(page);
  const generated =
    page.path.startsWith('reference/') || page.path.startsWith('api/');
  const preloaded = operation
    ? await openapi.preloadOpenAPIPage(page)
    : undefined;
  const markdown = markdownPath(page.url);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {/* An operation's description is Markdown: its page renders it (`showDescription`). */}
      {!operation && (
        <DocsDescription className="mb-0">
          {page.data.description}
        </DocsDescription>
      )}
      {/* The page as Markdown, to copy or to hand to an assistant (#423). */}
      <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-4">
        <MarkdownCopyButton markdownUrl={markdown} />
        <ViewOptionsPopover
          markdownUrl={markdown}
          pageUrl={`${siteUrl}${markdown}`}
        />
      </div>
      {page.data.planned !== undefined && (
        <Callout type="info" title={t(lang, 'planned')}>
          {t(lang, 'plannedText')} #{page.data.planned}.
        </Callout>
      )}
      {english && (
        <Callout type="info">
          {t(lang, generated ? 'referenceEnglish' : 'englishOnly')}
        </Callout>
      )}
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            OpenAPIPage: (props: ComponentProps<typeof OpenAPIPage>) => (
              <OpenAPIPage {...props} {...preloaded} showDescription />
            ),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function docsParams(lang: Lang) {
  return pagesOf(lang).map((page) => ({ slug: page.slugs }));
}

export function docsMetadata(lang: Lang, slug: string[] | undefined): Metadata {
  const page = pageOf(lang, slug);
  return {
    title: page.data.title,
    description: page.data.description,
    // The changelog names its feed, for a feed reader given the page's address (#421).
    ...(slug?.join('/') === 'changelog'
      ? {
          alternates: {
            types: {
              'application/atom+xml': [{ url: FEED_PATH, title: 'Atom' }],
            },
          },
        }
      : {}),
  };
}
