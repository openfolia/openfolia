import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  DEAD_LINKS,
  INTERNAL_CANARY,
  INTERNAL_LINKS,
  OLDER_REVISIONS,
  OLDER_WORD,
  PUBLIC_WORD,
  RESTRICTED_CANARY,
  UNRELEASED_WORD,
} from '../testing/fixture-repo.ts';
import { FIXTURE_OUT } from './global-setup.ts';

/**
 * What the built files hold, read from disk: the fixture release has public, internal and
 * restricted modules and manuals (`testing/fixture-repo.ts`), and words only the internal and
 * restricted ones use. A build may hold nothing above its audience, in any page, script, image
 * or search index file (Pagefind's are gzipped: each is searched decompressed too).
 */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** A file's bytes as text, and decompressed when it is gzip (Pagefind's index and fragments). */
function text(path: string): string {
  const bytes = readFileSync(path);
  let out = bytes.toString('latin1');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    out += '\n' + gunzipSync(bytes).toString('latin1');
  return out.toLowerCase();
}

const holding = (dir: string, word: string) =>
  files(dir)
    .filter((file) => text(file).includes(word.toLowerCase()))
    .map((file) => relative(FIXTURE_OUT, file));

test.describe('the built files', () => {
  // Files, not pages: once is enough.
  test.beforeEach(() =>
    test.skip(test.info().project.name !== 'desktop-light'),
  );

  test('a public build holds no internal or restricted text, its search index included', () => {
    const dir = join(FIXTURE_OUT, 'public');
    expect(holding(dir, INTERNAL_CANARY)).toEqual([]);
    expect(holding(dir, RESTRICTED_CANARY)).toEqual([]);
    // The index was searched: the public word is in it, in both languages.
    for (const lang of ['en', 'de'])
      expect(
        holding(join(dir, lang, 'pagefind'), PUBLIC_WORD).length,
      ).toBeGreaterThan(0);
  });

  test('an internal build holds internal text but nothing restricted', () => {
    const dir = join(FIXTURE_OUT, 'internal');
    expect(
      holding(join(dir, 'en', 'pagefind'), INTERNAL_CANARY).length,
    ).toBeGreaterThan(0);
    expect(holding(dir, INTERNAL_CANARY).some((f) => f.endsWith('.html'))).toBe(
      true,
    );
    expect(holding(dir, RESTRICTED_CANARY)).toEqual([]);
  });

  test('each older release has its own search index, and the newest’s holds none of its text (#896)', () => {
    const dir = join(FIXTURE_OUT, 'internal');
    for (const lang of ['en', 'de']) {
      expect(holding(join(dir, lang, 'pagefind'), OLDER_WORD)).toEqual([]);
      for (const release of OLDER_REVISIONS)
        expect(
          holding(
            join(dir, lang, 'alpha', 'v', release, '_pagefind'),
            OLDER_WORD,
          ).length,
        ).toBeGreaterThan(0);
    }
    // The public site keeps the default: the newest releases only.
    for (const lang of ['en', 'de'])
      expect(existsSync(join(FIXTURE_OUT, 'public', lang, 'alpha', 'v'))).toBe(
        false,
      );
  });

  test('the start page’s links above the audience, or to nothing, are in no file; reported instead (#897)', () => {
    const log = (audience: string) =>
      readFileSync(join(FIXTURE_OUT, `${audience}.log`), 'utf8');
    for (const title of [...INTERNAL_LINKS, ...DEAD_LINKS])
      expect(holding(join(FIXTURE_OUT, 'public', 'en'), title)).toEqual([]);
    // Nor any address of the internal manual, the guide or the manual that is not there.
    for (const path of ['alpha/service/', 'software-update/', 'alpha/gone/'])
      for (const lang of ['en', 'de'])
        expect(holding(join(FIXTURE_OUT, 'public', lang), path)).toEqual([]);
    for (const title of [...INTERNAL_LINKS, ...DEAD_LINKS])
      expect(log('public')).toContain(`Start page en: the link “${title}”`);
    for (const title of INTERNAL_LINKS) {
      expect(holding(join(FIXTURE_OUT, 'internal', 'en'), title)).toEqual([
        join('internal', 'en', 'index.html'),
      ]);
      expect(log('internal')).not.toContain(title);
    }
    for (const title of DEAD_LINKS) {
      expect(holding(join(FIXTURE_OUT, 'internal', 'en'), title)).toEqual([]);
      expect(log('internal')).toContain(title);
    }
  });

  test('an edit of the start page that no release holds is in no file (#897)', () => {
    expect(holding(FIXTURE_OUT, UNRELEASED_WORD)).toEqual([]);
  });

  test('no build holds a service token', () => {
    expect(holding(FIXTURE_OUT, 'ccms_sat_')).toEqual([]);
  });

  test('no file can run at the site: no SVG, every page under a policy without inline script', () => {
    for (const file of files(FIXTURE_OUT)) {
      const name = relative(FIXTURE_OUT, file);
      if (name.includes('/assets/')) {
        // The fixture's symbol is an SVG with a script in it: drawn to a PNG, never copied.
        expect(name).not.toMatch(/\.svg$/);
        expect(text(file)).not.toContain('<script');
      }
      if (!name.endsWith('.html')) continue;
      const html = readFileSync(file, 'utf8');
      expect(html, name).toContain('http-equiv="Content-Security-Policy"');
      // Every script is a file: none has a body of its own, none is an event handler.
      for (const [, attributes, body] of html.matchAll(
        /<script([^>]*)>([\s\S]*?)<\/script>/g,
      )) {
        expect(attributes, name).toMatch(/\ssrc="/);
        expect((body ?? '').trim(), name).toBe('');
      }
      expect(html, name).not.toMatch(/\son[a-z]+=/i);
    }
  });

  test('images and attachments are the files the build wrote, by hash', () => {
    const assets = readdirSync(join(FIXTURE_OUT, 'public', 'en', 'assets'));
    expect(
      assets.every((name) => /^[0-9a-f]{64}\.(png|json)$/.test(name)),
    ).toBe(true);
    expect(assets.filter((name) => name.endsWith('.png'))).toHaveLength(2);
  });
});
