import type { Block, Module } from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_CONFIG,
  SAMPLE_MANUAL,
  sampleInput,
} from '../../testing/export-sample.js';
import { validateDita } from '../../testing/grammars.js';
import { convertDita } from '../convert.js';
import { type DitaExport, exportDita } from './export.js';

/** What the first code review found (#433): each a test. */

const p = (id: string, text = `Paragraph ${id}.`): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const mod = (
  id: string,
  blocks: Block[],
  type = 'concept',
  meta: Partial<Module['meta']> = {},
): Module => ({
  schemaVersion: 1,
  id,
  meta: { title: `Title of ${id}`, type, lang: 'en', facets: {}, ...meta },
  blocks,
});

const run = (modules: Module[], entries: string[], extra = {}) => {
  const byId = new Map(modules.map((m) => [m.id, m]));
  return exportDita(
    sampleInput({
      languages: ['en'],
      manifest: {
        ...SAMPLE_MANUAL,
        variants: [{ model: 'pro', market: 'eu', software: '1' }],
        attributes: {},
        entries: entries.map((module) => ({ module })),
      },
      module: (id) => byId.get(id),
      ...extra,
    }),
  );
};
const texts = (out: DitaExport) =>
  new Map(
    out.files.flatMap((f) => ('text' in f ? [[f.path, f.text] as const] : [])),
  );
const bytes = (out: DitaExport) =>
  new Map(
    [...texts(out)].map(([path, text]) => [
      path,
      new TextEncoder().encode(text),
    ]),
  );

describe('exportDita after the first review', () => {
  it('keeps a section’s blocks after content put in that holds a section', () => {
    const out = run(
      [
        mod('a', [
          {
            type: 'section',
            id: 's',
            title: [{ type: 'text', text: 'S' }],
            blocks: [{ type: 'moduleRef', id: 'r', module: 'b' }, p('after')],
          },
        ]),
        mod('b', [
          p('b1'),
          {
            type: 'section',
            id: 'bs',
            title: [{ type: 'text', text: 'BS' }],
            blocks: [p('b2')],
          },
        ]),
      ],
      ['a'],
    );
    expect(texts(out).get('en/a.dita')).toContain('<p id="after">');
  });

  it('writes a valid content reference to a module starting with a question', async () => {
    const out = run(
      [
        mod('a', [p('a1'), { type: 'moduleRef', id: 'r', module: 'q' }]),
        mod(
          'q',
          [
            {
              type: 'faq',
              id: 'faq',
              question: [{ type: 'text', text: 'Why?' }],
              blocks: [p('answer')],
            },
          ],
          'snippet',
        ),
      ],
      ['a'],
    );
    expect(texts(out).get('en/a.dita')).toContain('conref="q.dita#q/faq"');
    expect((await validateDita(texts(out))).errors).toEqual([]);
  }, 120_000);

  it('gives a section named like its module a topic ID of its own, and links to it', async () => {
    const out = run(
      [
        mod('safety', [
          p('intro'),
          {
            type: 'section',
            id: 'safety',
            title: [{ type: 'text', text: 'Safety' }],
            blocks: [
              {
                type: 'section',
                id: 'deep',
                title: [{ type: 'text', text: 'Deep' }],
                blocks: [p('d1')],
              },
            ],
          },
        ]),
        mod('a', [
          {
            type: 'paragraph',
            id: 'link',
            content: [{ type: 'xref', module: 'safety', block: 'safety' }],
          },
        ]),
      ],
      ['a', 'safety'],
    );
    expect((await validateDita(texts(out))).errors).toEqual([]);
    expect(texts(out).get('en/a.dita')).toContain(
      'href="safety.dita#safety-section"',
    );
    expect(out.warnings.map((w) => w.code)).toContain('id-renamed');
  }, 120_000);

  it('imports module references and variant blocks again as they were, IDs and all', async () => {
    const main = mod('main', [
      p('intro'),
      {
        type: 'variant',
        id: 'pro-only',
        when: { op: 'in', attr: 'model', values: ['pro'] },
        blocks: [p('pro-1')],
      },
      { type: 'moduleRef', id: 'shared', module: 'snip' },
      p('outro'),
    ]);
    const snip = mod('snip', [p('s1'), p('s2')], 'snippet');
    const out = run([main, snip], ['main']);
    const again = await convertDita(bytes(out), SAMPLE_CONFIG);
    const back = (id: string) =>
      again.document.modules.find((m) => m.id === id)?.blocks;
    expect(back('main')).toEqual(main.blocks);
    expect(back('snip')).toEqual(snip.blocks);
  });

  it('imports a module reference marked with the mark of an export before the rename (one release)', async () => {
    const main = mod('main', [
      p('intro'),
      { type: 'moduleRef', id: 'shared', module: 'snip' },
    ]);
    const snip = mod('snip', [p('s1'), p('s2')], 'snippet');
    const out = run([main, snip], ['main']);
    const legacy = new Map(
      [...texts(out)].map(([path, text]) => [
        path,
        new TextEncoder().encode(
          text.replaceAll(
            'outputclass="openfolia-module-reference',
            'outputclass="ccms-module-reference',
          ),
        ),
      ]),
    );
    expect(
      [...legacy.values()].some((b) =>
        new TextDecoder().decode(b).includes('"ccms-module-reference'),
      ),
    ).toBe(true);
    const again = await convertDita(legacy, SAMPLE_CONFIG);
    expect(again.document.modules.find((m) => m.id === 'main')?.blocks).toEqual(
      main.blocks,
    );
  });

  it('says so when procedures are joined into one task’s steps', () => {
    const step = (id: string) => ({
      id,
      content: [{ type: 'text' as const, text: id }],
      blocks: [],
    });
    const out = run(
      [
        mod(
          't',
          [
            { type: 'procedure', id: 'one', steps: [step('one-1')] },
            { type: 'procedure', id: 'two', steps: [step('two-1')] },
          ],
          'procedure',
        ),
      ],
      ['t'],
    );
    expect(
      out.warnings.some(
        (w) => w.code === 'procedures-merged' && w.block === 'two',
      ),
    ).toBe(true);
  });

  it('leaves out a module of an audience the configuration does not hold', () => {
    const out = run(
      [
        mod('a', [p('a1')]),
        mod('odd', [p('o1')], 'concept', { audience: 'nobody' }),
      ],
      ['a', 'odd'],
    );
    expect(texts(out).has('en/odd.dita')).toBe(false);
  });

  it('never ships one symbol under another’s file name', () => {
    const out = run(
      [
        mod('a', [
          {
            type: 'safety',
            id: 'one',
            severity: 'warning',
            hazard: [{ type: 'text', text: 'Hot' }],
            symbols: ['m002', 'w001'],
            blocks: [],
          },
        ]),
      ],
      ['a'],
      {
        config: {
          ...SAMPLE_CONFIG,
          dita: {
            ...(SAMPLE_CONFIG.dita as NonNullable<typeof SAMPLE_CONFIG.dita>),
            hazardSymbols: { 'w001.svg': 'm002' },
          },
        },
        symbol: (id: string) => ({
          extension: id === 'm002' ? '.svg' : '.svg',
        }),
      },
    );
    const symbols = out.files.filter((f) => 'symbol' in f);
    expect(symbols).toHaveLength(2);
    expect(new Set(symbols.map((f) => f.path)).size).toBe(2);
  });
});
