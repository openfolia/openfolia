import type * as PageTree from 'fumadocs-core/page-tree';
import { source, isOperationPage } from './source';
import type { Lang } from './i18n';

/** The English address of an operation page (`/de/api/delivery/x` → `/api/delivery/x`). */
const english = (url: string) => url.replace(/^\/de(?=\/|$)/, '') || '/';

const operationUrls = new Set(
  source
    .getPages('en')
    .filter(isOperationPage)
    .map((page) => page.url),
);

/**
 * A sidebar node as the layout sends it to every page: without the pages' descriptions (the
 * sidebar shows none, and the operations' are long: they made the tree most of each page's
 * weight), German operation pages at their English addresses.
 */
function slim(node: PageTree.Node, lang: Lang): PageTree.Node {
  if (node.type === 'page') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- left out on purpose
    const { description, ...rest } = node;
    return lang !== 'en' && operationUrls.has(english(node.url))
      ? { ...rest, url: english(node.url) }
      : rest;
  }
  if (node.type === 'folder') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- left out on purpose
    const { description, ...rest } = node;
    return {
      ...rest,
      ...(node.index && { index: slim(node.index, lang) as PageTree.Item }),
      children: node.children.map((child) => slim(child, lang)),
    };
  }
  return node;
}

/**
 * The sidebar of a language. German shows the API reference's operation pages in English, at their
 * English addresses: they are generated in English, and doubling some 200 pages under `/de/` would
 * double the build for no German text.
 */
export function pageTree(lang: Lang): PageTree.Root {
  const tree = source.getPageTree(lang);
  return { ...tree, children: tree.children.map((child) => slim(child, lang)) };
}

/** The pages a language's routes make: German leaves the operation pages to English. */
export function pagesOf(lang: Lang) {
  const pages = source.getPages(lang);
  return lang === 'en' ? pages : pages.filter((page) => !isOperationPage(page));
}
