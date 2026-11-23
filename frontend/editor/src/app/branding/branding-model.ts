import type { DocsConfig } from '../../docs.config';
import type { Schema } from '../api';

/** The branding as `GET /branding` answers it. */
export type BrandingResource = Schema<'BrandingResource'>;
export type BrandingAttributes = BrandingResource['attributes'];
/** The fields an admin sets (what `PATCH /branding` takes). */
export type BrandingFields = Omit<BrandingAttributes, 'updatedAt'>;
export type BrandingTokens = NonNullable<BrandingResource['meta']['tokens']>;
export type ThemeTokens = BrandingTokens['light'];

/** The image fields, in the order the admin screen shows them. */
export const IMAGE_FIELDS = [
  'logoLight',
  'logoDark',
  'mark',
  'favicon',
  'appIcon',
] as const satisfies readonly (keyof BrandingFields)[];
export type ImageField = (typeof IMAGE_FIELDS)[number];

/** Must be square (the API refuses another shape). */
export const SQUARE_FIELDS: ReadonlySet<ImageField> = new Set([
  'favicon',
  'appIcon',
]);

/** Every field null: the neutral defaults. */
export const RESET: BrandingFields = {
  productName: null,
  logoLight: null,
  logoDark: null,
  mark: null,
  favicon: null,
  appIcon: null,
  primary: null,
  accent: null,
};

/**
 * The tokens a brand may set, and nothing else: whatever the API answers, a status or a safety
 * colour (`--safety-*`) is never written. Kept equal to the API's `BRAND_TOKENS` by a test.
 */
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

const HEX = /^#[0-9a-f]{6}$/;

/** `sha256:<hash>` → its hash; anything else → null. */
export function hashOf(reference: string | null): string | null {
  const match = reference ? /^sha256:([0-9a-f]{64})$/.exec(reference) : null;
  return match?.[1] ?? null;
}

/** Where a branding image is served (public: the sign-in page shows the logo). */
export function imageUrl(
  apiBase: string,
  reference: string | null,
): string | null {
  const hash = hashOf(reference);
  return hash === null ? null : `${apiBase}/branding/images/${hash}`;
}

/** One theme's declarations: only `BRAND_TOKENS`, only `#rrggbb` values. */
function declarations(tokens: ThemeTokens): string {
  return BRAND_TOKENS.flatMap((name) => {
    const value = tokens[name];
    return value !== undefined && HEX.test(value)
      ? [`--${name}: ${value};`]
      : [];
  }).join(' ');
}

/**
 * The style sheet that lays the brand's tokens over the theme's (`frontend/theme`): light on
 * `:root` and `.light`, dark on `.dark`, after the theme's own rules, so the same specificity wins
 * by order (a `.light` panel under a dark page keeps the light ones, as the theme does). Empty
 * without tokens: the theme's defaults stay.
 */
export function brandingCss(tokens: BrandingTokens | null): string {
  if (!tokens) return '';
  const light = declarations(tokens.light);
  const dark = declarations(tokens.dark);
  return [
    light && `:root:not(.dark), .light { ${light} }`,
    dark && `.dark { ${dark} }`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the shell shows: the config's defaults with the API's branding laid over them. */
export type EffectiveBranding = DocsConfig['branding'];

/**
 * The branding the shell uses: the defaults of `docs.config.ts` where the API's branding leaves a
 * field null. Once the API names any logo or the mark, no default artwork is mixed in: the
 * collapsed sidebar shows the mark (else the app icon, else the favicon, else the default mark),
 * the full logo is the light logo (else the mark next to the name), and a dark logo falls back to
 * the light one. A name of its own without a logo of its own drops the default's full logo (it
 * spells the default name): the default mark shows next to the name. A favicon of the API's replaces the default's PNG sizes; its app icon the
 * home-screen icon.
 */
export function effectiveBranding(
  defaults: DocsConfig['branding'],
  branding: BrandingAttributes | null,
  apiBase: string,
): EffectiveBranding {
  if (!branding) return defaults;
  const url = (field: ImageField) => imageUrl(apiBase, branding[field]);
  const logoLight = url('logoLight');
  const logoDark = url('logoDark');
  const mark = url('mark');
  const favicon = url('favicon');
  const appIcon = url('appIcon');
  const own = logoLight !== null || logoDark !== null || mark !== null;
  const small = mark ?? appIcon ?? favicon;
  return {
    ...defaults,
    productName: branding.productName ?? defaults.productName,
    logo: own
      ? {
          small: small ?? defaults.logo.small,
          ...(small === null && defaults.logo.smallDark
            ? { smallDark: defaults.logo.smallDark }
            : {}),
          ...(logoLight !== null || logoDark !== null
            ? {
                full: (logoLight ?? logoDark) as string,
                fullDark: (logoDark ?? logoLight) as string,
              }
            : {}),
        }
      : branding.productName !== null
        ? wordless(defaults.logo)
        : defaults.logo,
    ...(favicon !== null ? { favicon, faviconPng: undefined } : {}),
    ...(appIcon !== null ? { appleTouchIcon: appIcon } : {}),
  };
}

/** The default logo without its full versions (the wordmark), keeping the mark. */
function wordless(logo: EffectiveBranding['logo']): EffectiveBranding['logo'] {
  return {
    small: logo.small,
    ...(logo.smallDark ? { smallDark: logo.smallDark } : {}),
  };
}

/** A `#rrggbb` the colour inputs take, or null for anything else. */
export function normalHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const full = /^#?([0-9a-f]{6})$/.exec(trimmed);
  if (full) return `#${full[1]}`;
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  return short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
    : null;
}

/** The fields that differ between two brandings (what a `PATCH` sends). */
export function changedFields(
  from: BrandingFields,
  to: BrandingFields,
): Partial<BrandingFields> {
  const changes: Partial<Record<keyof BrandingFields, string | null>> = {};
  for (const key of Object.keys(RESET) as (keyof BrandingFields)[]) {
    if (from[key] !== to[key]) changes[key] = to[key];
  }
  return changes as Partial<BrandingFields>;
}

export const fieldsOf = (a: BrandingAttributes): BrandingFields => ({
  productName: a.productName,
  logoLight: a.logoLight,
  logoDark: a.logoDark,
  mark: a.mark,
  favicon: a.favicon,
  appIcon: a.appIcon,
  primary: a.primary,
  accent: a.accent,
});
