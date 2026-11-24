import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  labelsIn,
  type LocalizedText,
  textIn,
  variantLabel,
} from '@openfolia/content-model/core';
import type { ResolvedManual } from '@openfolia/content-model';
import { renderManualHtml } from '@openfolia/render-html';
import {
  type ApiClient,
  ApiError,
  type JsonApiResource,
} from './api-client.ts';
import {
  attachmentAsset,
  brandingImageAsset,
  imageAsset,
  pdfAsset,
  symbolAsset,
  AssetError,
} from './assets.ts';
import {
  AudienceError,
  checkManual,
  checkModules,
  checkReader,
  modulesOf,
} from './audience.ts';
import {
  audienceRank,
  BRAND_TOKENS,
  linkedFiles,
  parseSnapshot,
  SEGMENT,
  SNAPSHOT_FORMAT,
  type Snapshot,
  type SnapshotBranding,
  type SnapshotManual,
  type SnapshotPdf,
  type SnapshotRelease,
  LANGUAGE_TAG,
} from '../src/lib/snapshot.ts';

export interface FetchOptions {
  readonly audience: string;
  /** The languages to build; undefined: every configured one. */
  readonly languages: readonly string[] | undefined;
  readonly releases: readonly string[] | undefined;
  /**
   * Where the images, attachments and symbols go, each written once as it arrives (named by
   * its hash, so every language shares it): no build holds the files in memory.
   */
  readonly assetsDir: string;
  /** The organisation's branding (`GET /branding`) on the site; false: the default look. */
  readonly branding: boolean;
  /** Progress lines (never a credential). */
  readonly log: (line: string) => void;
}

/**
 * What the build reads of a release's configuration. Labels are one text or one per language
 * (#731): each build shows them in its language (`labelsIn`), else in the source language.
 */
interface Config {
  languages: {
    source: string;
    targets: string[];
    direction?: Record<string, string>;
  };
  audiences: { id: string; label: LocalizedText }[];
  facets: {
    id: string;
    label: LocalizedText;
    values: { id: string; label: LocalizedText }[];
  }[];
  variantAttributes: {
    id: string;
    label: LocalizedText;
    kind: string;
    values?: { id: string; label: LocalizedText }[];
  }[];
  safetySymbols: { id: string; label: LocalizedText }[];
  outputLabels?: Record<string, unknown>;
}

/** What `fetchSnapshots` gives: per language, the snapshot (its files are in `assetsDir`, `snapshot.assets` and `snapshot.symbols` name them). */
export interface FetchedBuild {
  readonly lang: string;
  readonly snapshot: Snapshot;
}

/** A text that is one string or one per language (#731), else the API gave something else. */
const localized = (value: unknown, what: string): LocalizedText => {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
    return value as Record<string, string>;
  throw new ApiError(`the API gave no ${what}`, 0, undefined);
};

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string')
    throw new ApiError(`${what}: not a string`, 200, undefined);
  return value;
};

/** `https://…/x` paths of the API take IDs as path segments: only IDs this build would write. */
const segment = (value: string, what: string): string => {
  if (!SEGMENT.test(value))
    throw new ApiError(
      `a ${what} ID is not a safe path segment`,
      200,
      undefined,
    );
  return value;
};

/**
 * Reads, for each language, everything one build shows from the API, at release tags only, as
 * the token's service account sees it, and refuses (throws, writing nothing) when any of it is
 * above `audience`.
 */
export async function fetchSnapshots(
  client: ApiClient,
  options: FetchOptions,
): Promise<FetchedBuild[]> {
  const { audience, log } = options;
  const me = await client.resource('/me');
  const releases = await chooseReleases(client, options.releases);
  if (releases.length === 0) throw new NothingReleased();

  // The audience levels come from the newest release's configuration; every release's own is checked too.
  const configs = new Map<string, Config>();
  for (const release of releases) {
    const tag = str(release.attributes['tag'], 'release tag');
    configs.set(
      tag,
      (await client.resource('/config', { ref: tag }))
        .attributes as unknown as Config,
    );
  }
  const newest = configs.get(str(releases[0]!.attributes['tag'], 'tag'))!;
  for (const config of configs.values())
    checkReader(me, config.audiences, audience);
  log(
    `The token reads at most "${audience}": building ${releases.length} release(s).`,
  );

  const configured = [newest.languages.source, ...newest.languages.targets];
  // Each is a folder of the output: only a plain language tag, whatever the API says.
  for (const lang of configured)
    if (typeof lang !== 'string' || !LANGUAGE_TAG.test(lang))
      throw new ApiError(
        'a configured language is not a language tag',
        0,
        undefined,
      );
  // On a case-insensitive file system two such folders would be one.
  if (new Set(configured.map((l) => l.toLowerCase())).size < configured.length)
    throw new ApiError(
      'two configured languages differ only in case',
      0,
      undefined,
    );
  const languages = options.languages ?? configured;
  for (const lang of languages)
    if (!configured.includes(lang))
      throw new ApiError(`language ${lang} is not configured`, 0, undefined);

  // Across languages and releases: each file is fetched and written once per use, a refused one
  // (null) too. Keyed by use and hash (`image:…`, `attachment:…`): one hash may be both.
  mkdirSync(options.assetsDir, { recursive: true });
  const fetched = new Map<string, string | null>();
  const symbolFiles = new Map<string, string | null>();
  const write = (file: string, bytes: Uint8Array) => {
    const path = join(options.assetsDir, file);
    if (!existsSync(path)) writeFileSync(path, bytes);
  };

  const branding = options.branding
    ? await readBranding(client, write, log)
    : null;

  const builds: FetchedBuild[] = [];
  for (const lang of languages) {
    const assets: Record<string, string> = {};
    const symbols: Record<string, string> = {};
    const out: SnapshotRelease[] = [];
    for (const release of releases) {
      const tag = str(release.attributes['tag'], 'release tag');
      const config = configs.get(tag)!;
      const shown = labelsIn(config, lang);
      const product = segment(
        str(release.attributes['product'], 'product'),
        'product',
      );
      const facet = shown.facets.find(
        (f) => f.id === release.attributes['productFacet'],
      );
      const manuals = await readManuals(
        client,
        tag,
        lang,
        config,
        audience,
        log,
      );
      await attachPdfs(
        client,
        str(release.id, 'release id'),
        str(release.attributes['revision'], 'revision'),
        lang,
        manuals,
        config,
        audience,
        write,
        log,
      );
      // Images, attachments and symbols the manuals show: found by rendering them once.
      for (const manual of manuals)
        for (const variant of manual.variants) {
          const {
            assets: images,
            attachments,
            symbols: used,
          } = renderManualHtml(variant.resolved as unknown as ResolvedManual, {
            assetUrl: () => '#',
            symbolUrl: () => '#',
            outputLabels: config.outputLabels as never,
          });
          for (const ref of images) {
            const hash = ref.replace(/^sha256:/, '');
            const key = `image:${hash}`;
            if (!fetched.has(key)) {
              const { bytes } = await client.bytes(`/assets/${hash}`, {
                ref: tag,
              });
              try {
                // A hash mismatch is no AssetError: it fails the build.
                const asset = await imageAsset(hash, bytes);
                write(asset.file, asset.bytes);
                fetched.set(key, asset.file);
              } catch (error) {
                // A figure the site cannot serve safely (a type it does not know, an SVG that reaches
                // outside itself): left out, its alternative text stays; the rest is built.
                if (!(error instanceof AssetError)) throw error;
                log(`Image ${hash} left out: ${error.message}`);
                fetched.set(key, null);
              }
            }
            const file = fetched.get(key);
            // The pages link a hash to one file: the first use's.
            if (file != null) assets[hash] ??= file;
          }
          for (const ref of attachments) {
            const hash = ref.replace(/^sha256:/, '');
            const key = `attachment:${hash}`;
            if (!fetched.has(key)) {
              const { bytes, contentType } = await client.bytes(
                `/assets/${hash}`,
                { ref: tag },
              );
              // The server's type when it knows one, else the block's (both only name an extension; the bytes are checked).
              const declared = attachmentTypes(variant.resolved).get(hash);
              const asset = attachmentAsset(
                hash,
                bytes,
                contentType === 'application/octet-stream' || contentType === ''
                  ? declared
                  : contentType,
              );
              write(asset.file, asset.bytes);
              fetched.set(key, asset.file);
            }
            const file = fetched.get(key);
            if (file != null) assets[hash] ??= file;
          }
          downloadAsWritten(variant.resolved, assets);
          for (const id of used) {
            if (!symbolFiles.has(id)) {
              try {
                const { bytes } = await client.bytes(
                  `/symbols/${segment(id, 'symbol')}`,
                  { ref: tag },
                );
                const asset = await symbolAsset(id, bytes);
                write(asset.file, asset.bytes);
                symbolFiles.set(id, asset.file);
              } catch (error) {
                // A symbol without artwork (404) or one that cannot be drawn safely: its label shows instead.
                if (
                  !(error instanceof AssetError) &&
                  !(error instanceof ApiError && error.status === 404)
                )
                  throw error;
                log(`Symbol ${id} left out: ${error.message}`);
                symbolFiles.set(id, null);
              }
            }
            const file = symbolFiles.get(id);
            if (file != null) symbols[id] = file;
          }
        }
      // A product with nothing for this audience is not offered at all.
      if (manuals.length === 0) continue;
      out.push({
        id: str(release.id, 'release id'),
        product,
        productLabel:
          facet?.values.find((v) => v.id === product)?.label ?? product,
        revision: str(release.attributes['revision'], 'revision'),
        tag,
        publishedAt: str(release.attributes['publishedAt'], 'publishedAt'),
        notes:
          (
            release.attributes['notesByLanguage'] as
              Record<string, string> | undefined
          )?.[lang] ??
          (release.attributes['notes'] as string | null | undefined) ??
          null,
        manuals,
      });
    }
    const direction = newest.languages.direction?.[lang];
    const labels = labelsIn(newest, lang);
    const snapshot = parseSnapshot({
      format: SNAPSHOT_FORMAT,
      audience,
      audiences: labels.audiences.map(({ id, label }) => ({ id, label })),
      lang,
      dir: direction === 'rtl' ? 'rtl' : 'ltr',
      languages: [...languages],
      variantAttributes: labels.variantAttributes.map((a) => ({
        id: a.id,
        label: a.label,
        values: (a.values ?? []).map(({ id, label }) => ({ id, label })),
      })),
      safetySymbols: labels.safetySymbols.map(({ id, label }) => ({
        id,
        label,
      })),
      outputLabels: newest.outputLabels ?? {},
      releases: out,
      assets,
      symbols,
      branding,
    });
    const files = linkedFiles(snapshot).size;
    log(
      `${lang}: ${out.reduce((n, r) => n + r.manuals.length, 0)} manual(s), ${files} file(s).`,
    );
    builds.push({ lang, snapshot });
  }
  return builds;
}

/** No release to build: none is published, or each one is withdrawn. Not a failure of the build. */
export class NothingReleased extends Error {
  constructor() {
    super('no release to build: none is published (or all are withdrawn)');
  }
}

/** The releases asked for, or each product's newest that is not withdrawn; newest first. */
async function chooseReleases(
  client: ApiClient,
  ids: readonly string[] | undefined,
): Promise<JsonApiResource[]> {
  if (ids !== undefined) {
    const chosen = await Promise.all(
      ids.map((id) => client.resource(`/releases/${id.toLowerCase()}`)),
    );
    const products = new Set<string>();
    for (const release of chosen) {
      if (release.attributes['withdrawal'] !== null)
        throw new ApiError(`release ${release.id} is withdrawn`, 0, undefined);
      // A product's pages have one address per manual and variant: one release each.
      const product = String(release.attributes['product']);
      if (products.has(product))
        throw new ApiError(
          `two releases of one product (${release.id}): a portal shows one release per product`,
          0,
          undefined,
        );
      products.add(product);
    }
    return chosen.sort((a, b) =>
      String(b.attributes['publishedAt']).localeCompare(
        String(a.attributes['publishedAt']),
      ),
    );
  }
  const all = await client.list('/releases', { 'filter[state]': 'published' });
  const latest = new Map<string, JsonApiResource>();
  for (const release of all) {
    const product = String(release.attributes['product']);
    if (release.attributes['withdrawal'] === null && !latest.has(product))
      latest.set(product, release);
  }
  return [...latest.values()];
}

/** The manuals at `tag` in `lang`, each variant resolved, every module's audience checked. */
async function readManuals(
  client: ApiClient,
  tag: string,
  lang: string,
  config: Config,
  audience: string,
  log: (line: string) => void,
): Promise<SnapshotManual[]> {
  // Each module's audience: the strictest of its files in this language and the source language (a missing translation falls back to it).
  const audiences = new Map<string, string>();
  for (const module of await client.list('/modules', { ref: tag })) {
    const id = String(module.attributes['moduleId']);
    const fileLang = String(module.attributes['lang']);
    if (fileLang !== lang && fileLang !== config.languages.source) continue;
    const own = module.attributes['audience'];
    const level =
      typeof own === 'string'
        ? own
        : config.audiences[config.audiences.length - 1]!.id;
    const before = audiences.get(id);
    const rank = (a: string | undefined) =>
      audienceRank(config.audiences, a) ?? Number.MAX_SAFE_INTEGER;
    if (before === undefined || rank(level) > rank(before))
      audiences.set(id, level);
  }
  const manuals: SnapshotManual[] = [];
  for (const manual of await client.list('/manuals', { ref: tag })) {
    if ('error' in (manual.meta ?? {})) continue;
    const id = segment(manual.id, 'manual');
    const own = manual.attributes['audience'];
    const manualAudience = checkManual(
      { id, audience: typeof own === 'string' ? own : undefined },
      config.audiences,
      audience,
    );
    const variants = (manual.meta?.['variants'] ?? []) as {
      slug: string;
      label: string;
      values: Record<string, string>;
    }[];
    const out: SnapshotManual['variants'] = [];
    for (const variant of variants) {
      const slug = segment(variant.slug, 'variant');
      let resolved: JsonApiResource;
      try {
        resolved = await client.resource(
          `/manuals/${id}/variants/${encodeURIComponent(slug)}/${lang}`,
          { ref: tag },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          log(`${id} ${slug} ${lang}: not found, left out`);
          continue;
        }
        throw error;
      }
      const moduleAudiences = checkModules(
        id,
        modulesOf(resolved.attributes),
        (module) => audiences.get(module),
        config.audiences,
        audience,
      );
      out.push({
        slug,
        // In this build's language (#731); the API's label is the source language's.
        label: variantLabel(variant.values, config, lang),
        values: variant.values,
        resolved: resolved.attributes,
        moduleAudiences,
        pdf: null,
      });
    }
    if (out.length > 0)
      manuals.push({
        id,
        title: textIn(
          localized(manual.attributes['title'], 'title'),
          lang,
          config.languages.source,
        ),
        audience: manualAudience,
        variants: out,
      });
  }
  return manuals;
}

const BRANDING_IMAGES = [
  'logoLight',
  'logoDark',
  'mark',
  'favicon',
  'appIcon',
] as const;

/**
 * The organisation's branding (#784): `GET /branding` (public), its images from
 * `GET /branding/images/{hash}`, each checked against its hash and written under `assets/`.
 * An image the site cannot take is left out (the default shows); colours whose contrast checks
 * fail (the API refuses such a brand, so only an API in error answers them) are left out too.
 * Null when nothing is set: the default look.
 */
async function readBranding(
  client: ApiClient,
  write: (file: string, bytes: Uint8Array) => void,
  log: (line: string) => void,
): Promise<SnapshotBranding | null> {
  let branding: JsonApiResource;
  try {
    branding = await client.resource('/branding');
  } catch (error) {
    // An API from before the branding (#169) has none: the default look.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    log('Branding: none (the API has no GET /branding)');
    return null;
  }
  const a = branding.attributes;
  const meta = branding.meta ?? {};
  const images = {} as Record<(typeof BRANDING_IMAGES)[number], string | null>;
  for (const slot of BRANDING_IMAGES) {
    images[slot] = null;
    const ref = a[slot];
    if (ref === null || ref === undefined) continue;
    const hash = /^sha256:([0-9a-f]{64})$/.exec(String(ref))?.[1];
    if (hash === undefined) {
      log(`Branding ${slot} left out: not an image reference`);
      continue;
    }
    try {
      const { bytes } = await client.bytes(`/branding/images/${hash}`);
      const asset = brandingImageAsset(hash, bytes);
      write(asset.file, asset.bytes);
      images[slot] = asset.file;
    } catch (error) {
      // Gone since GET /branding (changed meanwhile), too large, or no PNG/WebP: the default
      // shows. A token the API refuses, a server error, or bytes that lie about their hash fail.
      const skip =
        error instanceof AssetError ||
        (error instanceof ApiError &&
          error.status !== 0 &&
          error.status < 500 &&
          error.status !== 401 &&
          error.status !== 403);
      if (!skip) throw error;
      log(
        `Branding ${slot} left out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const tokens = brandTokens(meta['tokens'], meta['contrast'], log);
  const name = a['productName'];
  const productName =
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.length <= 100 &&
    /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u.test(name)
      ? name.trim()
      : null;
  if (
    productName === null &&
    tokens === null &&
    Object.values(images).every((file) => file === null)
  )
    return null;
  log(
    `Branding: ${productName ?? 'no name'}, ${Object.values(images).filter((f) => f !== null).length} image(s), ${tokens === null ? 'default' : 'brand'} colours.`,
  );
  return { productName, ...images, tokens };
}

/** The brand's tokens, only names the theme lets a brand set and `#rrggbb` values; null when its contrast checks fail. */
function brandTokens(
  value: unknown,
  contrast: unknown,
  log: (line: string) => void,
): SnapshotBranding['tokens'] {
  if (typeof value !== 'object' || value === null) return null;
  if (!Array.isArray(contrast)) {
    log('Branding colours left out: the API sent no contrast checks for them');
    return null;
  }
  const failing = contrast.filter(
    (c: { ratio?: unknown; required?: unknown }) =>
      typeof c?.ratio !== 'number' ||
      typeof c?.required !== 'number' ||
      c.ratio < c.required,
  );
  if (failing.length > 0) {
    log('Branding colours left out: their contrast is too low');
    return null;
  }
  const pick = (theme: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof theme !== 'object' || theme === null) return out;
    for (const token of BRAND_TOKENS) {
      const hex = (theme as Record<string, unknown>)[token];
      if (typeof hex === 'string' && /^#[0-9a-f]{6}$/.test(hex))
        out[token] = hex;
    }
    return out;
  };
  const { light, dark } = value as { light?: unknown; dark?: unknown };
  return { light: pick(light), dark: pick(dark) };
}

/** A file name part of ASCII letters, digits, `.` and `-` (as the API's own download name). */
const namePart = (value: string) =>
  value.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'x';

/**
 * Each variant's PDF in `lang` (#784): the release's `done` outputs (`GET /releases/{id}/outputs`),
 * each file checked against its hash and written under `assets/`. An output above the build's
 * audience refuses the build, as a manual would; a release without outputs (none rendered yet,
 * or an API without them) builds without its PDFs.
 */
async function attachPdfs(
  client: ApiClient,
  releaseId: string,
  revision: string,
  lang: string,
  manuals: SnapshotManual[],
  config: Config,
  audience: string,
  write: (file: string, bytes: Uint8Array) => void,
  log: (line: string) => void,
): Promise<void> {
  if (manuals.length === 0) return;
  let outputs: JsonApiResource[];
  try {
    outputs = await client.list(
      `/releases/${segment(releaseId, 'release')}/outputs`,
      {
        'filter[kind]': 'pdf',
        'filter[state]': 'done',
        'filter[lang]': lang,
      },
    );
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.status !== 404 && error.status !== 403)
    )
      throw error;
    log(`Release ${releaseId} ${lang}: no PDFs (${error.message})`);
    return;
  }
  const limit = audienceRank(config.audiences, audience)!;
  const byVariant = new Map<string, JsonApiResource>();
  for (const output of outputs) {
    const o = output.attributes;
    if (o['kind'] !== 'pdf' || o['state'] !== 'done' || o['lang'] !== lang)
      continue;
    byVariant.set(
      `${String(o['manual'])}\u0000${String(o['variant'])}`,
      output,
    );
  }
  for (const manual of manuals)
    for (const variant of manual.variants) {
      const output = byVariant.get(`${manual.id}\u0000${variant.slug}`);
      if (output === undefined) continue;
      const o = output.attributes;
      // A manual's PDF is rendered as the manual's audience reads it, and the API sends no
      // audience for it (only an offline package has one): the manual was checked against
      // the build's audience above. An audience the API does send must be within it too.
      const rank =
        o['audience'] === null || o['audience'] === undefined
          ? limit
          : audienceRank(
              config.audiences,
              typeof o['audience'] === 'string' ? o['audience'] : undefined,
            );
      if (rank === undefined || rank > limit)
        throw new AudienceError(
          `the PDF of manual ${manual.id} is for "${String(o['audience'])}", above the build's audience "${audience}": the token reads more than it should`,
        );
      const hash = typeof o['sha256'] === 'string' ? o['sha256'] : '';
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      let pdf: SnapshotPdf;
      try {
        const { bytes } = await client.bytes(
          `/releases/${releaseId}/outputs/${segment(output.id, 'output')}/file`,
        );
        const asset = pdfAsset(hash, bytes);
        write(asset.file, asset.bytes);
        pdf = {
          file: asset.file,
          size: asset.bytes.byteLength,
          name: `${[manual.id, variant.slug, lang, revision].map(namePart).join('_')}.pdf`.slice(
            -200,
          ),
        };
      } catch (error) {
        // Not ready after all (409), gone (404), too large, or not a PDF: the page offers none.
        // A token the API refuses (401, 403) or a server error fails the build.
        if (
          !(error instanceof AssetError) &&
          !(
            error instanceof ApiError &&
            error.status !== 0 &&
            error.status < 500 &&
            error.status !== 401 &&
            error.status !== 403
          )
        )
          throw error;
        log(
          `PDF of ${manual.id} ${variant.slug} ${lang} left out: ${error.message}`,
        );
        continue;
      }
      variant.pdf = pdf;
    }
}

/** The media type each attachment block of a resolved manual declares, by its asset's hash. */
function attachmentTypes(resolved: unknown): Map<string, string> {
  const types = new Map<string, string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      const node = value as Record<string, unknown>;
      if (
        node['type'] === 'attachment' &&
        typeof node['asset'] === 'string' &&
        typeof node['mediaType'] === 'string'
      )
        types.set(node['asset'].replace(/^sha256:/, ''), node['mediaType']);
      Object.values(node).forEach(walk);
    }
  };
  walk(resolved);
  return types;
}

/** The media type each extension the build writes is served as. */
const WRITTEN_TYPE: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  bin: 'application/octet-stream',
};

/**
 * An attachment is offered for download as what the build wrote: the link's `download` name
 * takes the written file's extension, and the type it shows that extension's type, never the
 * original name's (a `page.html` written as `.txt` or `.bin`, saved and opened, would be a
 * page again).
 */
function downloadAsWritten(
  resolved: unknown,
  assets: Readonly<Record<string, string>>,
): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      const node = value as Record<string, unknown>;
      if (node['type'] === 'attachment' && typeof node['asset'] === 'string') {
        const file = assets[node['asset'].replace(/^sha256:/, '')];
        const ext = file?.slice(file.lastIndexOf('.') + 1);
        if (ext !== undefined && WRITTEN_TYPE[ext] !== undefined) {
          const name =
            typeof node['fileName'] === 'string' ? node['fileName'] : '';
          const stem = name.replace(/\.[^.]*$/, '') || 'download';
          node['fileName'] = `${stem}.${ext}`;
          node['mediaType'] = WRITTEN_TYPE[ext];
        }
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(resolved);
}

/** Writes a build's snapshot into `dir` (the build's staging folder for one language). */
export function writeSnapshot(dir: string, build: FetchedBuild): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(build.snapshot));
}

export { AudienceError };
