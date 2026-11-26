/**
 * This build's own Pagefind index, for the search page (`search.ts`) and the typeahead on the
 * search fields (`typeahead.ts`): loading it, and turning what it returns into nodes (#845).
 * The index (`pagefind/`, written next to the pages by the build) holds only this build's
 * pages, so nothing it finds is above the build's audience.
 *
 * Pagefind's excerpts are HTML holding text and `<mark>` only; they are rebuilt here as text
 * nodes and `mark` elements, never inserted as HTML.
 */
export interface SubResult {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  /** How well the passage matched, per word found (Pagefind 1). */
  readonly weighted_locations?: readonly { readonly balanced_score: number }[];
  readonly locations?: readonly number[];
}
export interface ResultData {
  readonly url: string;
  readonly meta: Record<string, string | undefined>;
  readonly excerpt: string;
  readonly sub_results?: SubResult[];
}
export interface Pagefind {
  options(options: Record<string, unknown>): Promise<void>;
  search(
    query: string,
    options: { filters: Record<string, string> },
  ): Promise<{ results: { data(): Promise<ResultData> }[] } | null>;
}

/** An element with a class and text: never markup. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Only a path of this site: Pagefind's URLs are its own, but nothing else becomes a link. */
export function sameSite(url: string): string {
  const parsed = new URL(url, location.href);
  return parsed.origin === location.origin
    ? parsed.pathname + parsed.hash
    : '#';
}

/** An excerpt as text and `mark` elements. */
export function excerptNodes(html: string): Node[] {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    'text/html',
  );
  const out: Node[] = [];
  for (const node of doc.body.childNodes)
    out.push(
      node.nodeName === 'MARK'
        ? el('mark', undefined, node.textContent ?? '')
        : document.createTextNode(node.textContent ?? ''),
    );
  return out;
}

/** A result's passages, each a section that matched; the page itself when it has none. */
export function passagesOf(data: ResultData): readonly SubResult[] {
  return data.sub_results?.length
    ? data.sub_results
    : [
        {
          title: data.meta['title'] ?? '',
          url: data.url,
          excerpt: data.excerpt,
        },
      ];
}

/** How well a passage matched: its words' scores, or how many it holds. */
export function passageScore(sub: SubResult): number {
  return sub.weighted_locations?.length
    ? sub.weighted_locations.reduce((sum, w) => sum + w.balanced_score, 0)
    : (sub.locations?.length ?? 0);
}

const indexes = new Map<string, Promise<Pagefind>>();

/**
 * The index in `dir` under `base` (the language's site, or an older release's pages with its
 * own index in `_pagefind/`, #896), loaded once per page however many fields ask; a load that
 * failed is tried again on the next call. Its results' URLs are relative to `base`.
 */
export function loadPagefind(
  base: string,
  dir = 'pagefind/',
): Promise<Pagefind> {
  const key = `${base}${dir}`;
  let index = indexes.get(key);
  if (!index) {
    index = (async () => {
      const pagefind = (await import(
        /* @vite-ignore */ `${key}pagefind.js`
      )) as Pagefind;
      await pagefind.options({ baseUrl: base });
      return pagefind;
    })();
    index.catch(() => indexes.delete(key));
    indexes.set(key, index);
  }
  return index;
}
