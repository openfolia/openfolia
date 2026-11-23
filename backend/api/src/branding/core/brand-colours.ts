/**
 * Brand colours (#169): the token set an installation's primary colour (and
 * optional accent) give the editor, for light and dark, with the contrast of
 * every pair that matters checked against the theme's own surfaces
 * (`frontend/theme/src/theme.css`). Pure: no I/O, so the API and its tests
 * share it.
 *
 * What a brand changes: the primary colour (buttons, links, the focus ring,
 * the selected navigation item's icon) and its text colour, the hover and
 * selection highlight (a tint of the primary colour) and, in light, the
 * sidebar's surface and line (a tint of the accent, else of the primary
 * colour). Surfaces, text, status colours and the safety colours are never
 * brandable: they keep the theme's values, and the safety colours carry
 * meaning (ISO 3864 / ANSI Z535).
 */

/** A colour as `#rrggbb`, lowercase. */
export type Hex = `#${string}`;

const HEX = /^#[0-9a-f]{6}$/;

/** Whether `value` is `#rrggbb` (lowercase). */
export const isHex = (value: string): value is Hex => HEX.test(value);

/** A colour in OKLCH: lightness 0–1, chroma ≥ 0, hue in degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

type Rgb = readonly [number, number, number];

const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

function hexToRgb(hex: Hex): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(rgb: Rgb): Hex {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** OKLCH to linear sRGB (Björn Ottosson's OKLab). */
function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** A hex colour in OKLCH. */
export function toOklch(hex: Hex): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as unknown as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c, h: h < 0 ? h + 360 : h };
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * An OKLCH colour as hex; out of the sRGB gamut, its chroma is lowered
 * until it fits (lightness and hue kept).
 */
export function oklchToHex(colour: Oklch): Hex {
  let linear = oklchToLinear(colour);
  if (!inGamut(linear)) {
    let low = 0;
    let high = colour.c;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ ...colour, c: mid }))) low = mid;
      else high = mid;
    }
    linear = oklchToLinear({ ...colour, c: low });
  }
  return rgbToHex(linear.map(linearToSrgb) as unknown as Rgb);
}

/** `oklch(L C H)` as `theme.css` writes it, parsed; undefined for anything else. */
export function parseOklch(css: string): Oklch | undefined {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    css.trim(),
  );
  if (!match) return undefined;
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/** WCAG 2 relative luminance. */
function luminance(hex: Hex): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two colours (1–21). */
export function contrast(a: Hex, b: Hex): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text against its background. */
export const TEXT_CONTRAST = 4.5;
/** A shape or an outline (a button's fill, the focus ring, an icon) against what it sits on. */
export const SHAPE_CONTRAST = 3;

/**
 * The theme's surfaces and text the brand colours are checked against, as
 * `frontend/theme/src/theme.css` writes them (a test keeps them equal).
 * Never changed by a brand.
 */
export const THEME_SURFACES = {
  light: {
    background: 'oklch(0.995 0.0034 67.78)',
    foreground: 'oklch(0.3835 0.0171 207.84)',
    'muted-foreground': 'oklch(0.4957 0.0133 217.66)',
    'sidebar-foreground': 'oklch(0.3835 0.0171 207.84)',
  },
  dark: {
    background: 'oklch(0.2617 0.012 214.56)',
    card: 'oklch(0.2966 0.0142 211.13)',
    sidebar: 'oklch(0.2164 0.0092 208.75)',
    foreground: 'oklch(0.9525 0.0057 128.53)',
  },
} as const;

/** The tokens a brand sets, in both themes; nothing else is ever written. */
export const BRAND_TOKENS = [
  'primary',
  'primary-foreground',
  'ring',
  'accent',
  'sidebar',
  'sidebar-border',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-ring',
] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

/** The tokens of one theme: a subset of `BRAND_TOKENS`, each `#rrggbb`. */
export type ThemeTokens = Partial<Record<BrandToken, Hex>>;

export interface BrandTokens {
  readonly light: ThemeTokens;
  readonly dark: ThemeTokens;
}

/** One pair whose contrast was checked. */
export interface ContrastCheck {
  readonly theme: 'light' | 'dark';
  /** `<foreground>/<background>` by token name, e.g. `primary-foreground/primary`. */
  readonly pair: string;
  /** Which brand colour it comes from. */
  readonly colour: 'primary' | 'accent';
  /** Rounded down to two decimals, so it never reads better than it is. */
  readonly ratio: number;
  readonly required: number;
}

export interface DerivedBrand {
  /** Null when neither colour is set: the theme's defaults apply. */
  readonly tokens: BrandTokens | null;
  readonly checks: readonly ContrastCheck[];
  /** The checks that fail; the brand is refused when there is any. */
  readonly failing: readonly ContrastCheck[];
}

const surface = (css: string): Hex => oklchToHex(parseOklch(css) as Oklch);

/** Dark text on a light primary, light text on a dark one: whichever reads better. */
function textOn(fill: Hex, hue: number): Hex {
  const ink = oklchToHex({ l: 0.2251, c: 0.0373, h: hue });
  const white: Hex = '#ffffff';
  return contrast(white, fill) >= contrast(ink, fill) ? white : ink;
}

/**
 * The primary colour for dark pages: the same hue and chroma made lighter,
 * at least to lightness 0.75 (the default dark primary's) and until it
 * reads as text on the dark page and its cards.
 */
function darkPrimary(primary: Oklch): Hex {
  const background = surface(THEME_SURFACES.dark.background);
  const card = surface(THEME_SURFACES.dark.card);
  for (let l = Math.max(0.75, primary.l); l < 1; l += 0.01) {
    const candidate = oklchToHex({ ...primary, l });
    if (
      contrast(candidate, background) >= TEXT_CONTRAST &&
      contrast(candidate, card) >= TEXT_CONTRAST
    ) {
      return candidate;
    }
  }
  return oklchToHex({ ...primary, l: 0.99 });
}

const floor2 = (n: number) => Math.floor(n * 100) / 100;

/**
 * The tokens `primary` and `accent` give, and the contrast of every pair
 * they make, light and dark:
 *
 * - light: the primary colour as text on the page (4.5:1) and as the
 *   selected item's icon on the sidebar (3:1); its text colour on it
 *   (4.5:1); the theme's text on the hover tint and on the sidebar tint,
 *   its muted text on the sidebar (4.5:1 each);
 * - dark: the lightened primary colour as text on the page and on cards
 *   (4.5:1), as the icon on the sidebar (3:1), its text colour on it
 *   (4.5:1).
 *
 * The admin's primary colour is used as given in light (and refused when it
 * fails there); the dark one is derived. With neither colour set, no
 * tokens: the theme's defaults stay.
 */
export function deriveBrand(
  primary: Hex | null,
  accent: Hex | null,
): DerivedBrand {
  if (primary === null && accent === null) {
    return { tokens: null, checks: [], failing: [] };
  }
  const light: ThemeTokens = {};
  const dark: ThemeTokens = {};
  const checks: ContrastCheck[] = [];
  const check = (
    theme: 'light' | 'dark',
    pair: string,
    colour: 'primary' | 'accent',
    a: Hex,
    b: Hex,
    required: number,
  ) =>
    checks.push({
      theme,
      pair,
      colour,
      ratio: floor2(contrast(a, b)),
      required,
    });

  const lightText = surface(THEME_SURFACES.light.foreground);
  const page = surface(THEME_SURFACES.light.background);
  const tintHue = toOklch((accent ?? primary) as Hex);
  // The sidebar's surface and line, tinted (#f8e9e9 and #e6cfcb by default).
  const sidebar = oklchToHex({
    l: 0.9459,
    c: Math.min(tintHue.c, 0.02),
    h: tintHue.h,
  });
  light.sidebar = sidebar;
  light['sidebar-border'] = oklchToHex({
    l: 0.8724,
    c: Math.min(tintHue.c, 0.0264),
    h: tintHue.h,
  });
  const tintColour = accent === null ? 'primary' : 'accent';
  check(
    'light',
    'sidebar-foreground/sidebar',
    tintColour,
    surface(THEME_SURFACES.light['sidebar-foreground']),
    sidebar,
    TEXT_CONTRAST,
  );
  check(
    'light',
    'muted-foreground/sidebar',
    tintColour,
    surface(THEME_SURFACES.light['muted-foreground']),
    sidebar,
    TEXT_CONTRAST,
  );

  if (primary !== null) {
    const p = toOklch(primary);
    const onPrimary = textOn(primary, p.h);
    light.primary = primary;
    light['primary-foreground'] = onPrimary;
    light.ring = primary;
    light['sidebar-primary'] = primary;
    light['sidebar-primary-foreground'] = onPrimary;
    light['sidebar-ring'] = primary;
    // The hover and selection highlight (#eef4eb by default).
    const highlight = oklchToHex({
      l: 0.9601,
      c: Math.min(p.c, 0.0135),
      h: p.h,
    });
    light.accent = highlight;
    check(
      'light',
      'primary/background',
      'primary',
      primary,
      page,
      TEXT_CONTRAST,
    );
    check(
      'light',
      'primary/sidebar',
      'primary',
      primary,
      sidebar,
      SHAPE_CONTRAST,
    );
    check(
      'light',
      'primary-foreground/primary',
      'primary',
      onPrimary,
      primary,
      TEXT_CONTRAST,
    );
    check(
      'light',
      'foreground/accent',
      'primary',
      lightText,
      highlight,
      TEXT_CONTRAST,
    );

    const night = darkPrimary(p);
    const onNight = textOn(night, p.h);
    dark.primary = night;
    dark['primary-foreground'] = onNight;
    dark.ring = night;
    dark['sidebar-primary'] = night;
    dark['sidebar-primary-foreground'] = onNight;
    dark['sidebar-ring'] = night;
    const d = THEME_SURFACES.dark;
    check(
      'dark',
      'primary/background',
      'primary',
      night,
      surface(d.background),
      TEXT_CONTRAST,
    );
    check(
      'dark',
      'primary/card',
      'primary',
      night,
      surface(d.card),
      TEXT_CONTRAST,
    );
    check(
      'dark',
      'primary/sidebar',
      'primary',
      night,
      surface(d.sidebar),
      SHAPE_CONTRAST,
    );
    check(
      'dark',
      'primary-foreground/primary',
      'primary',
      onNight,
      night,
      TEXT_CONTRAST,
    );
  }

  return {
    tokens: { light, dark },
    checks,
    failing: checks.filter((c) => c.ratio < c.required),
  };
}
