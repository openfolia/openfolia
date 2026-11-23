import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig } from './config.js';
import { Manifest, type ManifestInput } from './manifest.js';
import { parseManifest, printManifest } from './manifest-yaml.js';
import { PageDesign } from './page-design.js';
import { manualCoverImage, resolvePageDesign } from './page-design-resolve.js';
import { validateManifest } from './validate.js';

const config = ProjectConfig.parse(sampleConfig);

const MANUAL = 'sha256:' + 'a'.repeat(64);
const LARGE = 'sha256:' + 'b'.repeat(64);
const DESIGN = 'sha256:' + 'c'.repeat(64);

const manifest = (coverImage?: ManifestInput['coverImage']): Manifest =>
  Manifest.parse({
    schemaVersion: 1,
    id: 'operating',
    title: 'Operating manual',
    variants: [
      { model: 'l-200', market: 'eu' },
      { model: 'l-400', market: 'eu' },
    ],
    ...(coverImage && { coverImage }),
    entries: [{ module: 'battery-charging' }],
  });

const design = (withCover: boolean) =>
  PageDesign.parse({
    schemaVersion: 1,
    id: 'led',
    name: 'Led',
    preset: 'image-led',
    colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
    ...(withCover && {
      coverImage: { default: { asset: DESIGN, alt: 'The product line' } },
    }),
  });

const cover = {
  default: { asset: MANUAL, alt: { en: 'The lifter', de: 'Der Heber' } },
  variants: [
    {
      variant: { market: 'eu', model: 'l-400' },
      asset: LARGE,
      alt: 'The L-400',
    },
  ],
};

describe('a manual’s cover image (#394)', () => {
  it('prints canonically after the design and reads back the same', () => {
    const printed = printManifest(manifest(cover));
    expect(printed).toContain(
      [
        'coverImage:',
        '  default:',
        `    asset: ${MANUAL}`,
        '    alt:',
        '      de: Der Heber',
        '      en: The lifter',
        '  variants:',
        '    - variant:',
        '        market: eu',
        '        model: l-400',
        `      asset: ${LARGE}`,
        '      alt: The L-400',
      ].join('\n'),
    );
    expect(printManifest(parseManifest(printed, { id: 'operating' }))).toBe(
      printed,
    );
    expect(printManifest(manifest())).not.toContain('coverImage');
  });

  it('refuses a cover image without alternative text or with a bad file reference', () => {
    expect(() =>
      manifest({ default: { asset: MANUAL } as never, variants: [] }),
    ).toThrow();
    expect(() =>
      manifest({ default: { asset: 'logo.png', alt: 'x' }, variants: [] }),
    ).toThrow();
    expect(() =>
      manifest({ default: { asset: MANUAL, alt: {} }, variants: [] }),
    ).toThrow();
    expect(() =>
      manifest({
        default: { asset: MANUAL, alt: 'x'.repeat(501) },
        variants: [],
      }),
    ).toThrow();
  });

  it('chooses the variant’s own, else the manual’s', () => {
    const m = manifest(cover);
    expect(manualCoverImage(m, { model: 'l-400', market: 'eu' })).toEqual({
      image: cover.variants[0],
      at: 'manual.coverImage.variants.0.alt',
    });
    expect(manualCoverImage(m, { model: 'l-200', market: 'eu' })?.at).toBe(
      'manual.coverImage.default.alt',
    );
    expect(
      manualCoverImage(manifest({ variants: cover.variants }), {
        model: 'l-200',
        market: 'eu',
      }),
    ).toBeUndefined();
  });

  it('wins over the design’s cover image, which applies without one', () => {
    const resolve = (
      m: Manifest,
      variant: Record<string, string>,
      lang = 'en',
    ) =>
      resolvePageDesign({
        design: design(true),
        manifest: m,
        variant,
        lang,
        config,
      });
    const large = { model: 'l-400', market: 'eu' };
    const small = { model: 'l-200', market: 'eu' };
    expect(resolve(manifest(cover), large).design.coverImage).toEqual({
      asset: LARGE,
      alt: 'The L-400',
    });
    expect(resolve(manifest(cover), small, 'de').design.coverImage).toEqual({
      asset: MANUAL,
      alt: 'Der Heber',
    });
    // French has no text of its own: the source language's, reported.
    const fr = resolve(manifest(cover), small, 'fr');
    expect(fr.design.coverImage).toEqual({ asset: MANUAL, alt: 'The lifter' });
    expect(fr.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-translation',
        at: 'manual.coverImage.default.alt',
      }),
    );
    expect(resolve(manifest(), small).design.coverImage).toEqual({
      asset: DESIGN,
      alt: 'The product line',
    });
    expect(
      resolvePageDesign({
        design: design(false),
        manifest: manifest(),
        variant: small,
        lang: 'en',
        config,
      }).design.coverImage,
    ).toBeUndefined();
  });

  it('reports a variant the manual does not build, a repeated one and an unknown language', () => {
    const issues = validateManifest(
      manifest({
        default: { asset: MANUAL, alt: { en: 'Lifter', xx: 'Lifter' } },
        variants: [
          { variant: { model: 'l-400', market: 'eu' }, asset: LARGE, alt: 'a' },
          { variant: { market: 'eu', model: 'l-400' }, asset: LARGE, alt: 'b' },
          { variant: { model: 'l-400', market: 'us' }, asset: LARGE, alt: 'c' },
        ],
      }),
      config,
    );
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['unknown-language', 'coverImage.default.alt.xx'],
      ['unknown-cover-variant', 'coverImage.variants.1'],
      ['unknown-cover-variant', 'coverImage.variants.2'],
    ]);
    expect(validateManifest(manifest(cover), config)).toEqual([]);
    // Required in the source language, whatever the other languages have.
    expect(
      validateManifest(
        manifest({
          default: { asset: MANUAL, alt: { de: 'Der Heber' } },
          variants: [],
        }),
        config,
      ).map((i) => [i.severity, i.code, i.at]),
    ).toEqual([['error', 'missing-cover-alt', 'coverImage.default.alt']]);
  });
});
