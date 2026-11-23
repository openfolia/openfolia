import { countText } from '../lib/i18n.ts';

/**
 * Search over this build's own Pagefind index (`pagefind/`, written next to the pages by the
 * build): the index holds only this build's pages, so it finds nothing above its audience.
 * Results are grouped by manual (its variants side by side), each with the passages that
 * matched, a page of groups at a time: they scroll in their own frame, the pager below it. The
 * old results stay until the new ones are there, so nothing jumps while the reader types. The
 * query and the filters are kept in the address (`?q=`), so a search can be linked.
 *
 * Pagefind's excerpts are HTML holding text and `<mark>` only; they are rebuilt here as text
 * nodes and `mark` elements, never inserted as HTML.
 */
interface SubResult {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
}
interface ResultData {
  readonly url: string;
  readonly meta: Record<string, string | undefined>;
  readonly excerpt: string;
  readonly sub_results?: SubResult[];
}
interface Pagefind {
  options(options: Record<string, unknown>): Promise<void>;
  search(
    query: string,
    options: { filters: Record<string, string> },
  ): Promise<{ results: { data(): Promise<ResultData> }[] } | null>;
}
interface Group {
  readonly title: string;
  readonly product: string;
  readonly pages: ResultData[];
}

/** Groups a page of results shows. */
const PAGE = 5;
/** Results read from the index for one search (its best first). */
const MAX_RESULTS = 60;
/** Variants a group links before "+n more". */
const VARIANTS = 4;
/** Passages a group shows. */
const PASSAGES = 3;

function el<K extends keyof HTMLElementTagNameMap>(
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
function sameSite(url: string): string {
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

export async function startSearch(doc: Document): Promise<void> {
  const root = doc.querySelector<HTMLElement>('[data-search-root]');
  if (!root) return;
  const form = root.querySelector<HTMLFormElement>('[data-search-form]')!;
  const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
  const list = root.querySelector<HTMLOListElement>('[data-results]')!;
  const frame = root.querySelector<HTMLElement>('[data-results-frame]')!;
  const hint = root.querySelector<HTMLElement>('[data-hint]')!;
  // No frame around nothing: the results' sheet shows only when there are results.
  const sheet = root.querySelector<HTMLElement>('[data-results-sheet]')!;
  const none = root.querySelector<HTMLElement>('[data-none]')!;
  // Whether the groups shown are the answer to a query (none means "nothing matches").
  let searched = false;
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const pager = root.querySelector<HTMLElement>('[data-pager]')!;
  const t = JSON.parse(root.dataset['texts'] ?? '{}') as {
    results: { one: string; other: string };
    passages: { one: string; other: string };
    none: string;
    empty: string;
    failed: string;
    pageOf: string;
    more: string;
  };
  const lang = root.dataset['lang'] ?? doc.documentElement.lang;
  const base = root.dataset['base'] ?? '/';
  const productKey = root.dataset['productKey'] ?? 'Product';
  const variantKey = root.dataset['variantKey'] ?? 'Variant';
  const number = new Intl.NumberFormat(lang);

  // The address's query and filters, before the index loads.
  const params = new URLSearchParams(location.search);
  input.value = params.get('q') ?? '';
  for (const select of form.querySelectorAll('select'))
    if ([...select.options].some((o) => o.value === params.get(select.name)))
      select.value = params.get(select.name) ?? '';

  let pagefind: Pagefind;
  try {
    pagefind = (await import(
      /* @vite-ignore */ `${base}pagefind/pagefind.js`
    )) as Pagefind;
    await pagefind.options({ baseUrl: base });
  } catch {
    status.textContent = t.failed;
    return;
  }

  let groups: Group[] = [];
  let page = 0;
  let run = 0;

  const render = () => {
    const pages = Math.max(1, Math.ceil(groups.length / PAGE));
    page = Math.min(Math.max(page, 0), pages - 1);
    const items = groups.slice(page * PAGE, page * PAGE + PAGE).map((group) => {
      const item = el('li', 'result');
      const head = el('div', 'result__head');
      const title = el('a', 'result__title', group.title);
      title.href = sameSite(group.pages[0]!.url);
      const passages = new Map<string, SubResult>();
      for (const data of group.pages)
        for (const sub of data.sub_results?.length
          ? data.sub_results
          : [
              {
                title: data.meta['title'] ?? '',
                url: data.url,
                excerpt: data.excerpt,
              },
            ])
          if (!passages.has(sub.title)) passages.set(sub.title, sub);
      head.append(
        title,
        el('span', 'result__product', group.product),
        el('span', 'result__count', countText(t.passages, passages.size, lang)),
      );
      item.append(head);
      if (group.pages.length > 1 || group.pages[0]!.meta[variantKey]) {
        const variants = el('ul', 'result__variants');
        for (const data of group.pages.slice(0, VARIANTS)) {
          const link = el('a', undefined, data.meta[variantKey] ?? '');
          link.href = sameSite(data.url);
          const li = el('li');
          li.append(link);
          variants.append(li);
        }
        if (group.pages.length > VARIANTS)
          variants.append(
            el(
              'li',
              'result__more',
              t.more.replace(
                '{n}',
                number.format(group.pages.length - VARIANTS),
              ),
            ),
          );
        item.append(variants);
      }
      const ol = el('ol', 'result__passages');
      for (const sub of [...passages.values()].slice(0, PASSAGES)) {
        const li = el('li', 'result__passage');
        const link = el('a', 'result__passage-title', sub.title);
        link.href = sameSite(sub.url);
        const excerpt = el('p', 'result__excerpt');
        excerpt.append(...excerptNodes(sub.excerpt));
        li.append(link, excerpt);
        ol.append(li);
      }
      item.append(ol);
      return item;
    });
    list.replaceChildren(...items);
    hint.hidden = input.value.trim() !== '';
    sheet.hidden = groups.length === 0;
    none.hidden = !searched || groups.length > 0;
    pager.hidden = pages < 2;
    pager.querySelector('[data-page-label]')!.textContent = t.pageOf
      .replace('{n}', number.format(page + 1))
      .replace('{m}', number.format(pages));
    pager.querySelector<HTMLButtonElement>('[data-prev]')!.disabled =
      page === 0;
    pager.querySelector<HTMLButtonElement>('[data-next]')!.disabled =
      page >= pages - 1;
    frame.scrollTop = 0;
  };

  const search = async () => {
    const mine = ++run;
    const data = new FormData(form);
    const query = String(data.get('q') ?? '').trim();
    const chosen: Record<string, string> = {};
    const url = new URL(location.href);
    url.search = '';
    if (query !== '') url.searchParams.set('q', query);
    for (const [key, value] of data.entries())
      if (key !== 'q' && value !== '') {
        chosen[key] = String(value);
        url.searchParams.set(key, String(value));
      }
    history.replaceState(history.state, '', url);
    if (query === '') {
      searched = false;
      groups = [];
      status.textContent = '';
      render();
      return;
    }
    root.dataset['busy'] = '';
    try {
      const found = await pagefind.search(query, { filters: chosen });
      if (found === null || mine !== run) return;
      const results = await Promise.all(
        found.results.slice(0, MAX_RESULTS).map((r) => r.data()),
      );
      if (mine !== run) return;
      const byManual = new Map<string, Group>();
      for (const result of results) {
        const key = `${result.meta[productKey] ?? ''}\u0000${result.meta['title'] ?? ''}`;
        let group = byManual.get(key);
        if (!group) {
          group = {
            title: result.meta['title'] ?? '',
            product: result.meta[productKey] ?? '',
            pages: [],
          };
          byManual.set(key, group);
        }
        group.pages.push(result);
      }
      groups = [...byManual.values()];
      searched = true;
      page = 0;
      status.textContent =
        groups.length === 0
          ? t.none.replace('{q}', () => query)
          : countText(t.results, groups.length, lang).replace(
              '{q}',
              () => query,
            );
      render();
    } catch {
      if (mine === run) status.textContent = t.failed;
    } finally {
      if (mine === run) delete root.dataset['busy'];
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    void search();
  });
  form.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(), 150);
  });
  form.addEventListener('change', () => {
    clearTimeout(timer);
    void search();
  });
  pager.querySelector('[data-prev]')!.addEventListener('click', () => {
    page--;
    render();
  });
  pager.querySelector('[data-next]')!.addEventListener('click', () => {
    page++;
    render();
  });
  hint.hidden = input.value.trim() !== '';
  if (input.value.trim() !== '') await search();
  else input.focus();
}
