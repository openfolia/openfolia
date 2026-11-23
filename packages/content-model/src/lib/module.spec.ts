import { batteryDisposal, chargingProcedure } from '../fixtures/modules.js';
import { Module } from './module.js';
import { walk } from './walk.js';

const clone = <T>(value: T): T => structuredClone(value);

const first = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) throw new Error('fixture has no blocks');
  return item;
};

describe('Module', () => {
  it('accepts the sample modules', () => {
    expect(Module.safeParse(chargingProcedure).error).toBeUndefined();
    expect(Module.safeParse(batteryDisposal).error).toBeUndefined();
  });

  it('defaults facets to an empty record', () => {
    expect(Module.parse(batteryDisposal).meta.facets).toEqual({});
  });

  describe('keywords', () => {
    const withKeywords = (keywords: unknown) =>
      Module.safeParse({
        ...clone(batteryDisposal),
        meta: { ...batteryDisposal.meta, keywords },
      });

    it('are optional', () => {
      expect(Module.parse(batteryDisposal).meta.keywords).toBeUndefined();
    });

    it('are trimmed, spaced once, and kept once case aside, the first spelling first', () => {
      expect(
        withKeywords([
          '  Battery ',
          'deep \t discharge',
          'battery',
          'BATTERY',
          'Akku',
        ]).data?.meta.keywords,
      ).toEqual(['Battery', 'deep discharge', 'Akku']);
    });

    it('are stored in NFC, so a decomposed spelling is the same keyword', () => {
      expect(
        withKeywords(['Wa\u0308rme', 'W\u00e4rme']).data?.meta.keywords,
      ).toEqual(['W\u00e4rme']);
    });

    it('hold 1 to 64 characters, no comma and no control character', () => {
      expect(withKeywords(['x'.repeat(64)]).success).toBe(true);
      expect(withKeywords(['x'.repeat(65)]).success).toBe(false);
      expect(withKeywords(['   ']).success).toBe(false);
      expect(withKeywords(['a, b']).success).toBe(false);
      expect(withKeywords(['a\u0000b']).success).toBe(false);
    });

    it('are at most 32 once repeats are dropped', () => {
      const many = Array.from({ length: 32 }, (_, i) => `k${i}`);
      expect(withKeywords(many).success).toBe(true);
      expect(withKeywords([...many, 'K0', 'k1']).success).toBe(true);
      expect(withKeywords([...many, 'k32']).success).toBe(false);
    });
  });

  it('rejects duplicate block ids anywhere in the tree', () => {
    const module = clone(chargingProcedure);
    module.blocks.push({
      type: 'paragraph',
      id: 'step-wait-l400-text',
      content: [{ type: 'text', text: 'x' }],
    });
    const result = Module.safeParse(module);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'duplicate block id "step-wait-l400-text"',
    );
  });

  it('rejects an unknown schema version', () => {
    expect(
      Module.safeParse({ ...clone(batteryDisposal), schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it('rejects ids that cannot be written as AsciiDoc anchors', () => {
    const module = clone(batteryDisposal);
    module.blocks = [{ ...first(module.blocks), id: '1-notice' }];
    expect(Module.safeParse(module).success).toBe(false);
  });

  it('rejects unknown block types', () => {
    const module = clone(batteryDisposal) as { blocks: unknown[] };
    module.blocks.push({ type: 'sidebar', id: 'x', blocks: [] });
    expect(Module.safeParse(module).success).toBe(false);
  });

  it('rejects a safety block without a known severity', () => {
    const module = clone(batteryDisposal);
    module.blocks = [{ ...first(module.blocks), severity: 'hint' } as never];
    expect(Module.safeParse(module).success).toBe(false);
  });

  it('rejects images without alt text or with a non-hash asset', () => {
    const base = { type: 'image', id: 'img' } as const;
    const hash = `sha256:${'a'.repeat(64)}`;
    const withBlock = (block: unknown) => ({
      ...clone(batteryDisposal),
      blocks: [block],
    });
    expect(
      Module.safeParse(withBlock({ ...base, asset: hash, alt: '' })).success,
    ).toBe(false);
    expect(
      Module.safeParse(
        withBlock({ ...base, asset: 'images/socket.png', alt: 'x' }),
      ).success,
    ).toBe(false);
    expect(
      Module.safeParse(withBlock({ ...base, asset: hash, alt: 'x' })).success,
    ).toBe(true);
  });

  it('rejects a repeated mark on one text run', () => {
    const paragraph = {
      type: 'paragraph',
      id: 'p',
      content: [
        {
          type: 'text',
          text: 'x',
          marks: [{ type: 'strong' }, { type: 'strong' }],
        },
      ],
    };
    expect(
      Module.safeParse({ ...clone(batteryDisposal), blocks: [paragraph] })
        .success,
    ).toBe(false);
  });
});

describe('walk', () => {
  it('visits every id-bearing node in document order', () => {
    const ids = [...walk(Module.parse(chargingProcedure).blocks)].map(
      ({ node }) => node.id,
    );
    expect(ids.slice(0, 7)).toEqual([
      'intro',
      'warn-voltage',
      'warn-voltage-consequence',
      'warn-voltage-measures',
      'warn-voltage-m1',
      'warn-voltage-m2',
      'steps',
    ]);
    expect(ids).toContain('step-wait-l400-text');
    expect(ids).toContain('ct-r2c2');
    expect(ids.at(-1)).toBe('see-also');
  });
});
