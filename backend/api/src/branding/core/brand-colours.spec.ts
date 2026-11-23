import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BRAND_TOKENS,
  contrast,
  deriveBrand,
  type Hex,
  type Oklch,
  isHex,
  oklchToHex,
  parseOklch,
  SHAPE_CONTRAST,
  TEXT_CONTRAST,
  THEME_SURFACES,
  toOklch,
} from './brand-colours.js';

const THEME_CSS = fileURLToPath(
  new URL('../../../../../frontend/theme/src/theme.css', import.meta.url),
);

/** The declarations of the theme's light (`:root, .light`) and dark (`.dark`) blocks. */
function themeBlocks(): {
  light: Map<string, string>;
  dark: Map<string, string>;
} {
  const css = readFileSync(THEME_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: RegExp) => {
    const body = selector.exec(css)?.[1] ?? '';
    return new Map(
      [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1] as string,
        (m[2] as string).trim(),
      ]),
    );
  };
  return {
    light: block(/:root,\s*\.light\s*\{([^}]*)\}/),
    dark: block(/\.dark\s*\{([^}]*)\}/),
  };
}

describe('colour maths', () => {
  it('recognises #rrggbb only', () => {
    expect(isHex('#4a7740')).toBe(true);
    expect(isHex('#4A7740')).toBe(false);
    expect(isHex('#fff')).toBe(false);
    expect(isHex('4a7740')).toBe(false);
    expect(isHex('#4a7740;')).toBe(false);
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
    // The theme's own figure: the UI green at 5.2:1 on white-ish paper.
    expect(contrast('#4a7740', '#fffdfb')).toBeCloseTo(5.15, 1);
  });

  it('turns hex into OKLCH and back', () => {
    for (const hex of ['#4a7740', '#fffdfb', '#151b1c', '#cc3366'] as Hex[]) {
      expect(oklchToHex(toOklch(hex))).toBe(hex);
    }
    // The theme's UI green, as theme.css writes it.
    expect(oklchToHex({ l: 0.5222, c: 0.0965, h: 139.98 })).toBe('#4a7740');
  });

  it('brings a colour outside sRGB into the gamut by its chroma', () => {
    const hex = oklchToHex({ l: 0.7, c: 0.5, h: 140 });
    expect(isHex(hex)).toBe(true);
    expect(toOklch(hex).l).toBeCloseTo(0.7, 1);
  });
});

describe('the theme surfaces brand colours are checked against', () => {
  it('are the values theme.css holds', () => {
    const { light, dark } = themeBlocks();
    for (const [name, value] of Object.entries(THEME_SURFACES.light)) {
      expect(light.get(name), name).toBe(value);
    }
    for (const [name, value] of Object.entries(THEME_SURFACES.dark)) {
      expect(dark.get(name), name).toBe(value);
    }
  });

  it('name only tokens theme.css defines, never a status or safety colour', () => {
    const { light, dark } = themeBlocks();
    for (const token of BRAND_TOKENS) {
      expect(light.has(token), token).toBe(true);
      expect(dark.has(token), token).toBe(true);
      expect(token).not.toMatch(/^(safety|destructive|success|warning|info)/);
    }
  });

  it('are the tokens the editor writes (`frontend/editor`, branding-model.ts)', () => {
    const editor = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../frontend/editor/src/app/branding/branding-model.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const list = /export const BRAND_TOKENS = \[([\s\S]*?)\] as const/.exec(
      editor,
    )?.[1];
    const names = [...(list ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...BRAND_TOKENS]);
  });

  it('parse as OKLCH', () => {
    expect(parseOklch('oklch(0.995 0.0034 67.78)')).toEqual({
      l: 0.995,
      c: 0.0034,
      h: 67.78,
    });
    expect(parseOklch('#fff')).toBeUndefined();
  });
});

describe('deriveBrand', () => {
  it('sets nothing without colours: the theme’s defaults stay', () => {
    expect(deriveBrand(null, null)).toEqual({
      tokens: null,
      checks: [],
      failing: [],
    });
  });

  it('keeps the primary colour as given in light and derives a lighter one for dark', () => {
    const { tokens, failing, checks } = deriveBrand('#4a7740', null);
    expect(failing).toEqual([]);
    expect(tokens?.light.primary).toBe('#4a7740');
    expect(tokens?.light.ring).toBe('#4a7740');
    expect(tokens?.light['sidebar-primary']).toBe('#4a7740');
    expect(tokens?.light['primary-foreground']).toBe('#ffffff');
    const night = tokens?.dark.primary as Hex;
    expect(toOklch(night).l).toBeGreaterThan(toOklch('#4a7740').l);
    expect(Math.abs(toOklch(night).h - toOklch('#4a7740').h)).toBeLessThan(3);
    // Dark text on the light dark-mode primary.
    expect(
      contrast(tokens?.dark['primary-foreground'] as Hex, night),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(checks.map((c) => `${c.theme} ${c.pair}`)).toEqual([
      'light sidebar-foreground/sidebar',
      'light muted-foreground/sidebar',
      'light primary/background',
      'light primary/sidebar',
      'light primary-foreground/primary',
      'light foreground/accent',
      'dark primary/background',
      'dark primary/card',
      'dark primary/sidebar',
      'dark primary-foreground/primary',
    ]);
  });

  it('derives only tokens of BRAND_TOKENS, as #rrggbb', () => {
    const { tokens } = deriveBrand('#1d4ed8', '#f59e0b');
    for (const theme of [tokens?.light, tokens?.dark]) {
      for (const [name, value] of Object.entries(theme ?? {})) {
        expect(BRAND_TOKENS).toContain(name);
        expect(isHex(value)).toBe(true);
      }
    }
  });

  it('refuses a primary colour too light to read on the page, naming the pair and the ratio', () => {
    const { failing } = deriveBrand('#8fc07f', null);
    expect(failing).toContainEqual({
      theme: 'light',
      pair: 'primary/background',
      colour: 'primary',
      ratio: expect.any(Number),
      required: TEXT_CONTRAST,
    });
    expect(failing.every((f) => f.ratio < f.required)).toBe(true);
  });

  it('refuses yellow, whose text on it never reaches 4.5:1 either way round', () => {
    const { failing } = deriveBrand('#ffff00', null);
    expect(failing.map((f) => f.pair)).toContain('primary/background');
  });

  it('passes every check for dark, saturated primaries across the hues', () => {
    for (const hex of [
      '#1d4ed8',
      '#b91c1c',
      '#6d28d9',
      '#0f766e',
      '#9a3412',
      '#000000',
    ] as Hex[]) {
      const { failing, tokens } = deriveBrand(hex, null);
      expect(failing, hex).toEqual([]);
      expect(
        contrast(
          tokens?.dark.primary as Hex,
          oklchToHex(parseOklch(THEME_SURFACES.dark.background) as Oklch),
        ),
        hex,
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    }
  });

  it('tints the light sidebar with the accent, keeping its text readable', () => {
    const { tokens, failing } = deriveBrand(null, '#e11d48');
    expect(failing).toEqual([]);
    expect(tokens?.light.sidebar).toBeDefined();
    expect(tokens?.light.primary).toBeUndefined();
    expect(tokens?.dark).toEqual({});
    const hue = toOklch(tokens?.light.sidebar as Hex).h;
    expect(Math.abs(hue - toOklch('#e11d48').h)).toBeLessThan(10);
  });

  it('checks shapes at 3:1 and text at 4.5:1', () => {
    const { checks } = deriveBrand('#4a7740', null);
    expect(checks.find((c) => c.pair === 'primary/sidebar')?.required).toBe(
      SHAPE_CONTRAST,
    );
    expect(checks.find((c) => c.pair === 'primary/background')?.required).toBe(
      TEXT_CONTRAST,
    );
  });
});
