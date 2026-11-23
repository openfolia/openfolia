import {
  computed,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
} from '@angular/router';
import { filter, map, startWith } from 'rxjs';

import { LanguageService } from '@openfolia/ui/i18n';
import type { PageHelpLink } from '@openfolia/ui/shell';

import { AboutService } from '../about/about.service';

/**
 * One page of the user guide, as the guide's index lists it (`frontend/docs/scripts/lib/
 * guide-index.mjs`): its article ID, and its address (from the docs site's root), title and
 * summary per language.
 */
export interface GuideArticle {
  readonly id: string;
  readonly urls: Readonly<Record<string, string>>;
  readonly title: Readonly<Record<string, string>>;
  readonly summary: Readonly<Record<string, string>>;
}

export interface GuideIndex {
  readonly articles: readonly GuideArticle[];
}

/**
 * Reads the guide's index. The build ships it beside the app (`help/guide-index.json`, made from
 * the guide this editor was built with by `frontend/docs/scripts/guide-index.mjs`), so the links
 * match the guide of this version and need no request to the docs site. Tests provide it.
 */
export const GUIDE_INDEX_LOADER = new InjectionToken<() => Promise<unknown>>(
  'GUIDE_INDEX_LOADER',
  {
    providedIn: 'root',
    factory: () => async () => {
      const response = await fetch(
        new URL('help/guide-index.json', document.baseURI),
      );
      if (!response.ok) throw new Error(`guide index: ${response.status}`);
      return response.json() as Promise<unknown>;
    },
  },
);

/** The route data that names a screen's guide page: `data: { help: 'guide.writing.content-browser' }`. */
export const HELP_DATA = 'help';

/** The article ID the deepest route on the way to the active screen names (`data.help`), if any. */
export function helpArticleOf(root: ActivatedRouteSnapshot): string | null {
  let found: string | null = null;
  for (
    let node: ActivatedRouteSnapshot | null = root;
    node;
    node = node.firstChild
  ) {
    const help: unknown = node.routeConfig?.data?.[HELP_DATA];
    if (typeof help === 'string') found = help;
  }
  return found;
}

const isRecordOfStrings = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((v) => typeof v === 'string');

/** The articles of an index read from a file, each checked; anything else is left out. */
export function parseGuideIndex(
  value: unknown,
): ReadonlyMap<string, GuideArticle> {
  const articles = new Map<string, GuideArticle>();
  const list: unknown =
    typeof value === 'object' && value !== null
      ? (value as { articles?: unknown }).articles
      : undefined;
  if (!Array.isArray(list)) return articles;
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, urls, title, summary } = item as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      !isRecordOfStrings(urls) ||
      !isRecordOfStrings(title) ||
      !isRecordOfStrings(summary) ||
      typeof urls['en'] !== 'string'
    )
      continue;
    articles.set(id, { id, urls, title, summary });
  }
  return articles;
}

/**
 * The docs site's root as an absolute `http(s)` address ending in `/`, or null: `docsUrl` comes
 * from the API's settings and ends up in links, so it is checked again here, whatever the API
 * answered (no other scheme, no credentials).
 */
export function docsBase(docsUrl: string | null | undefined): string | null {
  if (!docsUrl || !URL.canParse(docsUrl)) return null;
  const url = new URL(docsUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/**
 * A guide page's address under `base`: its path (`/de/guide/writing`) taken as relative to the
 * docs root, so a docs site under a sub-path keeps it. Null for a path that would leave the root.
 */
export function guideHref(base: string, path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL(path.slice(1), base);
  return url.href.startsWith(base) ? url.href : null;
}

/** Lower case without accents, so "Ubersetzung" finds "Übersetzung". */
const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** A guide page the palette found, in the person's language. */
export interface HelpMatch {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly href: string;
}

/**
 * The in-app help (#221): each screen's page of the user guide, by the article ID its route
 * names (`data.help`), in the person's interface language, under the docs site the operator set
 * (`CCMS_DOCS_URL`, `GET /about`); and the guide's pages by title and summary, for the command
 * palette. Nothing while the links are off (`docsUrl` null) or until the index and `GET /about`
 * are read (`load()`, which the shell's account menu and the pages outside the shell call).
 */
@Injectable({ providedIn: 'root' })
export class HelpService {
  private readonly about = inject(AboutService);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly loadIndex = inject(GUIDE_INDEX_LOADER);

  private readonly index = signal<ReadonlyMap<string, GuideArticle> | null>(
    null,
  );
  private reading: Promise<void> | null = null;

  /** The docs site's root, or null while unknown or turned off. */
  private readonly base = computed(() => docsBase(this.about.about()?.docsUrl));

  /** Whether help links are shown: the docs site is set and the guide's index is read. */
  readonly enabled = computed(
    () => this.base() !== null && (this.index()?.size ?? 0) > 0,
  );

  /** The active screen's article ID, after each navigation (the tips' screens, #222). */
  readonly screenArticle = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => helpArticleOf(this.router.routerState.snapshot.root)),
    ),
    { initialValue: null },
  );

  /** The active screen's guide page (`PAGE_HELP`), or null. */
  readonly page = computed<PageHelpLink | null>(() => {
    const id = this.screenArticle();
    return id ? this.link(id) : null;
  });

  /** Reads `GET /about` and the guide's index, unless read already; a failure is tried again on the next call. */
  load(): void {
    this.about.load();
    if (this.index() !== null || this.reading) return;
    this.reading = this.loadIndex()
      .then((value) => this.index.set(parseGuideIndex(value)))
      .catch(() => undefined)
      .finally(() => (this.reading = null));
  }

  /** The language the guide is read in: the interface's when the page has it, else English. */
  private lang(article: GuideArticle): string {
    const active = this.language.active();
    return article.urls[active] !== undefined ? active : 'en';
  }

  /** The guide page `id` in the person's language, read in a `computed`; null when there is none to open. */
  link(id: string): PageHelpLink | null {
    const base = this.base();
    const article = this.index()?.get(id);
    if (!base || !article) return null;
    const lang = this.lang(article);
    const href = guideHref(
      base,
      article.urls[lang] ?? article.urls['en'] ?? '',
    );
    if (!href) return null;
    return { href, title: article.title[lang] ?? article.title['en'] ?? id };
  }

  /** The address of the guide page `id`, or null (`link`). */
  href(id: string): string | null {
    return this.link(id)?.href ?? null;
  }

  /**
   * The guide pages whose title and summary, in the person's language, hold every word of
   * `term` (case and accents ignored), titles that hold them first; at most `limit`.
   */
  search(term: string, limit = 4): readonly HelpMatch[] {
    const words = fold(term).split(/\s+/).filter(Boolean);
    const base = this.base();
    const index = this.index();
    if (words.length === 0 || !base || !index) return [];
    const found: { match: HelpMatch; inTitle: boolean }[] = [];
    for (const article of index.values()) {
      const lang = this.lang(article);
      const title = article.title[lang] ?? '';
      const summary = article.summary[lang] ?? '';
      const text = fold(`${title} ${summary}`);
      if (!words.every((word) => text.includes(word))) continue;
      const href = guideHref(base, article.urls[lang] ?? '');
      if (!href) continue;
      const folded = fold(title);
      found.push({
        match: { id: article.id, title, summary, href },
        inTitle: words.every((word) => folded.includes(word)),
      });
    }
    return found
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle))
      .slice(0, limit)
      .map((f) => f.match);
  }
}
