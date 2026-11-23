// @vitest-environment jsdom
/// <reference lib="dom" />
import type { Module } from '@openfolia/content-model';
import { generateHTML, generateJSON } from '@tiptap/core';
import { ConversionError } from './errors.js';
import { createEditorExtensions, getEditorSchema } from './extensions.js';
import { fromEditor } from './from-editor.js';
import type { EditorDoc } from './json.js';
import { normalizeEditorDoc } from './normalize.js';
import { toEditor } from './to-editor.js';

/** The term mark (#245) in the editor's schema and both converters. */

const module: Module = {
  schemaVersion: 1,
  id: 'sample',
  meta: { title: 'A module', type: 'concept', lang: 'en', facets: {} },
  blocks: [
    {
      type: 'paragraph',
      id: 'p',
      content: [
        { type: 'text', text: 'Use the ' },
        {
          type: 'text',
          text: 'quick',
          marks: [
            { type: 'term', termId: 'quick-charger' },
            { type: 'strong' },
          ],
        },
        {
          type: 'text',
          text: ' charger',
          marks: [{ type: 'term', termId: 'quick-charger' }],
        },
      ],
    },
  ],
};

const withMarks = (marks: unknown[]): EditorDoc =>
  ({
    ...toEditor(module),
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'p' },
        content: [{ type: 'text', text: 'x', marks }],
      },
    ],
  }) as EditorDoc;

describe('the term mark in the editor', () => {
  it('converts to the editor and back unchanged', () => {
    const doc = toEditor(module);
    expect(doc.content?.[0]?.content?.[1]?.marks).toEqual([
      { type: 'term', attrs: { termId: 'quick-charger' } },
      { type: 'strong' },
    ]);
    expect(fromEditor(doc)).toEqual(module);
    expect(getEditorSchema().nodeFromJSON(doc).check()).toBeUndefined();
  });

  it('renders as a span naming its term, and reads it back from pasted HTML', () => {
    const extensions = createEditorExtensions();
    const html = generateHTML(toEditor(module), extensions);
    expect(html).toContain('data-mark="term"');
    expect(html).toContain('data-term-id="&quot;quick-charger&quot;"');
    const json = generateJSON(html, extensions);
    expect(json.content[0].content[2]).toEqual({
      type: 'text',
      text: ' charger',
      marks: [{ type: 'term', attrs: { termId: 'quick-charger' } }],
    });
    // A pasted span naming no valid term ID is plain text.
    const bad = generateJSON(
      '<p data-id="p"><span data-mark="term" data-term-id="&quot;Not An ID&quot;">x</span></p>',
      extensions,
    );
    expect(bad.content[0].content).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('never marks one text as both a link and a term link', () => {
    const schema = getEditorSchema();
    const link = schema.marks['link']?.create({ href: 'https://example.com' });
    const term = schema.marks['term']?.create({ termId: 'charger' });
    expect(link && term && term.isInSet(link.addToSet([]))).toBeFalsy();
    expect(
      link && term && term.addToSet(link.addToSet([])).map((m) => m.type.name),
    ).toEqual(['term']);
  });

  it('repairs a term mark without a valid ID, or beside a link, and fromEditor refuses them', () => {
    const invalid = withMarks([{ type: 'term', attrs: { termId: 'Bad ID' } }]);
    expect(() => fromEditor(invalid)).toThrow(ConversionError);
    expect(
      normalizeEditorDoc(invalid).content?.[0]?.content?.[0]?.marks,
    ).toBeUndefined();
    const both = withMarks([
      { type: 'link', attrs: { href: 'https://example.com' } },
      { type: 'term', attrs: { termId: 'charger' } },
    ]);
    expect(() => fromEditor(both)).toThrow(ConversionError);
    expect(normalizeEditorDoc(both).content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com' } },
    ]);
  });
});
