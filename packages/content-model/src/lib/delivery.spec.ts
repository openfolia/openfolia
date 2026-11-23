import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig, StrictProjectConfig } from './config.js';
import { parseConfig, printConfig } from './config-yaml.js';
import {
  deliverySlug,
  manualIdsOf,
  manualOfSlug,
  publicAudience,
} from './delivery.js';

const withDelivery = (delivery: unknown) =>
  ProjectConfig.safeParse({ ...sampleConfig, delivery });

describe('delivery configuration (#450)', () => {
  it('defaults to signed-in readers, a language picker and no QR code in the PDF', () => {
    const config = ProjectConfig.parse(sampleConfig);
    expect(config.delivery).toEqual({
      access: 'signed-in',
      missingLanguage: 'picker',
      pdfQrCode: 'none',
      manuals: {},
    });
    expect(publicAudience(config)).toBe('public');
    expect(printConfig(config)).not.toContain('delivery');
  });

  it('takes every setting, and prints only what is not default', () => {
    const parsed = withDelivery({
      access: 'public',
      publicAudience: 'customer',
      missingLanguage: 'source',
      pdfQrCode: 'back-cover',
      manuals: {
        operating: { slug: 'operation', formerly: ['op', 'old-operating'] },
        service: {},
      },
    });
    expect(parsed.error).toBeUndefined();
    const config = parsed.data as ProjectConfig;
    expect(publicAudience(config)).toBe('customer');
    const printed = printConfig(config);
    expect(printed).toContain(
      [
        'delivery:',
        '  access: public',
        '  publicAudience: customer',
        '  missingLanguage: source',
        '  pdfQrCode: back-cover',
        '  manuals:',
        '    operating:',
        '      slug: operation',
        '      formerly:',
        '        - op',
        '        - old-operating',
      ].join('\n'),
    );
    expect(printed).not.toContain('service:');
    expect(parseConfig(printed).delivery).toEqual({
      ...config.delivery,
      manuals: { operating: config.delivery.manuals['operating'] },
    });
    expect(StrictProjectConfig.safeParse(parsed.data).error).toBeUndefined();
  });

  it('refuses an unknown access, audience or address', () => {
    expect(withDelivery({ access: 'everyone' }).error).toBeDefined();
    expect(
      withDelivery({ publicAudience: 'nobody' }).error?.issues[0]?.path,
    ).toEqual(['delivery', 'publicAudience']);
    expect(withDelivery({ pdfQrCode: 'cover' }).error).toBeDefined();
    expect(
      withDelivery({ manuals: { operating: { slug: 'Not A Slug' } } }).error,
    ).toBeDefined();
    expect(
      withDelivery({ manuals: { operating: { formerly: ['a', 'a'] } } }).error,
    ).toBeDefined();
  });

  it('refuses an address that would name two manuals', () => {
    const clash = (manuals: unknown) =>
      withDelivery({ manuals }).error?.issues[0]?.path;
    expect(clash({ a: { slug: 'x' }, b: { slug: 'x' } })).toEqual([
      'delivery',
      'manuals',
    ]);
    // A slug that is another listed manual's own address (its ID).
    expect(clash({ a: { slug: 'b' }, b: {} })).toEqual(['delivery', 'manuals']);
    expect(clash({ a: { formerly: ['x'] }, b: { formerly: ['x'] } })).toEqual([
      'delivery',
      'manuals',
    ]);
    expect(clash({ a: { slug: 'x' }, b: { formerly: ['x'] } })).toEqual([
      'delivery',
      'manuals',
    ]);
    expect(clash({ a: { slug: 'x', formerly: ['x'] } })).toEqual([
      'delivery',
      'manuals',
    ]);
    // Another listed manual's ID, though that manual has a slug now.
    expect(clash({ a: { slug: 'x' }, b: { formerly: ['a'] } })).toEqual([
      'delivery',
      'manuals',
    ]);
    // A manual's own ID among its former addresses, once it has a slug, is fine.
    expect(clash({ a: { slug: 'x', formerly: ['a'] } })).toBeUndefined();
  });

  it('finds the manual an address names, and whether it moved', () => {
    const config = ProjectConfig.parse({
      ...sampleConfig,
      delivery: {
        manuals: {
          operating: { slug: 'operation', formerly: ['op'] },
          service: { formerly: ['repair'] },
        },
      },
    });
    expect(deliverySlug(config, 'operating')).toBe('operation');
    expect(deliverySlug(config, 'service')).toBe('service');
    expect(deliverySlug(config, 'other')).toBe('other');
    expect(manualOfSlug(config, 'operation')).toEqual({
      manualId: 'operating',
      moved: false,
    });
    expect(manualOfSlug(config, 'op')).toEqual({
      manualId: 'operating',
      moved: true,
    });
    // Its ID, once it has a slug, leads to the slug.
    expect(manualOfSlug(config, 'operating')).toEqual({
      manualId: 'operating',
      moved: true,
    });
    expect(manualOfSlug(config, 'repair')).toEqual({
      manualId: 'service',
      moved: true,
    });
    expect(manualOfSlug(config, 'service')).toEqual({
      manualId: 'service',
      moved: false,
    });
    expect(manualOfSlug(config, 'other')).toEqual({
      manualId: 'other',
      moved: false,
    });
    expect(manualIdsOf(config, 'operating')).toEqual(['operating', 'op']);
    expect(manualIdsOf(config, 'other')).toEqual(['other']);
  });
});
