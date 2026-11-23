import { sampleConfig } from '../fixtures/config.js';
import { batteryDisposal } from '../fixtures/modules.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { Module } from './module.js';
import {
  blocksTooLargeForSnippet,
  foldText,
  isSnippetType,
  plainTextExcerpt,
  snippetTypes,
  SNIPPET_EXCERPT_LENGTH,
} from './snippet.js';
import { validateModule } from './validate.js';

const config = ProjectConfig.parse({
  ...sampleConfig,
  moduleTypes: [
    ...sampleConfig.moduleTypes,
    { id: 'phrase', label: 'Phrase', snippet: true },
    { id: 'warning-text', label: 'Warning text', snippet: true },
  ],
});
const t = (text: string) => ({ type: 'text' as const, text });
const p = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [t(text)],
});

const moduleWith = (blocks: Block[], type: string) =>
  Module.parse({
    ...batteryDisposal,
    meta: { ...batteryDisposal.meta, type },
    blocks,
  });

describe('snippet types', () => {
  it('are the types the configuration marks, in its order', () => {
    expect(snippetTypes(config)).toEqual(['phrase', 'warning-text']);
    expect(isSnippetType(config, 'phrase')).toBe(true);
    expect(isSnippetType(config, 'procedure')).toBe(false);
    expect(isSnippetType(config, 'unknown')).toBe(false);
    expect(snippetTypes(ProjectConfig.parse(sampleConfig))).toEqual([]);
  });
});

describe('snippet-too-large', () => {
  const section: Block = {
    type: 'section',
    id: 'more',
    title: [t('More')],
    blocks: [{ type: 'moduleRef', id: 'inner', module: 'other' }],
  };

  it('warns at each section and module reference of a snippet', () => {
    const issues = validateModule(
      moduleWith([p('a', 'Wear gloves.'), section], 'phrase'),
      config,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'snippet-too-large',
        at: 'more',
      }),
      expect.objectContaining({
        severity: 'warning',
        code: 'snippet-too-large',
        at: 'inner',
      }),
    ]);
  });

  it('says nothing for a snippet of text, nor for a module of another type', () => {
    expect(
      validateModule(moduleWith([p('a', 'Wear gloves.')], 'phrase'), config),
    ).toEqual([]);
    expect(
      validateModule(moduleWith([section], 'procedure'), config).map(
        (i) => i.code,
      ),
    ).not.toContain('snippet-too-large');
    expect(blocksTooLargeForSnippet([p('a', 'x')])).toEqual([]);
  });
});

describe('plainTextExcerpt', () => {
  it('reads the text in document order, white space collapsed', () => {
    const blocks: Block[] = [
      p('a', '  Wear   protective\ngloves. '),
      {
        type: 'list',
        id: 'l',
        ordered: false,
        items: [{ id: 'i', content: [t('Goggles')], blocks: [] }],
      },
      {
        type: 'paragraph',
        id: 'b',
        content: [
          t('Ask '),
          { type: 'attribute', name: 'vendor' },
          t(' first.'),
        ],
      },
    ];
    expect(plainTextExcerpt(blocks)).toBe(
      'Wear protective gloves. Goggles Ask {vendor} first.',
    );
  });

  it('is cut to the length, by characters, never half a pair', () => {
    const long = 'é😀'.repeat(150);
    const excerpt = plainTextExcerpt([p('a', long)]);
    expect(Array.from(excerpt)).toHaveLength(SNIPPET_EXCERPT_LENGTH);
    expect(plainTextExcerpt([p('a', 'one two three')], 7)).toBe('one two');
    expect(plainTextExcerpt([])).toBe('');
  });
});

describe('foldText', () => {
  it('folds as search folds: case, diacritics, ß and white space', () => {
    expect(foldText('Straße  ÄRGER\nÉté')).toBe('strasse arger ete');
  });
});
