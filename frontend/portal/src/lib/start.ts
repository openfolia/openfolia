import {
  isLinkHref,
  plainTextOf,
  type Block,
  type Inline,
  type Item,
  type ResolvedEntry,
  type ResolvedManual,
} from '@openfolia/content-model';
import { headingIdOf } from '@openfolia/render-html';
import {
  entryPath,
  guidePath,
  isOlder,
  manualPath,
  releaseRoot,
  type BuiltRelease,
} from './paths.ts';
import {
  LANGUAGE_TAG,
  type Snapshot,
  type SnapshotManual,
  type SnapshotVariant,
} from './snapshot.ts';

/**
 * The authored start page (#897): what the pages show and what the build reports, made from the
 * snapshot alone. A featured link's target is always one of this snapshot's own pages, which
 * passed the audience checks, so no link can lead to what the build does not hold; one that
 * would is left out and reported.
 */

/** The element ID of a module's section of the start page (the first module's: the heading's). */
export const sectionId = (module: string) => `of-at-${module}`;

/** What a featured link leads to: decides its icon and its line of context. */
export type StartLinkKind =
  'manual' | 'section' | 'list' | 'search' | 'release' | 'external';

export interface StartLink {
  readonly title: string;
  /** The title's language: the target's, where the link has no words of its own. */
  readonly lang: string;
  /** The line under the title; empty: none. */
  readonly text: string;
  readonly kind: StartLinkKind;
  /** A page of the language's site (`alpha/operating/…`), or, for `external`, the address. */
  readonly to: string;
  /** Where it leads, in a few words (the product, the manual, the host); empty: none. */
  readonly context: string;
  /** It leads to an update guide. */
  readonly guide: boolean;
}

/** One module of the start page: the first is its heading and introduction. */
export interface StartSection {
  readonly module: string;
  /** The prefix of its text's element IDs: each section's own, so no two sections share one. */
  readonly prefix: string;
  readonly title: string;
  /** The module's language: another than the build's where a translation is missing. */
  readonly lang: string;
  /** The first section's opening paragraph, shown above the search field (none, or one block). */
  readonly lead: Block[];
  readonly text: Block[];
  readonly links: StartLink[];
}

export interface StartPage {
  readonly resolved: ResolvedManual;
  /** At least one. */
  readonly sections: readonly StartSection[];
  /** What was left out, for the build's log. */
  readonly problems: readonly string[];
  /** What a cross-reference, or a link's address, in its text leads to; undefined: no page of this build. */
  readonly xref: (target: Ref) => Target | undefined;
  readonly link: (href: string) => Target | undefined;
}

type Ref = { readonly module: string; readonly block?: string };
type Target = Pick<StartLink, 'kind' | 'to' | 'context' | 'guide'>;
type ModuleEntry = Extract<ResolvedEntry, { kind: 'module' }>;

const moduleEntries = (entries: readonly ResolvedEntry[]): ModuleEntry[] =>
  entries.flatMap((e) => (e.kind === 'group' ? moduleEntries(e.entries) : [e]));
const resolvedOf = (variant: SnapshotVariant) =>
  variant.resolved as unknown as ResolvedManual;

/** The prefix of the element IDs of the lead, which stands apart from its section's other text. */
export const LEAD_PREFIX = 'of-lead-';

/** Where a cross-reference within the start page itself leads: the block where it is shown as text, else its section. */
export function ownAnchor(
  page: StartPage,
  target: Ref & { readonly id?: string },
): string | undefined {
  const section = page.sections.find((s) => s.module === target.module);
  if (!section) return undefined;
  const holds = (blocks: readonly Block[]) =>
    JSON.stringify(blocks).includes(`"id":${JSON.stringify(target.id)}`);
  if (target.block !== undefined && target.id !== undefined) {
    if (holds(section.text)) return `#${section.prefix}${target.id}`;
    if (holds(section.lead)) return `#${LEAD_PREFIX}${target.id}`;
  }
  return `#${sectionId(target.module)}`;
}

/** The start page of `snapshot`, or undefined: none authored (or it holds no module). */
export function startPage(snapshot: Snapshot): StartPage | undefined {
  const start = snapshot.start;
  const variant = start?.manual.variants[0];
  if (!start || !variant) return undefined;
  const resolved = resolvedOf(variant);
  const entries = moduleEntries(resolved.entries).filter(
    (e, i, all) => all.findIndex((o) => o.module === e.module) === i,
  );
  if (entries.length === 0) return undefined;
  let problems: string[] = [];
  const address = addressOf(snapshot, start);
  let sections: StartSection[];
  // The page's own sections, which a cross-reference may lead to.
  let own = entries.map((e) => e.module);
  const xref = (ref: Ref): Target | undefined =>
    own.includes(ref.module)
      ? {
          kind: 'section',
          to: `#${sectionId(ref.module)}`,
          context: start.manual.title,
          guide: false,
        }
      : xrefTarget(snapshot, ref);

  const linkOf = (item: Item, lang: string): StartLink[] => {
    const lead = leadingLink(item.content, (ref) =>
      titleOf(snapshot, resolved, ref),
    );
    if (!lead) return [];
    const found =
      'ref' in lead.to ? xref(lead.to.ref) : address(lead.to.href, problems);
    if (!found) {
      const to =
        'ref' in lead.to
          ? `module ${lead.to.ref.module}`
          : JSON.stringify(lead.to.href);
      problems.push(
        `the link “${lead.title}” leads to ${to}, which no link can open (not released, for another audience, gone, or the start page itself): left out`,
      );
      return [];
    }
    return [
      { title: lead.title, lang: lead.lang ?? lang, text: lead.text, ...found },
    ];
  };

  const sectionOf = (entry: ModuleEntry, i: number): StartSection => {
    const links: StartLink[] = [];
    const text: Block[] = [];
    for (const block of entry.blocks)
      if (block.type === 'list' && block.items.every(leadsWithLink))
        for (const item of block.items) links.push(...linkOf(item, entry.lang));
      else text.push(block);
    const lead = i === 0 && text[0]?.type === 'paragraph' ? [text[0]] : [];
    return {
      module: entry.module,
      prefix: `of-start-${i}-`,
      title: entry.title,
      lang: entry.lang,
      lead,
      text: text.slice(lead.length),
      links,
    };
  };
  // A further section whose links all went has nothing under its title: it goes, and what led to
  // it is read again (a manual may hold its module), until every section led to is there.
  for (;;) {
    problems = [];
    sections = entries
      .map(sectionOf)
      .filter((s, i) => i === 0 || s.text.length > 0 || s.links.length > 0);
    const shown = sections.map((s) => s.module);
    if (own.every((module) => shown.includes(module))) break;
    own = shown;
  }

  // The links and cross-references of the text (and of its terms' definitions) that open nothing.
  const inText = sections.map((s) => [...s.lead, ...s.text]);
  for (const node of nodesIn([inText, resolved.terms ?? []])) {
    const href = linkHref(node);
    if (href !== undefined && !address(href, problems))
      problems.push(
        `the text links ${JSON.stringify(href)}, which is no page of this portal: shown without the link`,
      );
    if (node.type === 'xref' && !xref(node))
      problems.push(
        `the text refers to module ${node.module}, which is on no page of this portal: shown without the link`,
      );
  }
  return {
    resolved,
    sections,
    // Authored words reach the log without the characters that move a terminal's cursor or turn text around.
    problems: [...new Set(problems)].map((p) => p.replace(UNSEEN, '')),
    xref,
    link: address,
  };
}

/** Control and format characters, and line and paragraph separators. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Every object in `value`, itself included, that says what type it is. */
function nodesIn(value: unknown): Inline[] {
  if (typeof value !== 'object' || value === null) return [];
  const nodes = Object.values(value).flatMap(nodesIn);
  return 'type' in value ? [value as Inline, ...nodes] : nodes;
}

const isLink = (node: Inline | undefined): boolean =>
  node?.type === 'xref' || linkHref(node) !== undefined;

const linkHref = (node: Inline | undefined): string | undefined => {
  if (node?.type !== 'text') return undefined;
  for (const mark of node.marks ?? [])
    if (mark.type === 'link') return mark.href;
  return undefined;
};

/** The content from its first node that is not blank. */
const trimmed = (content: readonly Inline[]): readonly Inline[] => {
  const at = content.findIndex(
    (n) => n.type !== 'text' || n.text.trim() !== '',
  );
  return at < 0 ? [] : content.slice(at);
};

const leadsWithLink = (item: Item): boolean =>
  item.blocks.length === 0 && isLink(trimmed(item.content)[0]);

/** A list item that starts with a link or cross-reference: its title, its line and where it leads. */
function leadingLink(
  content: readonly Inline[],
  titleOf: (ref: Ref) => { title: string; lang?: string },
):
  | {
      title: string;
      /** The title's language where it is the target's own; undefined: the text's. */
      lang?: string | undefined;
      text: string;
      to: { ref: Ref } | { href: string };
    }
  | undefined {
  const nodes = trimmed(content);
  const first = nodes[0];
  if (first === undefined) return undefined;
  const plain = (part: readonly Inline[]) =>
    plainTextOf(
      part.map((n): Inline =>
        n.type === 'xref' && !n.text
          ? { type: 'text', text: titleOf(n).title }
          : n,
      ),
    )
      .text.replace(/\s+/g, ' ')
      .trim();
  // Between the title and its line people write a colon or a dash; the card has a line break.
  const line = (part: readonly Inline[]) =>
    plain(part).replace(/^(?:[:–—-]\s*)+/, '');
  if (first.type === 'xref')
    return {
      title: plain([first]),
      lang: first.text ? undefined : titleOf(first).lang,
      text: line(nodes.slice(1)),
      to: { ref: first },
    };
  const href = linkHref(first);
  if (href === undefined) return undefined;
  const end = nodes.findIndex((n) => linkHref(n) !== href);
  const at = end < 0 ? nodes.length : end;
  return {
    title: plain(nodes.slice(0, at)),
    text: line(nodes.slice(at)),
    to: { href },
  };
}

/** The title of a module: as the build's manuals show it, else as the resolution names it, else its ID. */
function titleOf(
  snapshot: Snapshot,
  resolved: ResolvedManual,
  { module }: Ref,
): { title: string; lang?: string } {
  const own = moduleEntries(resolved.entries).find((e) => e.module === module);
  if (own) return own;
  for (const release of snapshot.releases)
    for (const { guide, variants } of release.manuals) {
      // A guide's step that the build left out (`build/fetch.ts`) is on no page.
      if (guide && !guide.steps.some((s) => s.module === module)) continue;
      for (const variant of variants)
        for (const e of moduleEntries(resolvedOf(variant).entries))
          if (e.module === module) return e;
    }
  const titles = resolved.xrefTitles ?? {};
  return { title: Object.hasOwn(titles, module) ? titles[module]! : module };
}

/**
 * A cross-reference's page: the first manual of the newest releases (as the start page lists
 * them) that holds the module, at its section; an update guide only when no manual does.
 */
function xrefTarget(snapshot: Snapshot, ref: Ref): Target | undefined {
  const pages = snapshot.releases.flatMap((release) =>
    release.manuals.flatMap((manual) =>
      manual.variants.map((variant) => ({ release, manual, variant })),
    ),
  );
  for (const guide of [false, true])
    for (const { release, manual, variant } of pages) {
      if ((manual.guide !== undefined) !== guide) continue;
      const resolved = resolvedOf(variant);
      if (!moduleEntries(resolved.entries).some((e) => e.module === ref.module))
        continue;
      if (manual.guide) {
        const step = manual.guide.steps.findIndex(
          (s) => s.module === ref.module,
        );
        if (step < 0) continue;
        return {
          kind: 'section',
          to: `${guidePath(release, manual)}#of-s${step}-${ref.module}`,
          context: manual.title,
          guide: true,
        };
      }
      // A block the variant leaves out: the module's section stands in for it.
      const block =
        ref.block === undefined
          ? undefined
          : resolved.anchors?.[`${ref.module}#${ref.block}`];
      return {
        kind: 'section',
        to: `${manualPath(release, manual, variant)}#of-${block ?? ref.module}`,
        context: manual.title,
        guide: false,
      };
    }
  return undefined;
}

/** A page an address of the portal may name: its path as the site writes it. */
interface Page {
  readonly path: string;
  readonly kind: StartLinkKind;
  readonly context: string;
  /** The manual on it, for the sections an address may name. */
  readonly manual?: SnapshotManual;
  readonly variant?: SnapshotVariant;
}

function sitePages(snapshot: Snapshot): Map<string, Page> {
  const pages = new Map<string, Page>();
  const add = (page: Page) => pages.set(page.path, page);
  add({ path: 'manuals/', kind: 'list', context: '' });
  add({ path: 'search/', kind: 'search', context: '' });
  for (const release of [...snapshot.releases, ...snapshot.older]) {
    const context = isOlder(release)
      ? `${release.productLabel} ${release.revision}`
      : release.productLabel;
    if (isOlder(release))
      add({ path: releaseRoot(release), kind: 'release', context });
    for (const manual of release.manuals) addManual(release, manual, context);
  }
  return pages;

  function addManual(
    release: BuiltRelease,
    manual: SnapshotManual,
    context: string,
  ) {
    const path = guidePath(release, manual);
    if (manual.guide) {
      add({ path, kind: 'manual', context, manual });
      return;
    }
    for (const variant of manual.variants)
      add({
        path: manualPath(release, manual, variant),
        kind: 'manual',
        context,
        manual,
        variant,
      });
    // `alpha/operating/`, the address without a variant, means the manual: its first variant.
    pages.set(path, pages.get(entryPath(release, manual))!);
  }
}

/** Whether the page has an element of this ID (its modules, blocks and their headings, the glossary). */
function hasAnchor(page: Page, id: string): boolean {
  const variant = page.variant ?? page.manual?.variants[0];
  if (!variant) return false;
  const resolved = resolvedOf(variant);
  const origins = Object.entries(resolved.origins ?? {});
  const has = (prefix: string, ids: string[]) =>
    ids.some((i) => id === prefix + i || id === prefix + headingIdOf(i));
  if (page.manual?.guide) {
    const n = Number(/^of-s(\d+)-/.exec(id)?.[1] ?? NaN);
    const module = page.manual.guide.steps[n]?.module;
    if (module === undefined) return false;
    const blocks = origins.filter(([, origin]) => origin.module === module);
    return has(`of-s${n}-`, [module, ...blocks.map(([block]) => block)]);
  }
  return has('of-', [
    ...moduleEntries(resolved.entries).map((e) => e.module),
    ...origins.map(([block]) => block),
    ...(resolved.glossary === true && resolved.terms?.length
      ? ['_glossary']
      : []),
  ]);
}

/**
 * Reads a link's address: one on the portal's own address is a page of this site, in this
 * build's language whatever language it was copied in (undefined when this build has no such
 * page); any other is external.
 */
function addressOf(
  snapshot: Snapshot,
  { origin, basePath }: { origin: string | null; basePath: string },
): (href: string, problems?: string[]) => Target | undefined {
  let pages: Map<string, Page> | undefined;
  return (href, problems) => {
    if (!isLinkHref(href)) return undefined;
    const url = new URL(href);
    if (
      origin === null ||
      url.origin !== origin ||
      !`${url.pathname}/`.startsWith(basePath)
    )
      return {
        kind: 'external',
        to: href,
        context:
          url.protocol === 'mailto:'
            ? // As written where its decoded form would not read as what it opens.
              decoded(url.pathname).replace(
                /^.*[\p{Cc}\p{Cf}].*$/su,
                () => url.pathname,
              )
            : url.hostname.replace(/^www\./, ''),
        guide: false,
      };
    pages ??= sitePages(snapshot);
    const path = decoded(url.pathname)
      .slice(basePath.length)
      .replace(/(?:^|\/)index\.html$/, '/')
      .replace(/([^/])$/, '$1/')
      .replace(/^\//, '');
    const [first = '', ...rest] = path.split('/');
    const inLanguage = LANGUAGE_TAG.test(first) ? rest.join('/') : undefined;
    const id = decoded(url.hash.slice(1));
    // A product's section of the start page.
    if ((path === '' || inLanguage === '') && id.startsWith('product-')) {
      const release = snapshot.releases.find(
        (r) => id === `product-${r.product}`,
      );
      return (
        release && {
          kind: 'list',
          to: `#${id}`,
          context: release.productLabel,
          guide: false,
        }
      );
    }
    const page =
      pages.get(path) ??
      (inLanguage === undefined ? undefined : pages.get(inLanguage));
    if (!page) return undefined;
    const searched = url.searchParams.get('release');
    if (
      page.kind === 'search' &&
      searched !== null &&
      !snapshot.older.some((r) => searched === `${r.product}/${r.segment}`)
    )
      return undefined;
    // A manual's own query only carries a notice of where the reader came from.
    const query = page.variant ? '' : url.search;
    const section = id !== '' && hasAnchor(page, id);
    if (id !== '' && page.manual && !section)
      problems?.push(
        `${JSON.stringify(href)} names a section its page does not have: it leads to the page`,
      );
    return {
      kind: section ? 'section' : page.kind,
      to: `${page.path}${query}${section ? `#${id}` : ''}`,
      context: section ? page.manual!.title : page.context,
      guide: page.manual?.guide !== undefined,
    };
  };
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: it names no page.
    return value;
  }
}
