import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { LANGUAGE_TAG } from '../src/lib/snapshot.ts';

/** What one run of the portal build needs (`.env.example`, "Portal"). */
export interface PortalSettings {
  /** The API's base URL. */
  readonly apiUrl: URL;
  /** A service account token (`ccms_sat_…`) whose roles read only released content, up to `audience`. */
  readonly token: string;
  /** The audience level the build is for: nothing above it reaches the site. */
  readonly audience: string;
  /** The languages to build, one site each; undefined: every configured language. */
  readonly languages: readonly string[] | undefined;
  /**
   * Release IDs to build; undefined: each product's `releasesPerProduct` newest releases that
   * are not withdrawn. A product's newest built release is at today's addresses, its older ones
   * under `<product>/v/<release>/` (#896).
   */
  readonly releases: readonly string[] | undefined;
  /** How many of each product's newest releases to build when `releases` is unset (default 1). */
  readonly releasesPerProduct: number;
  /** Older releases' pages ask search engines not to index them (default true). */
  readonly olderNoindex: boolean;
  /** Where the sites go: `<outDir>/<lang>/`. */
  readonly outDir: string;
  /** The path the sites are served under (`/` or `/docs/`): each language at `<basePath><lang>/`. */
  readonly basePath: string;
  /** The organisation's branding (`GET /branding`) on the site; false: OpenFolia's default look. */
  readonly branding: boolean;
  /** The manuals that may be the start page (#897), by ID: the first there is; undefined: the default one. */
  readonly start: readonly string[] | undefined;
  /** The portal's own address as an origin, for the start page's links to its pages; undefined: not set. */
  readonly portalOrigin: string | undefined;
}

export class SettingsError extends Error {}

/** The most releases per product a build takes (`CCMS_PORTAL_RELEASES_PER_PRODUCT`): each is a whole site's worth of pages. */
export const MAX_RELEASES_PER_PRODUCT = 20;

const ConfigKey = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ReleaseId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `SERVICE_TOKEN_PATTERN` of the API (`backend/api/src/access/core/service-token.ts`). */
export const SERVICE_TOKEN = /^ccms_sat_[0-9a-f]{16}_[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const list = (value: string | undefined) =>
  value === undefined || value.trim() === ''
    ? undefined
    : value.split(',').map((item) => item.trim());

const Env = z.object({
  CCMS_PORTAL_API_URL: z.string({ error: 'is required' }),
  CCMS_PORTAL_TOKEN: z.string({ error: 'is required' }),
  CCMS_PORTAL_AUDIENCE: z
    .string({ error: 'is required' })
    .regex(ConfigKey, 'an audience level ID, e.g. public'),
  CCMS_PORTAL_LANGUAGES: z.string().optional(),
  CCMS_PORTAL_RELEASES: z.string().optional(),
  CCMS_PORTAL_RELEASES_PER_PRODUCT: z.string().optional(),
  CCMS_PORTAL_OLDER_NOINDEX: z
    .enum(['on', 'off'], { error: 'on or off' })
    .optional(),
  CCMS_PORTAL_OUT_DIR: z.string().optional(),
  CCMS_PORTAL_BASE_PATH: z.string().optional(),
  CCMS_PORTAL_BRANDING: z
    .enum(['on', 'off'], { error: 'on or off' })
    .optional(),
  CCMS_PORTAL_START: z.string().optional(),
  CCMS_PORTAL_URL: z.string().optional(),
  CCMS_PORTAL_HTTP_HOSTS: z.string().optional(),
});

/** A host name as `URL` writes one: lowercase labels of letters, digits and hyphens. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The settings from the environment. Every message names the setting, never its value: the
 * token must not reach a log, and the others are not worth the risk of a mix-up.
 */
export function readSettings(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): PortalSettings {
  const parsed = Env.safeParse(
    Object.fromEntries(
      Object.keys(Env.shape).map((key) => [
        key,
        env[key] === '' ? undefined : env[key],
      ]),
    ),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettingsError(
      `${String(issue?.path[0] ?? 'settings')}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const e = parsed.data;
  let apiUrl: URL;
  try {
    apiUrl = new URL(e.CCMS_PORTAL_API_URL);
  } catch {
    throw new SettingsError('CCMS_PORTAL_API_URL: not an absolute URL');
  }
  if (apiUrl.protocol !== 'https:' && apiUrl.protocol !== 'http:')
    throw new SettingsError('CCMS_PORTAL_API_URL: http or https only');
  // The token goes in a header on every request: never in plain text across a network, but
  // to this machine or a host named in CCMS_PORTAL_HTTP_HOSTS (the API's service on a
  // container network of its own, deploy/compose.yaml).
  const httpHosts = list(e.CCMS_PORTAL_HTTP_HOSTS)?.map((h) => h.toLowerCase());
  if (httpHosts?.some((host) => !HOST_NAME.test(host)))
    throw new SettingsError(
      'CCMS_PORTAL_HTTP_HOSTS: comma-separated host names, e.g. api',
    );
  if (
    apiUrl.protocol === 'http:' &&
    !LOOPBACK.has(apiUrl.hostname) &&
    !httpHosts?.includes(apiUrl.hostname)
  )
    throw new SettingsError(
      'CCMS_PORTAL_API_URL: https, or http only to this machine (127.0.0.1, localhost, [::1]) or a host of CCMS_PORTAL_HTTP_HOSTS',
    );
  if (
    apiUrl.username !== '' ||
    apiUrl.password !== '' ||
    apiUrl.search !== '' ||
    apiUrl.hash !== ''
  )
    throw new SettingsError(
      'CCMS_PORTAL_API_URL: no user, password, query or fragment',
    );
  if (!SERVICE_TOKEN.test(e.CCMS_PORTAL_TOKEN))
    throw new SettingsError(
      'CCMS_PORTAL_TOKEN: a service account token (ccms_sat_…)',
    );
  const languages = list(e.CCMS_PORTAL_LANGUAGES);
  if (languages?.some((lang) => !LANGUAGE_TAG.test(lang)))
    throw new SettingsError(
      'CCMS_PORTAL_LANGUAGES: comma-separated language tags',
    );
  // Each is a folder: on a case-insensitive file system `en` and `EN` would be one.
  if (
    languages !== undefined &&
    new Set(languages.map((l) => l.toLowerCase())).size !==
      new Set(languages).size
  )
    throw new SettingsError(
      'CCMS_PORTAL_LANGUAGES: two languages differ only in case',
    );
  const releases = list(e.CCMS_PORTAL_RELEASES);
  if (releases?.some((id) => !ReleaseId.test(id)))
    throw new SettingsError(
      'CCMS_PORTAL_RELEASES: comma-separated release IDs',
    );
  const perProduct = e.CCMS_PORTAL_RELEASES_PER_PRODUCT?.trim();
  if (
    perProduct !== undefined &&
    (!/^\d{1,2}$/.test(perProduct) ||
      Number(perProduct) < 1 ||
      Number(perProduct) > MAX_RELEASES_PER_PRODUCT)
  )
    throw new SettingsError(
      `CCMS_PORTAL_RELEASES_PER_PRODUCT: a whole number from 1 to ${MAX_RELEASES_PER_PRODUCT}`,
    );
  if (perProduct !== undefined && releases !== undefined)
    throw new SettingsError(
      'CCMS_PORTAL_RELEASES_PER_PRODUCT: not with CCMS_PORTAL_RELEASES, which names the releases itself',
    );
  const basePath = e.CCMS_PORTAL_BASE_PATH ?? '/';
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(basePath))
    throw new SettingsError(
      'CCMS_PORTAL_BASE_PATH: a path starting and ending with "/", e.g. /docs/',
    );
  const start = list(e.CCMS_PORTAL_START);
  if (start?.some((id) => !ConfigKey.test(id)))
    throw new SettingsError(
      'CCMS_PORTAL_START: comma-separated manual IDs, e.g. portal-start',
    );
  let portalOrigin: string | undefined;
  if (e.CCMS_PORTAL_URL !== undefined) {
    const wrong = new SettingsError(
      'CCMS_PORTAL_URL: the portal’s own address, e.g. https://docs.example.com, with no path but CCMS_PORTAL_BASE_PATH',
    );
    let url: URL;
    try {
      url = new URL(e.CCMS_PORTAL_URL);
    } catch {
      throw wrong;
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !['/', basePath].includes(url.pathname.replace(/\/?$/, '/'))
    )
      throw wrong;
    portalOrigin = url.origin;
  }
  const outDir = resolve(cwd, e.CCMS_PORTAL_OUT_DIR ?? 'dist');
  // The folder is replaced as a whole: never the one the build runs in, or one holding it.
  // `cwd` relative to `outDir`: inside it unless that climbs out (`..` as a whole first segment, not a folder named `..x`).
  const inside = relative(outDir, cwd);
  const outside =
    isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`);
  if (dirname(outDir) === outDir || inside === '' || !outside)
    throw new SettingsError(
      'CCMS_PORTAL_OUT_DIR: a folder of its own, not the current folder or one that holds it',
    );
  return {
    apiUrl: new URL(
      apiUrl.href.endsWith('/') ? apiUrl.href : `${apiUrl.href}/`,
    ),
    token: e.CCMS_PORTAL_TOKEN,
    audience: e.CCMS_PORTAL_AUDIENCE,
    languages: languages && [...new Set(languages)],
    releases: releases && [...new Set(releases)],
    releasesPerProduct: perProduct === undefined ? 1 : Number(perProduct),
    olderNoindex: e.CCMS_PORTAL_OLDER_NOINDEX !== 'off',
    outDir,
    basePath,
    branding: e.CCMS_PORTAL_BRANDING !== 'off',
    start,
    portalOrigin,
  };
}
