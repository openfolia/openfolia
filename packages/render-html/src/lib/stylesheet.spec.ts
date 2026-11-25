import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderManualHtml } from './render.js';
import { resolve as resolveFixture } from '../testing/fixture.js';

// The shipped stylesheet against the theme and the renderer: plain CSS on
// the theme's variables only, scoped to the rendered fragment, and every
// class the renderer writes is styled-or-documented and documented.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../render-html.css'), 'utf8');
const theme = readFileSync(
  resolve(here, '../../../../frontend/theme/src/theme.css'),
  'utf8',
);
const readme = readFileSync(resolve(here, '../../README.md'), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

const defined = (text: string) =>
  new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));

function renderedClasses(): Set<string> {
  const classes = new Set<string>();
  for (const lang of ['en', 'de']) {
    for (const model of ['small', 'large']) {
      const { html } = renderManualHtml(resolveFixture(model, lang).manual, {
        assetUrl: (h) => `/a/${h}`,
        symbolUrl: (s) => `/s/${s}`,
      });
      for (const m of html.matchAll(/class="([^"]*)"/g)) {
        for (const c of (m[1] as string).split(' ')) classes.add(c);
      }
    }
  }
  return classes;
}

describe('render-html.css', () => {
  it('writes no colour: every colour comes from the theme', () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(
      /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i,
    );
    expect(rules).not.toMatch(
      /\b(?:color|background(?:-color)?|border(?:-color)?)\s*:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i,
    );
  });

  it('uses only variables the theme (or this file) defines', () => {
    const available = new Set([...defined(theme), ...defined(rules)]);
    const used = [...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((v) => !available.has(v))).toEqual([]);
  });

  it('scopes every rule under .of-content', () => {
    /** Splits a selector list at its top-level commas (not those inside `:where(…)`). */
    const split = (list: string) => {
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of list) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
        } else current += ch;
      }
      return [...parts, current.trim()];
    };
    const selectors = [...rules.matchAll(/([^{}]+)\{/g)].flatMap((m) =>
      split(m[1] as string),
    );
    expect(selectors.length).toBeGreaterThan(10);
    // A media or supports query only wraps rules, which are checked themselves.
    expect(
      selectors.filter(
        (s) =>
          !s.startsWith('.of-content') &&
          !s.startsWith('@media ') &&
          !s.startsWith('@supports '),
      ),
    ).toEqual([]);
  });

  it('gives each severity its fixed safety colour', () => {
    for (const severity of ['danger', 'warning', 'caution', 'notice']) {
      expect(rules).toContain(`.of-safety--${severity} {`);
      expect(rules).toContain(`var(--safety-${severity})`);
      expect(rules).toContain(`var(--safety-${severity}-foreground)`);
    }
  });

  it('documents in the README every class the renderer writes', () => {
    const classes = renderedClasses();
    expect(classes.size).toBeGreaterThan(30);
    expect([...classes].filter((c) => !readme.includes(`\`${c}\``))).toEqual(
      [],
    );
  });
});
