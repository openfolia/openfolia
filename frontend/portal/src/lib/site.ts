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
  parseSnapshot,
  type Snapshot,
  type SnapshotGuide,
  type SnapshotManual,
  type SnapshotRelease,
  type SnapshotStep,
  type SnapshotVariant,
} from './snapshot.ts';

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
  readonly release: SnapshotRelease;
  readonly manual: SnapshotManual;
  readonly variant: SnapshotVariant;
}

/** Every manual page of the build: one per release, manual and variant (update guides have their own). */
export function manualPages(): ManualPage[] {
  return snapshot().releases.flatMap((release) =>
    release.manuals.flatMap((manual) =>
      manual.guide
        ? []
        : manual.variants.map((variant) => ({ release, manual, variant })),
    ),
  );
}

export const manualPath = (
  release: SnapshotRelease,
  manual: SnapshotManual,
  variant: SnapshotVariant,
) => `${release.product}/${manual.id}/${variant.slug}/`;

export interface GuidePage {
  readonly release: SnapshotRelease;
  readonly manual: SnapshotManual & { guide: SnapshotGuide };
  /** The guide's resolved manual: its steps' text. */
  readonly variant: SnapshotVariant;
}

/** Every update guide page of the build (#907): one per release and guide. */
export function guidePages(): GuidePage[] {
  return snapshot().releases.flatMap((release) =>
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

/** An update guide's page: one per guide, whatever its variants. */
export const guidePath = (release: SnapshotRelease, manual: SnapshotManual) =>
  `${release.product}/${manual.id}/`;

/** Where a list links a manual: its first variant's page, an update guide's own page. */
export const entryPath = (release: SnapshotRelease, manual: SnapshotManual) =>
  manual.guide
    ? guidePath(release, manual)
    : manualPath(release, manual, manual.variants[0]!);

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
