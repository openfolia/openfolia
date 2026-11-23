import { type Module, normalizeModule } from '@openfolia/content-model';
import fc from 'fast-check';
import { moduleArb } from '../testing/arbitraries.js';
import { getEditorSchema } from './extensions.js';
import { fromEditor } from './from-editor.js';
import { normalizeEditorDoc } from './normalize.js';
import { toEditor } from './to-editor.js';

const normalArb = moduleArb.map(normalizeModule);

/** The document as a real ProseMirror document, back as JSON. */
function throughProseMirror(doc: unknown): unknown {
  const node = getEditorSchema().nodeFromJSON(doc);
  node.check();
  // ProseMirror builds attributes on null-prototype objects; JSON is what travels.
  return JSON.parse(JSON.stringify(node.toJSON()));
}

const noNewIds = () => {
  throw new Error('a valid document needs no new IDs');
};

describe('the converters', () => {
  it('fromEditor(toEditor(m)) is m, for any valid module', () => {
    fc.assert(
      fc.property(moduleArb, (module) => {
        expect(fromEditor(toEditor(module))).toStrictEqual(module);
      }),
      { numRuns: 3000 },
    );
  });

  it('toEditor(m) is a valid ProseMirror document, and only normalizes on the way through one', () => {
    fc.assert(
      fc.property(moduleArb, (module) => {
        // ProseMirror merges text runs and sorts marks; a cross-reference's text is an attribute it keeps as is.
        const back = fromEditor(throughProseMirror(toEditor(module)));
        expect(normalizeModule(back)).toStrictEqual(normalizeModule(module));
      }),
      { numRuns: 1500 },
    );
  });

  it('writes a module in normal form exactly as ProseMirror does', () => {
    fc.assert(
      fc.property(normalArb, (module) => {
        const doc = toEditor(module);
        expect(throughProseMirror(doc)).toStrictEqual(doc);
      }),
      { numRuns: 1500 },
    );
  });

  it('normalizeEditorDoc leaves a converted module in normal form alone', () => {
    fc.assert(
      fc.property(normalArb, (module) => {
        const doc = toEditor(module);
        expect(normalizeEditorDoc(doc, { newId: noNewIds })).toStrictEqual(doc);
      }),
      { numRuns: 1500 },
    );
  });

  it('shares nothing between the module and the document', () => {
    fc.assert(
      fc.property(moduleArb, (module) => {
        const copy = structuredClone(module);
        const doc = toEditor(module);
        const back = fromEditor(doc);
        // Scribble over every object in the document and the result.
        const scribble = (value: unknown) => {
          if (typeof value !== 'object' || value === null) return;
          for (const key of Object.keys(value)) {
            scribble((value as Record<string, unknown>)[key]);
            (value as Record<string, unknown>)[key] = 'x';
          }
        };
        scribble(doc);
        expect(module).toStrictEqual(copy);
        scribble(back);
        expect(module).toStrictEqual(copy);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps an empty module', () => {
    const module: Module = {
      schemaVersion: 1,
      id: 'empty',
      meta: { title: 'Empty', type: 'concept', lang: 'en', facets: {} },
      blocks: [],
    };
    const doc = toEditor(module);
    expect(doc).toStrictEqual({
      type: 'doc',
      attrs: { moduleId: 'empty', schemaVersion: 1, meta: module.meta },
    });
    expect(fromEditor(doc)).toStrictEqual(module);
    expect(throughProseMirror(doc)).toStrictEqual(doc);
  });

  it('carries a module reference to one block both ways (#223)', () => {
    const module: Module = {
      schemaVersion: 1,
      id: 'host',
      meta: { title: 'Host', type: 'concept', lang: 'en', facets: {} },
      blocks: [
        { type: 'moduleRef', id: 'whole', module: 'shared' },
        { type: 'moduleRef', id: 'one', module: 'shared', block: 'acid' },
      ],
    };
    const doc = toEditor(module);
    expect(doc.content).toStrictEqual([
      {
        type: 'moduleRef',
        attrs: { id: 'whole', module: 'shared', block: null },
      },
      {
        type: 'moduleRef',
        attrs: { id: 'one', module: 'shared', block: 'acid' },
      },
    ]);
    expect(fromEditor(doc)).toStrictEqual(module);
    expect(throughProseMirror(doc)).toStrictEqual(doc);
  });
});
