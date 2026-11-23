import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const root = postcss.parse(
  readFileSync(resolve(here, '../src/theme.css'), 'utf8'),
);
const tokensTs = readFileSync(
  resolve(here, '../../editor/src/app/pages/theme/theme-tokens.ts'),
  'utf8',
);
const uiCss = readFileSync(resolve(here, '../../ui/src/styles/ui.css'), 'utf8');

function declared(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(/^--/, (decl) => {
      out.set(decl.prop, decl.value);
    });
  });
  return out;
}

const light = declared(':root');
const dark = declared('.dark');

/** The sRGB relative luminance of an `oklch(L C h [/ a])` value (alpha ignored). */
function luminance(value: string): number {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!m) throw new Error(`not an oklch value: ${value}`);
  const [L, C, h] = [
    Number(m[1]),
    Number(m[2]),
    (Number(m[3]) * Math.PI) / 180,
  ];
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(bl);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [
    number,
    number,
  ];
  return (x + 0.05) / (y + 0.05);
}

const colorTokens = [...light.keys()].filter(
  (n) => !['--radius', '--font-sans', '--font-mono'].includes(n),
);
const fixedTokens = colorTokens.filter((n) => n.startsWith('--safety-'));

describe('theme tokens', () => {
  it('defines every token of the issue, with Zard names', () => {
    for (const name of [
      '--primary',
      '--primary-foreground',
      '--secondary',
      '--secondary-foreground',
      '--background',
      '--foreground',
      '--muted',
      '--muted-foreground',
      '--accent',
      '--accent-foreground',
      '--border',
      '--input',
      '--ring',
      '--radius',
      '--sidebar',
      '--sidebar-foreground',
      '--sidebar-primary',
      '--sidebar-primary-foreground',
      '--sidebar-accent',
      '--sidebar-accent-foreground',
      '--sidebar-border',
      '--sidebar-ring',
      '--destructive',
      '--destructive-muted',
      '--success',
      '--success-muted',
      '--warning',
      '--warning-muted',
      '--info',
      '--info-muted',
      '--safety-danger',
      '--safety-warning',
      '--safety-caution',
      '--safety-notice',
    ]) {
      expect(light.has(name), name).toBe(true);
    }
  });

  it('has a dark value for every colour except the fixed safety colours', () => {
    for (const name of colorTokens) {
      expect(dark.has(name), name).toBe(!fixedTokens.includes(name));
    }
    for (const name of dark.keys()) expect(light.has(name), name).toBe(true);
  });

  it('is listed on screen 0 and mapped to Tailwind, name for name', () => {
    const listed = [...tokensTs.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(light.keys()));
    for (const name of colorTokens) {
      expect(uiCss, name).toContain(`--color-${name.slice(2)}: var(${name});`);
    }
  });

  it('keeps text and background pairs at 4.5:1 or more, in light and dark', () => {
    const pairs: [string, string][] = [
      ['--foreground', '--background'],
      ['--card-foreground', '--card'],
      ['--popover-foreground', '--popover'],
      ['--primary-foreground', '--primary'],
      ['--secondary-foreground', '--secondary'],
      ['--muted-foreground', '--background'],
      ['--accent-foreground', '--accent'],
      ['--sidebar-foreground', '--sidebar'],
      ['--sidebar-primary-foreground', '--sidebar-primary'],
      ['--sidebar-accent-foreground', '--sidebar-accent'],
      ['--destructive', '--destructive-muted'],
      ['--success', '--success-muted'],
      ['--warning', '--warning-muted'],
      ['--info', '--info-muted'],
      ['--destructive', '--background'],
      ['--safety-danger-foreground', '--safety-danger'],
      ['--safety-warning-foreground', '--safety-warning'],
      ['--safety-caution-foreground', '--safety-caution'],
      ['--safety-notice-foreground', '--safety-notice'],
    ];
    for (const [mode, values] of [
      ['light', light],
      ['dark', { get: (n: string) => dark.get(n) ?? light.get(n) }],
    ] as const) {
      for (const [fg, bg] of pairs) {
        const ratio = contrast(values.get(fg)!, values.get(bg)!);
        expect(ratio, `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // The brand accent as text (links, `text-primary`) and as a shape or outline next to a
  // surface: a button's fill, the focus ring, the selected nav item's icon (WCAG 1.4.11: 3:1).
  it('keeps the accent readable as text and visible as a shape, in light and dark', () => {
    const text: [string, string][] = [
      ['--primary', '--background'],
      ['--primary', '--card'],
      ['--primary', '--popover'],
    ];
    const shapes: [string, string][] = [
      ['--primary', '--background'],
      ['--primary', '--card'],
      ['--ring', '--background'],
      ['--ring', '--card'],
      ['--ring', '--popover'],
      ['--sidebar-ring', '--sidebar'],
      ['--sidebar-primary', '--sidebar'],
      ['--sidebar-primary', '--sidebar-accent'],
    ];
    for (const [mode, values] of [
      ['light', light],
      ['dark', { get: (n: string) => dark.get(n) ?? light.get(n) }],
    ] as const) {
      for (const [minimum, list] of [
        [4.5, text],
        [3, shapes],
      ] as const) {
        for (const [fg, bg] of list) {
          const ratio = contrast(values.get(fg)!, values.get(bg)!);
          expect(ratio, `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(
            minimum,
          );
        }
      }
    }
  });
});
