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
  /** Release IDs to build; undefined: each product's newest release that is not withdrawn. */
  readonly releases: readonly string[] | undefined;
  /** Where the sites go: `<outDir>/<lang>/`. */
  readonly outDir: string;
  /** The path the sites are served under (`/` or `/docs/`): each language at `<basePath><lang>/`. */
  readonly basePath: string;
  /** The organisation's branding (`GET /branding`) on the site; false: OpenFolia's default look. */
  readonly branding: boolean;
}

export class SettingsError extends Error {}

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
  CCMS_PORTAL_OUT_DIR: z.string().optional(),
  CCMS_PORTAL_BASE_PATH: z.string().optional(),
  CCMS_PORTAL_BRANDING: z
    .enum(['on', 'off'], { error: 'on or off' })
    .optional(),
});

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
  // The token goes in a header on every request: never in plain text across a network.
  if (apiUrl.protocol === 'http:' && !LOOPBACK.has(apiUrl.hostname))
    throw new SettingsError(
      'CCMS_PORTAL_API_URL: https, or http only to this machine (127.0.0.1, localhost, [::1])',
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
  const basePath = e.CCMS_PORTAL_BASE_PATH ?? '/';
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(basePath))
    throw new SettingsError(
      'CCMS_PORTAL_BASE_PATH: a path starting and ending with "/", e.g. /docs/',
    );
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
    outDir,
    basePath,
    branding: e.CCMS_PORTAL_BRANDING !== 'off',
  };
}
