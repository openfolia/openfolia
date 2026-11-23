import { batteryDisposal } from '../fixtures/modules.js';
import type { Block } from './blocks.js';
import { Manifest } from './manifest.js';
import { Module } from './module.js';
import {
  manifestNamesModule,
  namesModule,
  renameManifestModule,
  renameModuleReferences,
  renameReplacement,
  replacementNamesModule,
} from './module-references.js';

const t = (text: string) => ({ type: 'text' as const, text });

const moduleWith = (blocks: Block[]) =>
  Module.parse({ ...batteryDisposal, blocks });

describe('module references', () => {
  const nested: Block[] = [
    { type: 'moduleRef', id: 'r1', module: 'old' },
    { type: 'moduleRef', id: 'r3', module: 'other' },
    {
      type: 'section',
      id: 's1',
      title: [t('About '), { type: 'xref', module: 'old', block: 'b1' }],
      blocks: [
        {
          type: 'list',
          id: 'l1',
          ordered: false,
          items: [
            {
              id: 'i1',
              content: [{ type: 'xref', module: 'other' }],
              blocks: [{ type: 'moduleRef', id: 'r2', module: 'old' }],
            },
          ],
        },
        {
          type: 'variant',
          id: 'v1',
          when: { op: 'in', attr: 'model', values: ['x'] },
          blocks: [
            {
              type: 'paragraph',
              id: 'p1',
              content: [
                t('See '),
                { type: 'xref', module: 'old', text: [t('there')] },
              ],
            },
          ],
        },
      ],
    },
  ] as Block[];

  it('finds module references and cross-references at any depth', () => {
    const module = moduleWith(nested);
    expect(namesModule(module, 'old')).toBe(true);
    expect(namesModule(module, 'other')).toBe(true);
    expect(namesModule(module, 'missing')).toBe(false);
  });

  it('rewrites every one naming the old ID and nothing else', () => {
    const module = moduleWith(nested);
    const renamed = renameModuleReferences(module, 'old', 'new');
    expect(namesModule(renamed, 'old')).toBe(false);
    expect(namesModule(renamed, 'other')).toBe(true);
    // The rest is as it was: only `module` members changed.
    expect(JSON.stringify(renamed)).toBe(
      JSON.stringify(module).replaceAll('"module":"old"', '"module":"new"'),
    );
    // The block a cross-reference names and its link text stay.
    expect(Module.parse(renamed)).toEqual(renamed);
    // Never changed in place.
    expect(namesModule(module, 'old')).toBe(true);
  });

  it('gives back the same module when nothing names the old ID', () => {
    const module = moduleWith(nested);
    expect(renameModuleReferences(module, 'missing', 'new')).toBe(module);
  });

  it('rewrites manifest entries, inside groups too', () => {
    const manifest = Manifest.parse({
      schemaVersion: 1,
      id: 'manual',
      title: 'Manual',
      variants: [{}],
      entries: [
        { module: 'intro' },
        {
          title: 'Use',
          entries: [
            { module: 'old', when: { op: 'in', attr: 'model', values: ['x'] } },
            { module: 'other' },
          ],
        },
        { module: 'old' },
      ],
    });
    expect(manifestNamesModule(manifest, 'old')).toBe(true);
    const renamed = renameManifestModule(manifest, 'old', 'new');
    expect(renamed.entries).toEqual([
      { module: 'intro' },
      {
        title: 'Use',
        entries: [
          { module: 'new', when: { op: 'in', attr: 'model', values: ['x'] } },
          { module: 'other' },
        ],
      },
      { module: 'new' },
    ]);
    expect(manifestNamesModule(renamed, 'old')).toBe(false);
    expect(renameManifestModule(manifest, 'missing', 'new')).toBe(manifest);
  });

  it('rewrites a deprecation’s replacement, its reason kept', () => {
    const module = Module.parse({
      ...batteryDisposal,
      meta: {
        ...batteryDisposal.meta,
        deprecated: { reason: 'Superseded.', replacedBy: 'old' },
      },
    });
    expect(replacementNamesModule(module, 'old')).toBe(true);
    expect(replacementNamesModule(module, 'other')).toBe(false);
    const renamed = renameReplacement(module, 'old', 'new');
    expect(renamed.meta.deprecated).toEqual({
      reason: 'Superseded.',
      replacedBy: 'new',
    });
    expect(replacementNamesModule(renamed, 'old')).toBe(false);
    // Never changed in place, and the same object when it is not `from`.
    expect(module.meta.deprecated?.replacedBy).toBe('old');
    expect(renameReplacement(module, 'missing', 'new')).toBe(module);
    const plain = moduleWith([]);
    expect(replacementNamesModule(plain, 'old')).toBe(false);
    expect(renameReplacement(plain, 'old', 'new')).toBe(plain);
  });
});
