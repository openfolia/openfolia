import type { Block, Module } from '@openfolia/content-model';
import fc from 'fast-check';
import { moduleArb } from '../testing/arbitraries.js';
import { must } from '../testing/must.js';
import { ConversionError } from './errors.js';
import { fromEditor } from './from-editor.js';
import type { EditorDoc, EditorNode } from './json.js';
import {
  DocumentTooLargeError,
  EditorLimitError,
  MAX_EDITOR_CHARS,
  MAX_EDITOR_DEPTH,
  MAX_EDITOR_NODES,
  NestingTooDeepError,
  TooManyNodesError,
} from './limits.js';
import { ID_NODES } from './spec.js';
import { normalizeEditorDoc } from './normalize.js';
import { toEditor } from './to-editor.js';

const meta = { title: 'A module', type: 'concept', lang: 'en', facets: {} };

function moduleOf(blocks: Block[]): Module {
  return { schemaVersion: 1, id: 'sample', meta, blocks };
}

const para = (id: string, text = 'text'): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

/** The ConversionError `run` throws. */
function failure(run: () => unknown): ConversionError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConversionError) return error;
    throw error;
  }
  throw new Error('expected a ConversionError');
}

function find(doc: EditorNode, id: string): EditorNode {
  const stack = [doc];
  while (stack.length > 0) {
    const node = must(stack.pop());
    if (node.attrs?.['id'] === id) return node;
    stack.push(...(node.content ?? []));
  }
  throw new Error(`no node "${id}"`);
}

function attrsOf(doc: EditorNode, id: string): Record<string, unknown> {
  return (find(doc, id).attrs ??= {});
}

function contentOf(doc: EditorNode, id: string): EditorNode[] {
  return (find(doc, id).content ??= []);
}

describe('fromEditor names the block of a problem', () => {
  it('for any block or list item whose text is emptied', () => {
    const withText = moduleArb
      .map((m) => ({ m, doc: toEditor(m) }))
      .chain(({ m, doc }) => {
        const holders: EditorNode[] = [];
        const visit = (n: EditorNode, parent?: EditorNode) => {
          // A cell's only paragraph emptied is an empty cell, which is fine.
          const emptyCell =
            parent?.type === 'tableCell' && parent.content?.length === 1;
          if (n.type === 'paragraph' && !emptyCell) holders.push(n);
          if (n.type === 'listItem') holders.push(n);
          n.content?.forEach((c) => visit(c, n));
        };
        visit(doc);
        return holders.length === 0
          ? fc.constant(null)
          : fc
              .nat(holders.length - 1)
              .map((i) => ({ m, doc, node: must(holders[i]) }));
      })
      .filter((x) => x !== null);
    fc.assert(
      fc.property(withText, ({ doc, node }) => {
        const target =
          node.type === 'listItem' ? must(node.content?.[0]) : node;
        delete target.content;
        expect(failure(() => fromEditor(doc)).blockId).toBe(node.attrs?.['id']);
      }),
      { numRuns: 300 },
    );
  });

  it('for any block (or callout) given a duplicate ID', () => {
    const pairs = moduleArb
      .map(toEditor)
      .chain((doc) => {
        const holders: EditorNode[] = [];
        const visit = (n: EditorNode) => {
          if (ID_NODES.has(n.type)) holders.push(n);
          n.content?.forEach(visit);
        };
        visit(doc);
        return holders.length < 2
          ? fc.constant(null)
          : fc
              .uniqueArray(fc.nat(holders.length - 1), {
                minLength: 2,
                maxLength: 2,
              })
              .map(([a = 0, b = 0]) => ({
                doc,
                from: must(holders[a]),
                to: must(holders[b]),
              }));
      })
      .filter((x) => x !== null);
    fc.assert(
      fc.property(pairs, ({ doc, from, to }) => {
        const id = from.attrs?.['id'];
        to.attrs = { ...to.attrs, id };
        const error = failure(() => fromEditor(doc));
        expect(error.blockId).toBe(id);
        expect(error.message).toMatch(/duplicate (block|callout) id/);
      }),
      { numRuns: 200 },
    );
  });

  const doc = toEditor(
    moduleOf([
      para('intro'),
      {
        type: 'safety',
        id: 'hot',
        severity: 'warning',
        hazard: [{ type: 'text', text: 'Hot surface' }],
        symbols: [],
        blocks: [para('burns')],
      },
      {
        type: 'list',
        id: 'steps',
        ordered: true,
        items: [
          { id: 'first', content: [{ type: 'text', text: 'One' }], blocks: [] },
        ],
      },
      {
        type: 'table',
        id: 'grid',
        columns: [{ width: 1 }, { width: 1 }],
        header: false,
        rows: [{ cells: [{ blocks: [para('c1')] }, { blocks: [para('c2')] }] }],
      },
      {
        type: 'variant',
        id: 'only-some',
        when: { op: 'in', attr: 'model', values: ['m-1'] },
        blocks: [para('inside')],
      },
    ]),
  );
  const copy = () => structuredClone(doc) as EditorDoc;

  it('for an unknown node or mark, or formatting on an atom', () => {
    const a = copy();
    contentOf(a, 'intro').push({ type: 'emoji', attrs: { name: 'x' } });
    expect(failure(() => fromEditor(a)).blockId).toBe('intro');

    const b = copy();
    must(contentOf(b, 'intro')[0]).marks = [{ type: 'bold' }];
    expect(failure(() => fromEditor(b))).toMatchObject({
      blockId: 'intro',
      message: expect.stringMatching(/unknown mark/),
    });

    const c = copy();
    contentOf(c, 'intro').push({
      type: 'attribute',
      attrs: { name: 'x' },
      marks: [{ type: 'strong' }],
    });
    expect(failure(() => fromEditor(c)).blockId).toBe('intro');

    const d = copy();
    (d.content ??= []).push({ type: 'heading', attrs: { id: 'h' } });
    expect(failure(() => fromEditor(d)).blockId).toBeNull();

    const e = copy();
    contentOf(e, 'hot').push({ type: 'blockquote', content: [] });
    expect(failure(() => fromEditor(e)).blockId).toBe('hot');
  });

  it('for content inside an atom or text, and formatting on a block', () => {
    const a = copy();
    contentOf(a, 'intro').push({
      type: 'attribute',
      attrs: { name: 'x' },
      content: [{ type: 'text', text: 'hidden' }],
    });
    expect(failure(() => fromEditor(a)).blockId).toBe('intro');

    const b = copy();
    find(b, 'burns').marks = [{ type: 'strong' }];
    expect(failure(() => fromEditor(b)).blockId).toBe('burns');
  });

  it('never takes an id inside an attribute value for a block', () => {
    const a = copy();
    attrsOf(a, 'grid')['columns'] = [
      { width: -1, id: 'not-a-block' },
      { width: 1 },
    ];
    expect(failure(() => fromEditor(a)).blockId).toBe('grid');

    const b = copy();
    attrsOf(b, 'only-some')['when'] = {
      op: 'in',
      attr: 'Bad Key',
      values: ['x'],
      id: 'not-a-block',
    };
    expect(failure(() => fromEditor(b)).blockId).toBe('only-some');
  });

  it('for a value the model refuses', () => {
    const a = copy();
    attrsOf(a, 'hot')['severity'] = 'mild';
    expect(failure(() => fromEditor(a))).toMatchObject({
      blockId: 'hot',
      message: expect.stringMatching(/^block "hot": severity/),
    });

    const b = copy();
    attrsOf(b, 'only-some')['when'] = null;
    expect(failure(() => fromEditor(b)).blockId).toBe('only-some');

    const c = copy();
    attrsOf(c, 'grid')['columns'] = [{ width: 1 }];
    expect(failure(() => fromEditor(c))).toMatchObject({
      blockId: 'grid',
      message: expect.stringMatching(/more cells/),
    });

    const d = copy();
    attrsOf(d, 'first')['id'] = 'Not An ID';
    expect(failure(() => fromEditor(d)).blockId).toBe('Not An ID');

    const e = copy();
    find(e, 'c2').content = [{ type: 'text', text: 'two\nlines' }];
    expect(failure(() => fromEditor(e)).blockId).toBe('c2');
  });

  it('for a link to any address but an absolute http, https or mailto one', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      '/relative',
    ]) {
      const a = copy();
      find(a, 'c2').content = [
        { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] },
      ];
      expect(
        failure(() => fromEditor(a)),
        href,
      ).toMatchObject({
        blockId: 'c2',
        message: expect.stringMatching(/link/),
      });
    }
  });

  it('for a node in the wrong place or missing', () => {
    const a = copy();
    delete find(a, 'hot').content;
    expect(failure(() => fromEditor(a))).toMatchObject({
      blockId: 'hot',
      message: expect.stringMatching(/hazard/),
    });

    const b = copy();
    contentOf(b, 'steps').push({
      type: 'paragraph',
      attrs: { id: 'stray' },
    });
    expect(failure(() => fromEditor(b)).blockId).toBe('steps');

    const c = copy();
    contentOf(c, 'first').shift();
    expect(failure(() => fromEditor(c)).blockId).toBe('first');

    const d = copy();
    attrsOf(d, 'burns')['id'] = null;
    expect(failure(() => fromEditor(d))).toMatchObject({
      blockId: 'hot',
      message: expect.stringMatching(/no ID/),
    });

    const e = copy();
    (must(contentOf(e, 'grid')[0]).content ??= []).push({
      type: 'paragraph',
      attrs: { id: 'p' },
    });
    expect(failure(() => fromEditor(e)).blockId).toBe('grid');
  });

  it('for a structure the model forbids, from its own checks', () => {
    const deep: Block = [1, 2, 3, 4, 5, 6].reduceRight<Block>(
      (inner, n) => ({
        type: 'section',
        id: `level-${n}`,
        title: [{ type: 'text', text: `L${n}` }],
        blocks: [inner],
      }),
      para('bottom'),
    );
    const error = failure(() =>
      fromEditor(toEditor({ ...moduleOf([]), blocks: [deep] } as Module)),
    );
    expect(error.blockId).toBe('level-6');
  });

  it('names the module, not a block, for its metadata', () => {
    const a = copy();
    a.attrs.meta = { ...meta, lang: 'not a language!' } as never;
    expect(failure(() => fromEditor(a))).toMatchObject({
      blockId: null,
      message: expect.stringMatching(/^meta\.lang/),
    });

    expect(failure(() => fromEditor({ type: 'paragraph' })).blockId).toBeNull();
  });

  it('lists every problem the model finds', () => {
    const a = copy();
    attrsOf(a, 'hot')['severity'] = 'mild';
    attrsOf(a, 'steps')['ordered'] = 'yes';
    const error = failure(() => fromEditor(a));
    expect(error.problems.map((p) => p.blockId)).toEqual(['hot', 'steps']);
    expect(error.message).toMatch(/and 1 more/);
  });
});

describe('the caps', () => {
  const doc = (content: unknown[]) => ({
    type: 'doc',
    attrs: { moduleId: 'm', schemaVersion: 1, meta },
    content,
  });

  it('refuse too many nodes, too deep a nesting and too large a document, with named errors', () => {
    const many = doc(
      Array.from({ length: MAX_EDITOR_NODES }, (_, i) => ({
        type: 'paragraph',
        attrs: { id: `p${i}` },
      })),
    );
    expect(() => fromEditor(many)).toThrow(TooManyNodesError);

    let deep: unknown = { type: 'paragraph', attrs: { id: 'p' } };
    for (let i = 0; i < MAX_EDITOR_DEPTH; i++)
      deep = {
        type: 'admonition',
        attrs: { id: `a${i}`, kind: 'note' },
        content: [deep],
      };
    expect(() => fromEditor(doc([deep]))).toThrow(NestingTooDeepError);

    const large = doc([
      {
        type: 'paragraph',
        attrs: { id: 'p' },
        content: [{ type: 'text', text: 'x'.repeat(MAX_EDITOR_CHARS) }],
      },
    ]);
    expect(() => fromEditor(large)).toThrow(DocumentTooLargeError);

    let when: unknown = { op: 'in', attr: 'model', values: ['x'] };
    for (let i = 0; i < 3000; i++) when = { op: 'not', of: when };
    const deepCondition = doc([
      {
        type: 'variant',
        attrs: { id: 'v', when },
        content: [{ type: 'paragraph', attrs: { id: 'p' } }],
      },
    ]);
    expect(() => fromEditor(deepCondition)).toThrow(NestingTooDeepError);

    const cyclic = doc([]) as { attrs: Record<string, unknown> };
    cyclic.attrs['self'] = cyclic;
    expect(() => fromEditor(cyclic)).toThrow(EditorLimitError);
  });

  it('hold for toEditor too', () => {
    let deep: Block = para('bottom');
    for (let i = 0; i < MAX_EDITOR_DEPTH; i++)
      deep = { type: 'admonition', id: `a${i}`, kind: 'note', blocks: [deep] };
    expect(() => toEditor(moduleOf([deep]))).toThrow(NestingTooDeepError);
    expect(() =>
      toEditor(
        moduleOf(
          Array.from({ length: MAX_EDITOR_NODES }, (_, i) => para(`p${i}`)),
        ),
      ),
    ).toThrow(TooManyNodesError);
  });

  it('let a document just under them through', () => {
    let deep: Block = para('bottom');
    for (let i = 0; i < MAX_EDITOR_DEPTH - 2; i++)
      deep = { type: 'admonition', id: `a${i}`, kind: 'note', blocks: [deep] };
    const module = moduleOf([deep]);
    expect(fromEditor(toEditor(module))).toStrictEqual(module);
  });
});

describe('toEditor', () => {
  it('names the block of a type it does not know', () => {
    const module = moduleOf([
      para('ok'),
      { type: 'chart', id: 'sales' } as unknown as Block,
    ]);
    expect(failure(() => toEditor(module)).blockId).toBe('sales');
    const inline = moduleOf([
      { type: 'paragraph', id: 'p', content: [{ type: 'emoji' } as never] },
    ]);
    expect(failure(() => toEditor(inline)).blockId).toBe('p');
  });
});

describe('empty table cells', () => {
  const table = (rows: Block[][][], header = false): Block => ({
    type: 'table',
    id: 'grid',
    header,
    columns: (rows[0] ?? []).map(() => ({ width: 1 })),
    rows: rows.map((cells) => ({ cells: cells.map((blocks) => ({ blocks })) })),
  });

  it.each([
    ['an empty cell', table([[[para('a')], []]])],
    [
      'an empty column',
      table(
        [
          [[para('h')], []],
          [[para('b')], []],
        ],
        true,
      ),
    ],
    [
      'an all-empty table',
      table([
        [[], []],
        [[], []],
      ]),
    ],
  ])('save %s as a cell with no blocks, and round-trip', (_, t) => {
    const module = moduleOf([t]);
    // The editor shows an empty cell with an empty paragraph to type in.
    const doc = normalizeEditorDoc(toEditor(module));
    const cells = doc.content
      ?.find((n) => n.type === 'table')
      ?.content?.filter((n) => n.type === 'tableRow')
      .flatMap((row) => row.content ?? []);
    expect(cells?.every((c) => (c.content?.length ?? 0) > 0)).toBe(true);
    expect(fromEditor(doc)).toEqual(module);
  });

  it('keep a cell whose only paragraph has text', () => {
    const module = moduleOf([table([[[para('a', 'x')]]])]);
    expect(fromEditor(toEditor(module))).toEqual(module);
  });
});
