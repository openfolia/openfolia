import { readFileSync } from 'node:fs';
import { sampleConfig } from '../fixtures/config.js';
import { batteryDisposal, chargingProcedure } from '../fixtures/modules.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import type { Block } from './blocks.js';
import { moduleSourceHash, toChunk, type ChunkInput } from './chunk.js';
import { ProjectConfig } from './config.js';
import { Module } from './module.js';
import { sha256Hex } from './sha256.js';

const config = ProjectConfig.parse(sampleConfig);
const charging = Module.parse(chargingProcedure);
const disposal = Module.parse(batteryDisposal);

const loaderOf =
  (...modules: Module[]): ChunkInput['loadModule'] =>
  (id, lang) =>
    modules.find((m) => m.id === id && m.meta.lang === lang);

const chunkOf = (
  module: Module,
  rest: Partial<Omit<ChunkInput, 'module'>> = {},
) =>
  toChunk({
    module,
    config,
    loadModule: loaderOf(charging, disposal),
    ...rest,
  });

const module = (
  id: string,
  blocks: Block[],
  meta: Partial<Module['meta']> = {},
): Module =>
  Module.parse({
    schemaVersion: 1,
    id,
    meta: {
      title: `Title of ${id}`,
      type: 'concept',
      lang: 'en',
      audience: 'public',
      ...meta,
    },
    blocks,
  });

const t = (text: string) => ({ type: 'text' as const, text });
const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [t(text)],
});

const CHARGING_TEXT = `# Charging the battery

The {product-name} charges automatically at the charging station. Charge manually only after a deep discharge.

> **WARNING:** Electrical voltage at the charging contacts
>
> Touching live contacts can cause burns.
>
> - Switch off the charger before you touch the contacts.
> - Wear insulating gloves.

**Charge manually**

1. Select **Park** on the control panel.

2. Connect the charging cable to the socket (Charging socket).

   *Figure:* Charging socket on the rear panel, cable plugged in — 1 Charging socket; 2 **Status** light; 3 Pairing button for the app

3. Wait until the status light turns green.

   > **when** \`model in (l-400) && software >= 2.3\`
   >
   > > **Note:**
   > >
   > > The charging progress is also shown in the app.

**Charging times**

| Model | Time |
| --- | ---: |
| L-200 | 2 h |
| L-400 | 3 h |

> **NOTICE:** Environmental damage from incorrect disposal
>
> Return used batteries to the manufacturer or a certified recycler.

See also charging-station.`;

describe('toChunk', () => {
  it('writes a module as Markdown: numbered steps, signal words, a table, the module it includes', () => {
    const chunk = chunkOf(charging);
    expect(chunk.text).toBe(CHARGING_TEXT);
    expect(chunk).toEqual({
      moduleId: 'battery-charging',
      lang: 'en',
      title: 'Charging the battery',
      moduleType: 'procedure',
      audience: 'customer',
      facets: { 'product-line': ['lifters'] },
      keywords: ['battery', 'maintenance'],
      conditions: ['model in (l-400) && software >= 2.3'],
      text: CHARGING_TEXT,
      sourceHash: moduleSourceHash(charging),
      contentHash: sha256Hex(CHARGING_TEXT),
      sources: [
        { moduleId: 'battery-charging', lang: 'en' },
        { moduleId: 'battery-disposal', lang: 'en' },
      ],
      dependsOn: ['battery-disposal', 'charging-station'],
    });
  });

  it('with a variant, resolves variant blocks: one for another model is left out', () => {
    const other = chunkOf(charging, { variant: { model: 'l-200' } });
    expect(other.text).not.toContain('also shown in the app');
    expect(other.text).not.toContain('**when**');
    // The conditions are still listed: they are what the module varies on.
    expect(other.conditions).toEqual(['model in (l-400) && software >= 2.3']);

    const matching = chunkOf(charging, {
      variant: { model: 'l-400', software: '2.10' },
    });
    expect(matching.text).toContain(
      '3. Wait until the status light turns green.\n\n   > **Note:**\n   >\n   > The charging progress is also shown in the app.',
    );
    expect(matching.text).not.toContain('**when**');
  });

  it('with a variant, gives no legend of a callout it leaves out (#498)', () => {
    const blocks: Block[] = [
      ...charging.blocks,
      {
        type: 'paragraph',
        id: 'pairing-hint',
        content: [
          { type: 'text', text: 'Pair it with ' },
          { type: 'calloutRef', block: 'img-socket', callout: 'app-pairing' },
        ],
      },
    ];
    const referring = { ...charging, blocks };
    const legend = (variant: Record<string, string>) =>
      chunkOf(referring, { variant }).text;
    expect(chunkOf(referring).text).toContain('(Pairing button for the app)');
    // Escaped as Markdown, like any text.
    expect(legend({ model: 'l-200' })).toContain('Pair it with \\[callout\\]');
    expect(legend({ model: 'l-400' })).toContain(
      '(Pairing button for the app)',
    );
  });

  it('lists an image’s legend, numbered, only with the callouts the variant shows (#546)', () => {
    const line = (variant?: Record<string, string>) =>
      chunkOf(charging, variant ? { variant } : {})
        .text.split('\n')
        .find((l) => l.includes('*Figure:*'));
    // Reading order: the socket's label (top left), the status light, the pairing button.
    expect(line({ model: 'l-400' })).toMatch(
      / — 1 Charging socket; 2 \*\*Status\*\* light; 3 Pairing button for the app$/,
    );
    expect(line({ model: 'l-200' })).toMatch(
      / — 1 Charging socket; 2 \*\*Status\*\* light$/,
    );
    expect(line()).toContain('3 Pairing button for the app');
  });

  it('leaves a variant block out when the variant does not set an attribute it tests', () => {
    const chunk = chunkOf(charging, { variant: { model: 'l-400' } });
    expect(chunk.text).not.toContain('also shown in the app');
  });

  it('changes contentHash only when the text does: not for a formatting-only change of the file', () => {
    const source = readFileSync(
      new URL('../fixtures/battery-charging.adoc', import.meta.url),
      'utf8',
    );
    const parsed = parseModule(source, { id: 'battery-charging' });
    // The same content, written differently: the attribute lines reordered,
    // a blank line doubled, a list item's marks spelled the long way.
    const reformatted = source
      .replace(
        ':module-type: procedure\n:lang: en\n',
        ':lang: en\n:module-type: procedure\n',
      )
      .replace('\n[procedure#steps]', '\n\n[procedure#steps]');
    expect(reformatted).not.toBe(source);
    const again = parseModule(reformatted, { id: 'battery-charging' });
    expect(chunkOf(again).contentHash).toBe(chunkOf(parsed).contentHash);
    expect(chunkOf(again).sourceHash).toBe(chunkOf(parsed).sourceHash);
    // Printed canonically and read back: the same chunk.
    const printed = parseModule(printModule(parsed), {
      id: 'battery-charging',
    });
    expect(chunkOf(printed)).toEqual(chunkOf(parsed));

    const changed = parseModule(
      source.replace('Wear insulating gloves.', 'Wear safety gloves.'),
      { id: 'battery-charging' },
    );
    expect(chunkOf(changed).contentHash).not.toBe(chunkOf(parsed).contentHash);
    expect(chunkOf(changed).sourceHash).not.toBe(chunkOf(parsed).sourceHash);
  });

  it('keeps contentHash when only block IDs or the split of text runs change', () => {
    const a = module('a', [para('one', 'Some text.')]);
    const b = module('a', [
      {
        type: 'paragraph',
        id: 'other-id',
        content: [t('Some '), t('text.')],
      },
    ]);
    expect(chunkOf(b).contentHash).toBe(chunkOf(a).contentHash);
  });

  it('includes a referenced module in its language, else in the source language, and follows no cycle', () => {
    const de = module(
      'host',
      [{ type: 'moduleRef', id: 'r', module: 'shared' }],
      {
        lang: 'de',
        title: 'Gastgeber',
      },
    );
    const sharedEn = module('shared', [
      para('p', 'English shared.'),
      { type: 'moduleRef', id: 'back', module: 'host' },
    ]);
    const chunk = toChunk({
      module: de,
      config,
      loadModule: loaderOf(de, sharedEn),
    });
    expect(chunk.text).toBe('# Gastgeber\n\nEnglish shared.');
    expect(chunk.sources).toEqual([
      { moduleId: 'host', lang: 'de' },
      { moduleId: 'shared', lang: 'en' },
    ]);
  });

  it('includes only the one block a reference names (#223), inside the variant blocks around it', () => {
    const shared = module('shared', [
      para('intro', 'Shared intro.'),
      {
        type: 'variant',
        id: 'v',
        when: { op: 'in', attr: 'model', values: ['l-400'] },
        blocks: [para('only', 'L-400 text.')],
      },
    ]);
    const host = module('host', [
      { type: 'moduleRef', id: 'r', module: 'shared', block: 'only' },
      { type: 'moduleRef', id: 'gone', module: 'shared', block: 'nowhere' },
    ]);
    const loadModule = loaderOf(host, shared);
    const all = toChunk({ module: host, config, loadModule });
    expect(all.text).not.toContain('Shared intro.');
    expect(all.text).toContain('L-400 text.');
    expect(all.text).toContain('**when**');
    expect(all.conditions).toEqual(['model in (l-400)']);
    expect(all.sources).toEqual([
      { moduleId: 'host', lang: 'en' },
      { moduleId: 'shared', lang: 'en' },
    ]);
    expect(
      toChunk({ module: host, config, loadModule, variant: { model: 'l-400' } })
        .text,
    ).toBe('# Title of host\n\nL-400 text.');
    expect(
      toChunk({ module: host, config, loadModule, variant: { model: 'l-200' } })
        .text,
    ).toBe('# Title of host');
  });

  it('leaves out a referenced module the loader does not give (outside the scope) or that is more restricted', () => {
    const host = module('host', [
      para('p', 'Public text.'),
      { type: 'moduleRef', id: 'r1', module: 'service-only' },
      { type: 'moduleRef', id: 'r2', module: 'unknown' },
      { type: 'moduleRef', id: 'r3', module: 'no-audience' },
    ]);
    const serviceOnly = module('service-only', [para('s', 'Service text.')], {
      audience: 'service',
    });
    const noAudience = Module.parse({
      schemaVersion: 1,
      id: 'no-audience',
      meta: { title: 'No audience', type: 'concept', lang: 'en' },
      blocks: [para('n', 'Most restricted.')],
    });
    const chunk = toChunk({
      module: host,
      config,
      loadModule: loaderOf(host, serviceOnly, noAudience),
    });
    expect(chunk.text).toBe('# Title of host\n\nPublic text.');
    expect(chunk.sources).toEqual([{ moduleId: 'host', lang: 'en' }]);
    // A service module includes what is public and its own level.
    const service = module(
      'svc',
      [{ type: 'moduleRef', id: 'r', module: 'service-only' }],
      { audience: 'service' },
    );
    expect(
      toChunk({
        module: service,
        config,
        loadModule: loaderOf(serviceOnly),
      }).text,
    ).toBe('# Title of svc\n\nService text.');
  });

  it('escapes markup in text, keeps marks, links, code and keys', () => {
    const chunk = chunkOf(
      module('m', [
        {
          type: 'paragraph',
          id: 'p',
          content: [
            t('# not a heading <b>*x*</b> | [y] '),
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            t(' '),
            {
              type: 'text',
              text: 'a `tick`',
              marks: [{ type: 'code' }],
            },
            t(' '),
            {
              type: 'text',
              text: 'site',
              marks: [{ type: 'link', href: 'https://example.org/a_(b)' }],
            },
            t(' '),
            { type: 'kbd', keys: ['Ctrl', 'S'] },
            { type: 'hardBreak' },
            t('1. not a list'),
          ],
        },
      ]),
    );
    expect(chunk.text).toBe(
      '# Title of m\n\n\\# not a heading \\<b\\>\\*x\\*\\</b\\> \\| \\[y\\] **bold** `` a `tick` `` [site](https://example.org/a_\\(b\\)) `Ctrl+S`\\\n1\\. not a list',
    );
  });

  it('writes sections as headings, lists, a table without a header and with spans, images, attachments, literals', () => {
    const chunk = chunkOf(
      module('m', [
        {
          type: 'table',
          id: 't',
          columns: [{ width: 1 }, { width: 1, align: 'center' }, { width: 1 }],
          header: false,
          rows: [
            {
              cells: [
                { colspan: 2, blocks: [para('a', 'wide | cell')] },
                { rowspan: 2, blocks: [para('b', 'tall')] },
              ],
            },
            {
              cells: [
                { blocks: [para('c', 'x')] },
                { blocks: [para('d', 'y'), para('e', 'z')] },
              ],
            },
          ],
        },
        {
          type: 'image',
          id: 'img',
          asset: `sha256:${'0'.repeat(64)}`,
          alt: 'A picture',
          title: [t('Front view')],
        },
        {
          type: 'attachment',
          id: 'att',
          asset: `sha256:${'1'.repeat(64)}`,
          name: 'Settings',
          description: 'The defaults.',
          fileName: 'settings.zip',
          mediaType: 'application/zip',
          size: 10,
        },
        { type: 'literal', id: 'lit', text: 'a ```\nb', language: 'yaml' },
        { type: 'pageBreak', id: 'pb' },
        {
          type: 'section',
          id: 's',
          title: [t('Section')],
          blocks: [
            {
              type: 'list',
              id: 'l',
              ordered: false,
              items: [
                { id: 'i1', content: [t('one')], blocks: [] },
                { id: 'i2', content: [t('two')], blocks: [] },
              ],
            },
            {
              type: 'section',
              id: 's2',
              title: [t('Inner')],
              blocks: [para('p', 'Deep.')],
            },
          ],
        },
      ]),
    );
    expect(chunk.text).toBe(
      [
        '# Title of m',
        '|  |  |  |\n| --- | :---: | --- |\n| wide \\| cell |  | tall |\n| x | y<br>z |  |',
        '*Figure:* Front view — A picture',
        '*Attachment:* Settings — The defaults.',
        '````yaml\na ```\nb\n````',
        '## Section',
        '- one\n- two',
        '### Inner',
        'Deep.',
      ].join('\n\n'),
    );
  });

  it('names every module the text depends on, also those left out', () => {
    const host = module('host', [
      { type: 'moduleRef', id: 'r1', module: 'missing' },
      {
        type: 'paragraph',
        id: 'x',
        content: [
          { type: 'xref', module: 'target' },
          t(' and '),
          { type: 'xref', module: 'host' },
        ],
      },
    ]);
    const target = module('target', [para('p', 'T.')], {
      title: 'Target title',
    });
    const chunk = toChunk({
      module: host,
      config,
      loadModule: loaderOf(host, target),
    });
    expect(chunk.text).toBe(
      '# Title of host\n\nTarget title and Title of host',
    );
    expect(chunk.dependsOn).toEqual(['missing', 'target']);
  });

  it('escapes entities, and keeps a hard break in a table cell as a line break', () => {
    const chunk = chunkOf(
      module('m', [
        {
          type: 'table',
          id: 't',
          columns: [{ width: 1 }],
          header: false,
          rows: [
            {
              cells: [
                {
                  blocks: [
                    {
                      type: 'paragraph',
                      id: 'c',
                      content: [t('a &copy;'), { type: 'hardBreak' }, t('b')],
                    },
                    para('d', 'C:\\'),
                    para('e', 'next'),
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(chunk.text).toBe(
      '# Title of m\n\n|  |\n| --- |\n| a \\&copy;<br>b<br>C:\\\\<br>next |',
    );
  });

  it('uses the signal words and labels of the module language', () => {
    const de = Module.parse({
      ...batteryDisposal,
      meta: { ...batteryDisposal.meta, lang: 'de' },
    });
    expect(chunkOf(de).text).toContain('> **HINWEIS:** Environmental damage');
  });

  it('hashes the canonical AsciiDoc as the source hash of a module without translatable text', () => {
    const literal = module('lit', [{ type: 'literal', id: 'l', text: 'x' }]);
    expect(moduleSourceHash(literal)).toBe(sha256Hex(printModule(literal)));
  });
});
