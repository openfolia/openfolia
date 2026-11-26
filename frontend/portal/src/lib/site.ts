import { readFileSync } from 'node:fs';
import {
  resolveOutputLabels,
  type ResolvedEntry,
  type ResolvedManual,
} from '@openfolia/content-model';
import {
  headingIdOf,
  renderManualHtml,
  renderModuleHtml,
} from '@openfolia/render-html';
import {
  OLDER_INDEX,
  parseSnapshot,
  type Snapshot,
  type SnapshotGuide,
  type SnapshotManual,
  type SnapshotOlderRelease,
  type SnapshotRelease,
  type SnapshotStep,
  type SnapshotVariant,
} from './snapshot.ts';
import {
  entryPath,
  isOlder,
  manualPath,
  releaseRoot,
  type BuiltRelease,
} from './paths.ts';
import {
  LEAD_PREFIX,
  ownAnchor,
  startPage,
  type StartPage,
  type StartSection,
} from './start.ts';

export type { SnapshotOlderRelease };
export {
  entryPath,
  guidePath,
  manualPath,
  releaseRoot,
  type BuiltRelease,
} from './paths.ts';

let cached: Snapshot | undefined;

/** The build's snapshot (`CCMS_PORTAL_SNAPSHOT`), read and checked once per build. */
export function snapshot(): Snapshot {
  if (cached) return cached;
  const path = process.env['CCMS_PORTAL_SNAPSHOT'];
  if (path === undefined || path === '')
    throw new Error(
      'CCMS_PORTAL_SNAPSHOT is not set: build the portal with scripts/build.ts',
    );
  cached = parseSnapshot(JSON.parse(readFileSync(path, 'utf8')));
  return cached;
}

/** A path of the site, under its base (`/de/`, `/docs/de/`). */
export function href(path = ''): string {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${path}`;
}

/** The base of every language's site: the build's base without its language. */
export function languageRoot(lang: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return base.endsWith(`/${lang}/`) ? base.slice(0, -lang.length - 1) : base;
}

export interface ManualPage {
  readonly release: BuiltRelease;
  readonly manual: SnapshotManual;
  readonly variant: SnapshotVariant;
}

/**
 * Every manual page of the given releases (default: each product's newest): one per release,
 * manual and variant (update guides have their own).
 */
export function manualPages(
  releases: readonly BuiltRelease[] = snapshot().releases,
): ManualPage[] {
  return releases.flatMap((release) =>
    release.manuals.flatMap((manual) =>
      manual.guide
        ? []
        : manual.variants.map((variant) => ({ release, manual, variant })),
    ),
  );
}

export interface GuidePage {
  readonly release: BuiltRelease;
  readonly manual: SnapshotManual & { guide: SnapshotGuide };
  /** The guide's resolved manual: its steps' text. */
  readonly variant: SnapshotVariant;
}

/** Every update guide page of the given releases (default: each product's newest; #907): one per release and guide. */
export function guidePages(
  releases: readonly BuiltRelease[] = snapshot().releases,
): GuidePage[] {
  return releases.flatMap((release) =>
    release.manuals.flatMap((manual) =>
      manual.guide && manual.variants[0]
        ? [
            {
              release,
              manual: manual as GuidePage['manual'],
              variant: manual.variants[0],
            },
          ]
        : [],
    ),
  );
}

/** A product's built releases, its newest first, then its older ones (newest first). */
export function releasesOf(product: string): BuiltRelease[] {
  const s = snapshot();
  return [
    ...s.releases.filter((r) => r.product === product),
    ...s.older.filter((r) => r.product === product),
  ];
}

/**
 * Where a release leads when the page the reader is on is not in it: an older release's own
 * page (its manuals), the newest's section of the start page.
 */
export const releaseHome = (release: BuiltRelease) =>
  isOlder(release)
    ? href(releaseRoot(release))
    : href(`#product-${release.product}`);

/** One entry of the release switch (#896): where the page the reader is on is in that release. */
export interface ReleaseChoice {
  readonly release: BuiltRelease;
  readonly href: string;
  readonly current: boolean;
  readonly latest: boolean;
  /**
   * What of the page that release lacks: `variant` (it opens the manual's variant `variant`
   * instead), `manual` (it opens the release's manuals); undefined: the same page.
   */
  readonly missing?: 'variant' | 'manual';
  /** With `missing: 'variant'`: the variant it opens. */
  readonly variant?: SnapshotVariant;
  /** It opens the same manual: the script takes the reader's section (and the page's query) along. */
  readonly keepsPlace: boolean;
}

/** The page `manualId` (and `variant`, for a manual) in `release`, or what stands in for it. */
function counterpart(
  release: BuiltRelease,
  manualId: string | undefined,
  variant: SnapshotVariant | undefined,
): Pick<ReleaseChoice, 'href' | 'missing' | 'variant'> {
  if (manualId === undefined) return { href: releaseHome(release) };
  const manual = release.manuals.find((m) => m.id === manualId);
  if (!manual) return { href: releaseHome(release), missing: 'manual' };
  if (manual.guide || variant === undefined)
    return { href: href(entryPath(release, manual)) };
  const same = manual.variants.find((v) => v.slug === variant.slug);
  if (same) return { href: href(manualPath(release, manual, same)) };
  // The variant that keeps the most of this one's values, the first of equals.
  const kept = (v: SnapshotVariant) =>
    Object.entries(variant.values).filter(([a, value]) => v.values[a] === value)
      .length;
  const nearest = manual.variants.reduce((best, v) =>
    kept(v) > kept(best) ? v : best,
  );
  return {
    href: href(manualPath(release, manual, nearest)),
    missing: 'variant',
    variant: nearest,
  };
}

/**
 * The release switch of a page in `current` (#896): every built release of its product, newest
 * first, each leading to the same manual and variant there (the script adds the section in
 * view), else to what stands in for it. Empty when the product has one release built: no switch.
 */
export function releaseChoices(
  current: BuiltRelease,
  manualId?: string,
  variant?: SnapshotVariant,
): ReleaseChoice[] {
  const releases = releasesOf(current.product);
  if (releases.length < 2) return [];
  return releases.map((release, i) => {
    const there = counterpart(release, manualId, variant);
    const isCurrent = release.id === current.id;
    return {
      release,
      current: isCurrent,
      latest: i === 0,
      ...there,
      keepsPlace:
        !isCurrent && manualId !== undefined && there.missing !== 'manual',
    };
  });
}

/**
 * What an older release's page shows and declares (#896): the newest release and the same page
 * there (or what stands in for it) for the notice, the canonical address (the newest's page of
 * the same manual; none when the newest has no such manual), whether it is `noindex`, and its
 * own search index.
 */
export interface OlderPage {
  readonly release: SnapshotOlderRelease;
  readonly latest: SnapshotRelease;
  readonly latestHref: string;
  readonly canonical: string | undefined;
  readonly noindex: boolean;
  readonly search: SearchScope;
}

/** An older release's own search (#896): its key in the search page's address, and its index. */
export interface SearchScope {
  /** `<product>/<segment>`: the search page's `?release=`. */
  readonly key: string;
  /** The release's pages, which its index's URLs are relative to. */
  readonly base: string;
  /** The index's folder under `base`. */
  readonly index: string;
  /** "Alpha 0.9": what the search page says it searches. */
  readonly product: string;
  readonly revision: string;
}

export const searchScope = (release: SnapshotOlderRelease): SearchScope => ({
  key: `${release.product}/${release.segment}`,
  base: href(releaseRoot(release)),
  index: `${OLDER_INDEX}/`,
  product: release.productLabel,
  revision: release.revision,
});

export function olderPage(
  release: BuiltRelease,
  manualId?: string,
  variant?: SnapshotVariant,
): OlderPage | undefined {
  if (!isOlder(release)) return undefined;
  const latest = snapshot().releases.find(
    (r) => r.product === release.product,
  )!;
  const there = counterpart(latest, manualId, variant);
  return {
    release,
    latest,
    latestHref: there.href,
    canonical:
      manualId !== undefined && there.missing !== 'manual'
        ? there.href
        : undefined,
    noindex: snapshot().olderNoindex,
    search: searchScope(release),
  };
}

/** How every page links the build's files: images, attachments and symbols it wrote. */
function fileLinks() {
  const s = snapshot();
  return {
    // `safeUrl` refuses a `data:` URL, so an asset the build has no file for renders without one.
    assetUrl: (hash: string) =>
      s.assets[hash] === undefined
        ? 'data:,'
        : href(`assets/${s.assets[hash]}`),
    symbolUrl: (id: string) =>
      s.symbols[id] === undefined ? undefined : href(`assets/${s.symbols[id]}`),
    symbolLabel: (id: string) =>
      s.safetySymbols.find((symbol) => symbol.id === id)?.label,
    outputLabels: s.outputLabels as never,
  };
}

/**
 * A step's text (#907): its module in the guide's resolved manual, rendered by
 * `@openfolia/render-html` as anywhere (escaped by construction), its title an `<h3>`. `n` is
 * the step's place on the page: each step's IDs start with `of-s<n>-`, so a module in two steps
 * never gives two elements one ID. Undefined: the module is not in the resolved manual.
 */
export function stepHtml(
  page: GuidePage,
  step: SnapshotStep,
  n: number,
): { html: string; headingId: string } | undefined {
  const prefix = `of-s${n}-`;
  const result = renderModuleHtml(
    page.variant.resolved as unknown as ResolvedManual,
    step.module,
    { ...fileLinks(), idPrefix: prefix, headingLevel: 3 },
  );
  return (
    result && {
      html: result.html,
      headingId: `${prefix}${headingIdOf(step.module)}`,
    }
  );
}

/** The authored start page (#897), or undefined: the default one. Read once per build. */
export const authoredStart = (): StartPage | undefined => startPage(snapshot());

/**
 * A start page section's text (#897), without its title (the page sets that): `lead` the first
 * section's opening paragraph, which stands above the search field, else the rest. Rendered by
 * `@openfolia/render-html` as anywhere (escaped by construction).
 */
export function startHtml(
  page: StartPage,
  section: StartSection,
  part: 'lead' | 'text',
): string {
  const blocks = part === 'lead' ? section.lead : section.text;
  const to = (target: ReturnType<StartPage['link']>) =>
    target && (target.kind === 'external' ? target.to : href(target.to));
  const result = renderModuleHtml(
    {
      ...page.resolved,
      // The others too, unrendered: a cross-reference to one reads as its title.
      entries: [
        {
          kind: 'module',
          module: section.module,
          title: section.title,
          lang: section.lang,
          blocks,
        },
        ...page.resolved.entries,
      ],
    },
    section.module,
    {
      ...fileLinks(),
      idPrefix: part === 'lead' ? LEAD_PREFIX : section.prefix,
      headingLevel: section === page.sections[0] ? 1 : 2,
      title: false,
      xrefHref: (target) => ownAnchor(page, target) ?? to(page.xref(target)),
      linkHref: (address) => to(page.link(address)),
    },
  );
  return result?.html ?? '';
}

/** A date in the build's language. */
export function formatDate(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/**
 * The manual's HTML: `@openfolia/render-html`'s fragment, the only markup the pages insert as HTML.
 * It is escaped by construction (its README, "Security"), and its input is data from the
 * snapshot, never markup from the API. Images, attachments and symbols link the files the build
 * wrote; one it did not write gets no link.
 */
export function manualHtml(page: ManualPage): string {
  const { html } = renderManualHtml(
    page.variant.resolved as unknown as ResolvedManual,
    {
      ...fileLinks(),
      subtitle: `${page.release.productLabel} ${page.release.revision} · ${page.variant.label}`,
      toc: false,
    },
  );
  return html;
}

export interface TocEntry {
  readonly title: string;
  readonly href?: string;
  readonly entries: TocEntry[];
}

/** The table of contents of a resolved manual: modules link their sections (first occurrence). */
export function tableOfContents(page: ManualPage): TocEntry[] {
  const resolved = page.variant.resolved as unknown as ResolvedManual;
  const seen = new Set<string>();
  const walk = (entries: ResolvedEntry[]): TocEntry[] =>
    entries.map((entry) => {
      if (entry.kind === 'group')
        return { title: entry.title, entries: walk(entry.entries) };
      const first = !seen.has(entry.module);
      seen.add(entry.module);
      return {
        title: entry.title,
        ...(first && { href: `#of-${entry.module}` }),
        entries: [],
      };
    });
  const toc = walk(resolved.entries);
  if (resolved.glossary === true && (resolved.terms?.length ?? 0) > 0)
    toc.push({
      title: resolveOutputLabels(
        resolved.lang,
        snapshot().outputLabels as never,
      ).labels.glossary,
      href: '#of-_glossary',
      entries: [],
    });
  return toc;
}

export const contentsLabel = (lang: string) =>
  resolveOutputLabels(lang, snapshot().outputLabels as never).labels.contents;

/** What the start page, the manual list and search show: every manual of every release, and the filters they need. */
export function catalogue() {
  const s = snapshot();
  const cards = s.releases.flatMap((release) =>
    release.manuals.map((manual) => ({ release, manual })),
  );
  const products = s.releases.map((r) => ({
    id: r.product,
    label: r.productLabel,
  }));
  const used = new Map<string, Set<string>>();
  for (const { manual } of cards)
    for (const variant of manual.variants)
      for (const [attribute, value] of Object.entries(variant.values)) {
        if (!used.has(attribute)) used.set(attribute, new Set());
        used.get(attribute)!.add(value);
      }
  const attributes = s.variantAttributes
    .filter((a) => used.has(a.id))
    .map((a) => ({
      ...a,
      values: [
        ...a.values.filter((v) => used.get(a.id)!.has(v.id)),
        // A value the configuration no longer lists still filters, by its ID.
        ...[...used.get(a.id)!]
          .filter((id) => !a.values.some((v) => v.id === id))
          .map((id) => ({ id, label: id })),
      ],
    }));
  return { s, cards, products, attributes };
}

/** The site's branding (#784): the organisation's where the build carries it, else the default's. */
export interface SiteBrand {
  /** The organisation's product name; undefined: none (the default look names no one). */
  readonly name: string | undefined;
  /** Its logo for light pages and for dark ones (the light one when it has no dark one); undefined: the default mark. */
  readonly logoLight: string | undefined;
  readonly logoDark: string | undefined;
  readonly favicon: string | undefined;
  readonly appIcon: string | undefined;
  /** Whether `brand.css` sets the colours. */
  readonly colours: boolean;
}

export function siteBrand(): SiteBrand {
  const b = snapshot().branding;
  const file = (name: string | null | undefined) =>
    name == null ? undefined : href(`assets/${name}`);
  const colours =
    b?.tokens != null &&
    (Object.keys(b.tokens.light).length > 0 ||
      Object.keys(b.tokens.dark).length > 0);
  return {
    name: b?.productName ?? undefined,
    logoLight: file(b?.logoLight),
    logoDark: file(b?.logoDark ?? b?.logoLight),
    favicon: file(b?.favicon),
    appIcon: file(b?.appIcon),
    colours,
  };
}

/**
 * The brand's colours as a stylesheet (`brand.css`): its tokens over the theme's, light on
 * `:root:not(.dark)` and dark on `:root.dark`, so they win over the theme's `.dark` whatever
 * the order of the stylesheets. Only the token names a brand may set and `#rrggbb` values
 * (the snapshot's schema holds both), so nothing else reaches the CSS.
 */
export function brandCss(): string {
  const tokens = snapshot().branding?.tokens;
  if (!tokens) return '/* No brand colours: the theme’s. */\n';
  const block = (selector: string, values: Record<string, string>) => {
    const lines = Object.entries(values)
      .filter(
        ([name, hex]) => /^[a-z-]+$/.test(name) && /^#[0-9a-f]{6}$/.test(hex),
      )
      .map(([name, hex]) => `  --${name}: ${hex};`);
    return lines.length === 0 ? '' : `${selector} {\n${lines.join('\n')}\n}\n`;
  };
  return (
    block(':root:not(.dark),\n.light', tokens.light) +
    block(':root.dark', tokens.dark)
  );
}
