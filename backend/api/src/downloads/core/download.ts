import {
  BlockId,
  ConfigKey,
  LanguageTag,
  ModuleId,
} from '@openfolia/content-model';
import { foldKeyword } from '../../content/core/module-filter.js';
import type { Release } from '../../releases/core/release.js';

/**
 * The download centre (#139): a read model over what already exists, never a store of its own.
 * A download is one attachment block of a module (#236: module, block and language) or one PDF
 * of a manual (#249: manual, variant and language), of one product, as its releases hold it. A
 * release holds the whole repository, so a product's downloads are the attachments of the
 * modules for that product (their product facet names it, or names no product) and every
 * manual's PDFs.
 */
export const DOWNLOAD_KINDS = ['attachment', 'manual'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

/** What a download is, as its ID names it (`downloadId`). */
export type DownloadKey =
  | {
      readonly kind: 'attachment';
      readonly product: string;
      readonly moduleId: string;
      readonly blockId: string;
      readonly lang: string;
    }
  | {
      readonly kind: 'manual';
      readonly product: string;
      readonly manualId: string;
      readonly lang: string;
      /** The variant's slug (`variantSlug`), e.g. `model=large`. */
      readonly variant: string;
    };

/** The longest variant slug a download ID takes. */
const MAX_VARIANT = 1_000;
/** A variant slug's characters (`variantSlug`): no `:` and nothing a path would split on. */
const VARIANT_SLUG = /^[A-Za-z0-9.=,~;_-]*$/;

/**
 * A download's ID: `attachment:<product>:<module>:<block>:<lang>` or
 * `manual:<product>:<manual>:<lang>:<variant>`. None of the parts holds a `:`, and the variant,
 * which may be long, comes last. Stable across releases: a download's versions share it.
 */
export function downloadId(key: DownloadKey): string {
  return key.kind === 'attachment'
    ? `attachment:${key.product}:${key.moduleId}:${key.blockId}:${key.lang}`
    : `manual:${key.product}:${key.manualId}:${key.lang}:${key.variant}`;
}

/** The download an ID names (`downloadId`); undefined for anything that is not one. */
export function parseDownloadId(id: string): DownloadKey | undefined {
  const [kind, product, subject, fourth, ...rest] = id.split(':');
  if (
    product === undefined ||
    subject === undefined ||
    fourth === undefined ||
    rest.length !== 1 ||
    !ConfigKey.safeParse(product).success
  ) {
    return undefined;
  }
  const last = rest[0] as string;
  if (kind === 'attachment') {
    if (
      !ModuleId.safeParse(subject).success ||
      !BlockId.safeParse(fourth).success ||
      !LanguageTag.safeParse(last).success
    ) {
      return undefined;
    }
    return {
      kind,
      product,
      moduleId: subject,
      blockId: fourth,
      lang: last,
    };
  }
  if (kind === 'manual') {
    if (
      !ModuleId.safeParse(subject).success ||
      !LanguageTag.safeParse(fourth).success ||
      last.length > MAX_VARIANT ||
      !VARIANT_SLUG.test(last)
    ) {
      return undefined;
    }
    return { kind, product, manualId: subject, lang: fourth, variant: last };
  }
  return undefined;
}

/**
 * Whether a module is for `product` (#139): its values of the product facet name it, or it
 * names no value of that facet (it is for every product).
 */
export function isForProduct(
  facets: Readonly<Record<string, readonly string[]>>,
  productFacet: string,
  product: string,
): boolean {
  const values = facets[productFacet];
  return (
    values === undefined || values.length === 0 || values.includes(product)
  );
}

/** The file a download is at one release: what its versions compare. */
export interface DownloadFile {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** The name it is saved under. */
  readonly fileName: string;
  /** The attachment's description at that release; null for none and for a manual. */
  readonly description: string | null;
}

/** A current download: the file at its product's latest release (`ListDownloadsAction`). */
export interface Download extends DownloadFile {
  readonly id: string;
  readonly key: DownloadKey;
  /** The attachment's name (its link text), or the manual's title. */
  readonly name: string;
  /** The product's latest release, which holds this file. */
  readonly release: Release;
  /** The module it is attached in, its title; null for a manual. */
  readonly moduleTitle: string | null;
}

/** Which downloads to list; every field optional. */
export interface DownloadFilter {
  readonly product?: string;
  readonly lang?: string;
  readonly kind?: DownloadKind;
  /** Words each found in the name, description, file name, module title or ID (folded). */
  readonly q?: string;
  /** A media type (`application/pdf`), or a top-level type (`image/*`). */
  readonly mediaType?: string;
}

/** Whether a download passes `filter`'s language, kind, words and media type. */
export function matchesDownload(
  download: Download,
  filter: DownloadFilter,
): boolean {
  if (filter.lang !== undefined && download.key.lang !== filter.lang) {
    return false;
  }
  if (filter.kind !== undefined && download.key.kind !== filter.kind) {
    return false;
  }
  if (filter.mediaType !== undefined) {
    const wanted = filter.mediaType;
    const matches = wanted.endsWith('/*')
      ? download.mediaType.startsWith(wanted.slice(0, -1))
      : download.mediaType === wanted;
    if (!matches) return false;
  }
  if (filter.q !== undefined) {
    const words = foldKeyword(filter.q).split(' ').filter(Boolean);
    const text = [
      download.name,
      download.description ?? '',
      download.fileName,
      download.moduleTitle ?? '',
      download.key.kind === 'attachment'
        ? download.key.moduleId
        : download.key.manualId,
    ]
      .map(foldKeyword)
      .join('\n');
    if (!words.every((word) => text.includes(word))) return false;
  }
  return true;
}

/** How many of a product's newest releases a download's versions are looked for in. */
export const MAX_VERSION_RELEASES = 500;

/**
 * Where a version stands: `current`, the file the product's latest release holds;
 * `withdrawn`, every release that held it is withdrawn (#138); `superseded`, a later file
 * took its place.
 */
export const VERSION_STATES = ['current', 'superseded', 'withdrawn'] as const;
export type VersionState = (typeof VERSION_STATES)[number];

/** One version of a download: a file, from the release it first appeared in. */
export interface DownloadVersion extends DownloadFile {
  /** The release in which the file's hash changed to this one. */
  readonly release: Release;
  readonly state: VersionState;
  /** That release's notes in the download's language (else its notes); null for none. */
  readonly notes: string | null;
}

/** What one release holds of a download: its file, or none (absent, or not readable there). */
export interface Observation {
  readonly release: Release;
  readonly file: DownloadFile | undefined;
}

/**
 * A download's versions (#139) from what each release holds of it (`observed`, newest first):
 * a version for each release whose file's hash differs from the one the last version has (a
 * release that holds none is passed over), newest first. A version is `current` when the
 * product's latest release (`latestId`: the newest that stands, cut from `main`) holds it,
 * `withdrawn` when every release holding it is, else `superseded`. Its notes are those of the
 * release it first appeared in, in `lang` when that release has them.
 */
export function versionsOf(
  observed: readonly Observation[],
  latestId: string | undefined,
  lang: string,
): DownloadVersion[] {
  const groups: { file: DownloadFile; releases: Release[] }[] = [];
  for (const { release, file } of [...observed].reverse()) {
    if (!file) continue;
    const last = groups.at(-1);
    if (last && last.file.sha256 === file.sha256) {
      last.releases.push(release);
    } else {
      groups.push({ file, releases: [release] });
    }
  }
  return groups.reverse().map(({ file, releases }) => {
    const first = releases[0] as Release;
    const state: VersionState = releases.some((r) => r.id === latestId)
      ? 'current'
      : releases.every((r) => r.withdrawal !== null)
        ? 'withdrawn'
        : 'superseded';
    return {
      ...file,
      release: first,
      state,
      notes: first.notesByLanguage[lang] ?? first.notes,
    };
  });
}
