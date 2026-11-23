import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from './api-client.ts';
import { fetchSnapshots, writeSnapshot } from './fetch.ts';
import { linkedFiles } from '../src/lib/snapshot.ts';

/** The portal project's folder. */
export const PORTAL_ROOT = resolve(import.meta.dirname, '..');

export interface BuildOptions {
  readonly apiUrl: URL;
  readonly token: string;
  readonly audience: string;
  readonly languages: readonly string[] | undefined;
  readonly releases: readonly string[] | undefined;
  readonly outDir: string;
  readonly basePath: string;
  /** The organisation's branding on the site (default true); false: the default look. */
  readonly branding?: boolean;
  readonly log?: (line: string) => void;
}

/**
 * One audience's sites, one per language: fetch (and check) everything first, then build each
 * language with Astro and index it with Pagefind. Nothing is written into `outDir` before every
 * language's content passed the audience checks, and `outDir` is replaced as a whole.
 */
export async function buildPortal(options: BuildOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const client = new ApiClient(options.apiUrl, options.token);
  const staging = mkdtempSync(join(tmpdir(), 'openfolia-portal-'));
  const next = `${options.outDir}.next`;
  try {
    // The files go to the staging folder as they arrive, never into `outDir`.
    const assetsDir = join(staging, 'assets');
    const builds = await fetchSnapshots(client, {
      audience: options.audience,
      languages: options.languages,
      releases: options.releases,
      branding: options.branding ?? true,
      assetsDir,
      log,
    });
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });
    for (const build of builds) {
      const dir = join(staging, 'snapshots', build.lang);
      writeSnapshot(dir, build);
      const site = join(next, build.lang);
      await astroBuild({
        snapshot: join(dir, 'snapshot.json'),
        outDir: site,
        base: `${options.basePath}${build.lang}/`,
      });
      // Only the files this language's pages link.
      mkdirSync(join(site, 'assets'), { recursive: true });
      for (const file of linkedFiles(build.snapshot))
        copyFileSync(join(assetsDir, file), join(site, 'assets', file));
      await pagefindIndex(site, build.lang);
      log(`${build.lang}: built`);
    }
    writeFileSync(
      join(next, 'index.html'),
      languageIndex(
        builds.map((b) => b.lang),
        options.basePath,
      ),
    );
    refuseToken(next, options.token);
    replaceOutput(next, options.outDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(next, { recursive: true, force: true });
  }
}

/**
 * `next` takes the place of `outDir`, swapped by renaming (same parent folder): the old output
 * stays whole until the new one is in place, and is put back when the new one cannot be moved
 * in. `rename` is for tests.
 */
export function replaceOutput(
  next: string,
  outDir: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const old = `${outDir}.old`;
  // A previous run that could not put its old output back left it here: restore it, never delete it.
  if (!existsSync(outDir) && existsSync(old)) rename(old, outDir);
  rmSync(old, { recursive: true, force: true });
  const had = existsSync(outDir);
  if (had) rename(outDir, old);
  try {
    rename(next, outDir);
  } catch (error) {
    if (had)
      try {
        rename(old, outDir);
      } catch {
        throw new Error(
          `the new output could not be moved in, nor the previous one back: it is at ${old}`,
          { cause: error },
        );
      }
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

/**
 * `astro build` in a process of its own whose environment holds only what the pages read: the
 * token is never in it, so no page, plugin or bundle can take it from `process.env` or
 * `import.meta.env`.
 */
function astroBuild(site: {
  snapshot: string;
  outDir: string;
  base: string;
}): Promise<void> {
  const env: Record<string, string> = {
    CCMS_PORTAL_SNAPSHOT: site.snapshot,
    CCMS_PORTAL_SITE_OUT: site.outDir,
    CCMS_PORTAL_SITE_BASE: site.base,
    ASTRO_TELEMETRY_DISABLED: '1',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'LANG'])
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const astro = join(PORTAL_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [astro, 'build', '--silent'], {
      cwd: PORTAL_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0
        ? done()
        : fail(new Error(`astro build failed (${code ?? 'signal'})`)),
    );
  });
}

async function pagefindIndex(site: string, lang: string): Promise<void> {
  const pagefind = await import('pagefind');
  try {
    const { index, errors } = await pagefind.createIndex({
      forceLanguage: lang,
    });
    if (!index) throw new Error(`pagefind: ${errors.join('; ')}`);
    const added = await index.addDirectory({ path: site });
    if (added.errors.length > 0)
      throw new Error(`pagefind: ${added.errors.join('; ')}`);
    const written = await index.writeFiles({
      outputPath: join(site, 'pagefind'),
    });
    if (written.errors.length > 0)
      throw new Error(`pagefind: ${written.errors.join('; ')}`);
  } finally {
    await pagefind.close();
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page at the root: the languages built, the first one opened. */
function languageIndex(languages: readonly string[], basePath: string): string {
  const name = (lang: string) =>
    escapeHtml(
      new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang,
    );
  const first = languages[0]!;
  const links = languages
    .map(
      (lang) =>
        `<li><a href="${basePath}${lang}/" lang="${lang}" hreflang="${lang}">${name(lang)}</a></li>`,
    )
    .join('');
  return `<!doctype html><html lang="${first}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0; url=${basePath}${first}/"><title>${name(first)}</title></head><body><ul>${links}</ul></body></html>\n`;
}

/** A last check: the token (or its secret part) in no file of the output. */
export function refuseToken(dir: string, token: string): void {
  const secret = token.slice(token.lastIndexOf('_') + 1);
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file);
      else {
        const bytes = readFileSync(file);
        if (bytes.includes(token) || bytes.includes(secret))
          throw new Error(
            `the output holds the token (${file.slice(dir.length + 1)}): nothing was published`,
          );
      }
    }
  };
  walk(dir);
}
