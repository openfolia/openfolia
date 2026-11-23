import { docsConfig } from '../../docs.config';
import {
  BRAND_TOKENS,
  brandingCss,
  type BrandingAttributes,
  changedFields,
  effectiveBranding,
  hashOf,
  imageUrl,
  normalHex,
  RESET,
} from './branding-model';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const attributes = (
  over: Partial<BrandingAttributes> = {},
): BrandingAttributes => ({
  ...RESET,
  updatedAt: null,
  ...over,
});

describe('branding model', () => {
  it('never names a status or safety colour', () => {
    for (const token of BRAND_TOKENS) {
      expect(token).not.toMatch(/safety|destructive|success|warning|info/);
    }
  });

  it('reads hashes and makes the public image address', () => {
    expect(hashOf(`sha256:${A}`)).toBe(A);
    expect(hashOf('sha256:nope')).toBeNull();
    expect(hashOf(null)).toBeNull();
    expect(imageUrl('/api', `sha256:${A}`)).toBe(`/api/branding/images/${A}`);
    expect(imageUrl('/api', null)).toBeNull();
  });

  it('writes the tokens light on :root and .light, dark on .dark, and only #rrggbb values of known tokens', () => {
    const css = brandingCss({
      light: { primary: '#1d4ed8', 'primary-foreground': '#ffffff' },
      dark: {
        primary: '#93b4ff',
        // Neither a known token nor a colour: never written.
        ...({ 'safety-danger': '#000000', ring: 'red; }' } as object),
      },
    });
    expect(css).toBe(
      [
        ':root:not(.dark), .light { --primary: #1d4ed8; --primary-foreground: #ffffff; }',
        '.dark { --primary: #93b4ff; }',
      ].join('\n'),
    );
    expect(brandingCss(null)).toBe('');
    expect(brandingCss({ light: {}, dark: {} })).toBe('');
  });

  it('keeps the defaults without a branding, or where its fields are null', () => {
    expect(effectiveBranding(docsConfig.branding, null, '/api')).toBe(
      docsConfig.branding,
    );
    expect(
      effectiveBranding(docsConfig.branding, attributes(), '/api'),
    ).toEqual(docsConfig.branding);
  });

  it('lays the name, logos and icons over the defaults, mixing in no default artwork once a logo is set', () => {
    const shown = effectiveBranding(
      docsConfig.branding,
      attributes({
        productName: 'Example Docs',
        logoLight: `sha256:${A}`,
        mark: `sha256:${B}`,
        favicon: `sha256:${C}`,
        appIcon: `sha256:${C}`,
      }),
      '/api',
    );
    expect(shown.productName).toBe('Example Docs');
    expect(shown.logo).toEqual({
      small: `/api/branding/images/${B}`,
      full: `/api/branding/images/${A}`,
      fullDark: `/api/branding/images/${A}`,
    });
    expect(shown.favicon).toBe(`/api/branding/images/${C}`);
    expect(shown.faviconPng).toBeUndefined();
    expect(shown.appleTouchIcon).toBe(`/api/branding/images/${C}`);
    expect(shown.manifest).toBe(docsConfig.branding.manifest);
  });

  it('drops the default wordmark for a name of its own, keeping the default mark', () => {
    const shown = effectiveBranding(
      docsConfig.branding,
      attributes({ productName: 'Example Docs' }),
      '/api',
    );
    expect(shown.logo.small).toBe(docsConfig.branding.logo.small);
    expect(shown.logo.full).toBeUndefined();
    expect(shown.logo.fullDark).toBeUndefined();
  });

  it('shows the mark next to the name when only the mark is set', () => {
    const shown = effectiveBranding(
      docsConfig.branding,
      attributes({ mark: `sha256:${B}` }),
      '/api',
    );
    expect(shown.logo).toEqual({ small: `/api/branding/images/${B}` });
  });

  it('takes a dark logo for both when only it is set', () => {
    const shown = effectiveBranding(
      docsConfig.branding,
      attributes({ logoDark: `sha256:${A}` }),
      '/api',
    );
    expect(shown.logo.full).toBe(`/api/branding/images/${A}`);
    expect(shown.logo.fullDark).toBe(`/api/branding/images/${A}`);
  });

  it('reads colours typed with or without #, short or long', () => {
    expect(normalHex('#1D4ED8')).toBe('#1d4ed8');
    expect(normalHex('1d4ed8')).toBe('#1d4ed8');
    expect(normalHex(' #abc ')).toBe('#aabbcc');
    expect(normalHex('blue')).toBeNull();
    expect(normalHex('#12345')).toBeNull();
  });

  it('sends only the fields that differ', () => {
    expect(
      changedFields(RESET, { ...RESET, productName: 'X', primary: '#000000' }),
    ).toEqual({ productName: 'X', primary: '#000000' });
    expect(changedFields(RESET, RESET)).toEqual({});
  });
});
