import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePdf } from './compile.js';
import { DEFAULT_TEMPLATE } from './template.js';
import {
  lightTokens,
  PRINT_FONTS,
  printTheme,
  typstTokens,
  typstValue,
} from './tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(
  resolve(here, '../../../../frontend/theme/src/theme.css'),
  'utf8',
);
const previewCss = readFileSync(
  resolve(here, '../../../render-html/src/render-html.css'),
  'utf8',
);

describe('typstValue', () => {
  it('carries colours, lengths and font names over to Typst', () => {
    expect(typstValue('oklch(0.145 0 0)')).toBe('oklch(14.5%, 0, 0deg)');
    expect(typstValue('oklch(0.577 0.245 27.325)')).toBe(
      'oklch(57.7%, 0.245, 27.325deg)',
    );
    expect(typstValue('oklch(1 0 0 / 10%)')).toBe('oklch(100%, 0, 0deg, 10%)');
    expect(typstValue('oklch(50% 0.1 20deg / 0.5)')).toBe(
      'oklch(50%, 0.1, 20deg, 50%)',
    );
    expect(typstValue('0.625rem')).toBe('0.625em');
    expect(typstValue(`'Geist', ui-sans-serif, system-ui, sans-serif`)).toBe(
      '("Geist",)',
    );
    expect(typstValue('"Geist Mono", ui-monospace, monospace')).toBe(
      '("Geist Mono",)',
    );
    expect(typstValue('rgb(0 0 0)')).toBeUndefined();
    expect(typstValue('ui-monospace')).toBeUndefined();
  });
});

describe('typstTokens', () => {
  it('carries every light token of the theme over, and no dark one', () => {
    const tokens = typstTokens(themeCss);
    const names = lightTokens(themeCss).map(([name]) => name);
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) expect(tokens).toContain(`\n  ${name}: `);
    // The light values, never the dark ones.
    expect(tokens).toContain('  background: oklch(99.5%, 0.0034, 67.78deg),');
    expect(tokens).toContain('  foreground: oklch(38.35%, 0.0171, 207.84deg),');
    // The fixed safety colours, the radius and the fonts.
    expect(tokens).toContain('  safety-danger: oklch(50%, 0.2, 27deg),');
    expect(tokens).toContain('  radius: 0.625em,');
    expect(tokens).toContain(
      '  font-sans: ("Geist", "Noto Sans Arabic", "Noto Sans Hebrew",),',
    );
    expect(tokens).toContain('  font-mono: ("Geist Mono",),');
  });

  it('reads every :root rule, a later value winning, and a last declaration without ";"', () => {
    const css = [
      "@font-face { font-family: 'X'; src: url('x.woff2'); }",
      ':root, .light { --a: 1rem; --b: 2rem }',
      '.dark { --a: 9rem; }',
      ':root { --b: 3rem; --c: oklch(0.5 0.1 20) }',
      '@media print { :root { --a: 7rem; } }',
    ].join('\n');
    expect(lightTokens(css)).toEqual([
      ['a', '1rem'],
      ['b', '3rem'],
      ['c', 'oklch(0.5 0.1 20)'],
    ]);
  });

  it('refuses a token it cannot carry over, so none goes missing', () => {
    expect(() =>
      typstTokens(':root {\n  --shadow: 0 1px 2px black;\n}\n'),
    ).toThrow(/--shadow/);
    expect(() => typstTokens('.dark { --background: oklch(0 0 0); }')).toThrow(
      /no :root block/,
    );
  });

  it('is a module every template can import', () => {
    const source = [
      '#import "tokens.typ": theme',
      '#set document(title: "T")',
      '#set text(font: theme.font-sans, fill: theme.foreground)',
      '#box(fill: theme.safety-caution, radius: theme.radius)[x]',
    ].join('\n');
    expect(compilePdf({ source }).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('printTheme', () => {
  it("finds the theme's TTF fonts with their licence", () => {
    const { fontDir } = printTheme();
    const files = readdirSync(fontDir);
    expect(files).toContain('LICENSE.txt');
    expect(readFileSync(join(fontDir, 'LICENSE.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    );
    for (const font of PRINT_FONTS) {
      expect(existsSync(join(fontDir, font)), font).toBe(true);
    }
  });
});

describe('the default template against the preview stylesheet', () => {
  it("uses the preview's heading scale", () => {
    const size = (tag: string) =>
      new RegExp(`:where\\(${tag}\\)\\s*\\{\\s*font-size:\\s*([\\d.]+em)`).exec(
        previewCss,
      )?.[1];
    const scale = [size('h1'), size('h2'), size('h3')].join(', ');
    expect(scale).toBe('2em, 1.5em, 1.25em');
    expect(DEFAULT_TEMPLATE).toContain(`let size = (${scale}).at(`);
  });
});
