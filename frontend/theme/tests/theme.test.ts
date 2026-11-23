import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const css = readFileSync(resolve(srcDir, 'theme.css'), 'utf8');
const root = postcss.parse(css);

describe('theme.css', () => {
  it('is plain CSS: no framework at-rules and no imports', () => {
    const atRules = new Set<string>();
    root.walkAtRules((rule) => {
      atRules.add(rule.name);
    });
    expect([...atRules]).toEqual(['font-face']);
  });

  it('serves every font file it references from the package (no third-party host)', () => {
    const urls: string[] = [];
    root.walkDecls('src', (decl) => {
      for (const match of decl.value.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
        urls.push(match[1] as string);
      }
    });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/^(https?:)?\/\//);
      expect(existsSync(resolve(srcDir, url))).toBe(true);
    }
  });

  it('defines the variables the UI library reads', () => {
    const names = new Set<string>();
    root.walkDecls(/^--/, (decl) => {
      names.add(decl.prop);
    });
    for (const name of [
      '--background',
      '--foreground',
      '--primary',
      '--primary-foreground',
      '--border',
      '--ring',
      '--radius',
      '--font-sans',
      '--font-mono',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
