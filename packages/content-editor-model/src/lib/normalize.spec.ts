import { BlockId } from '@openfolia/content-model';
import fc from 'fast-check';
import { moduleArb } from '../testing/arbitraries.js';
import { must } from '../testing/must.js';
import { ConversionError } from './errors.js';
import { getEditorSchema } from './extensions.js';
import { fromEditor } from './from-editor.js';
import type { EditorDoc, EditorNode } from './json.js';
import {
  EditorLimitError,
  MAX_EDITOR_CHARS,
  MAX_EDITOR_NODES,
  NestingTooDeepError,
  TooManyNodesError,
  exceededLimit,
} from './limits.js';
import { normalizeEditorDoc } from './normalize.js';
import { ID_NODES, MARK_NAMES, NODE_ATTRS } from './spec.js';
import { toEditor } from './to-editor.js';

// ---------------------------------------------------------------------------
// Broken documents: random node-like garbage, and valid documents with random damage.

const NAMES = [
  ...Object.keys(NODE_ATTRS),
  'heading',
  'bulletList',
  'blockquote',
  '',
];
const ATTR_KEYS = [
  ...new Set(Object.values(NODE_ATTRS).flatMap((a) => Object.keys(a))),
];

const garbageNode = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.jsonValue({ maxDepth: 2 }),
    fc.record(
      {
        type: fc.constantFrom(...NAMES),
        attrs: fc.dictionary(
          fc.constantFrom(...ATTR_KEYS, 'extra'),
          fc.jsonValue({ maxDepth: 2 }),
        ),
        content: fc.array(tie('node'), { maxLength: 4 }),
        text: fc.string({ maxLength: 6 }).map((s) => s.replace(/x/g, '\n')),
        marks: fc.array(
          fc.record({
            type: fc.constantFrom(...MARK_NAMES, 'bold', 'italic'),
            attrs: fc.dictionary(
              fc.constantFrom('href', 'title'),
              fc.jsonValue({ maxDepth: 1 }),
            ),
          }),
          { maxLength: 3 },
        ),
      },
      { requiredKeys: [] },
    ),
  ),
})).node;

const garbageDoc = fc
  .record({
    attrs: fc.option(
      fc.dictionary(
        fc.constantFrom('moduleId', 'schemaVersion', 'meta'),
        fc.jsonValue({ maxDepth: 2 }),
      ),
    ),
    content: fc.array(garbageNode, { maxLength: 5 }),
  })
  .map((x) => ({ type: 'doc', ...x }));

type Damage =
  | 'dropAttrs'
  | 'nullId'
  | 'copyId'
  | 'retype'
  | 'wrap'
  | 'lineBreak'
  | 'reverse'
  | 'inject'
  | 'empty';
const DAMAGE: Damage[] = [
  'dropAttrs',
  'nullId',
  'copyId',
  'retype',
  'wrap',
  'lineBreak',
  'reverse',
  'inject',
  'empty',
];

function nodesOf(doc: EditorNode): EditorNode[] {
  const out: EditorNode[] = [];
  const visit = (n: EditorNode) => {
    if (typeof n !== 'object' || n === null) return;
    out.push(n);
    if (Array.isArray(n.content)) n.content.forEach(visit);
  };
  visit(doc);
  return out;
}

function damage(
  doc: EditorDoc,
  hits: { at: number; kind: Damage; other: number; junk: unknown }[],
): EditorDoc {
  for (const { at, kind, other, junk } of hits) {
    const nodes = nodesOf(doc);
    const node = must(nodes[at % nodes.length]);
    const source = must(nodes[other % nodes.length]);
    switch (kind) {
      case 'dropAttrs':
        delete node.attrs;
        break;
      case 'nullId':
        if (node.attrs) node.attrs['id'] = null;
        break;
      case 'copyId':
        if (node.attrs && source.attrs?.['id'])
          node.attrs['id'] = source.attrs['id'];
        break;
      case 'retype':
        if (node !== doc) node.type = source.type;
        break;
      case 'wrap':
        if (node.content)
          node.content = [{ type: 'mystery', content: node.content }];
        break;
      case 'lineBreak':
        if (typeof node.text === 'string')
          node.text = `${node.text}\n${node.text}`;
        break;
      case 'reverse':
        node.content?.reverse();
        break;
      case 'inject':
        (node.content ??= []).push(junk as EditorNode);
        break;
      case 'empty':
        delete node.content;
        break;
    }
  }
  return doc;
}

const damagedDoc = fc
  .tuple(
    moduleArb,
    fc.array(
      fc.record({
        at: fc.nat(),
        kind: fc.constantFrom(...DAMAGE),
        other: fc.nat(),
        junk: garbageNode,
      }),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([module, hits]) => damage(toEditor(module), hits));

const brokenDoc = fc.oneof(garbageDoc, damagedDoc, fc.anything());

// ---------------------------------------------------------------------------

function throughProseMirror(doc: unknown): unknown {
  const node = getEditorSchema().nodeFromJSON(doc);
  node.check();
  return JSON.parse(JSON.stringify(node.toJSON()));
}

function ids(doc: EditorNode): unknown[] {
  return nodesOf(doc)
    .filter((n) => ID_NODES.has(n.type))
    .map((n) => n.attrs?.['id']);
}

describe('normalizeEditorDoc', () => {
  it('throws only a limit error, and its result is valid in the schema, in ProseMirror JSON form, and a fixed point', () => {
    fc.assert(
      fc.property(brokenDoc, (input) => {
        let once: EditorDoc;
        try {
          once = normalizeEditorDoc(input);
        } catch (error) {
          expect(error).toBeInstanceOf(EditorLimitError);
          return;
        }
        expect(throughProseMirror(once)).toStrictEqual(once);
        expect(normalizeEditorDoc(once)).toStrictEqual(once);
        const all = ids(once);
        expect(new Set(all).size).toBe(all.length);
        for (const id of all) expect(BlockId.safeParse(id).success).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });

  it('keeps every character of text it was given', () => {
    /** Non-space characters of the text nodes reachable along `content`, counted. */
    const characters = (value: unknown): Map<string, number> => {
      const counts = new Map<string, number>();
      const visit = (node: unknown) => {
        if (typeof node !== 'object' || node === null || Array.isArray(node))
          return;
        const n = node as Record<string, unknown>;
        if (n['type'] === 'text' && typeof n['text'] === 'string')
          for (const ch of n['text'])
            if (ch.trim() !== '') counts.set(ch, (counts.get(ch) ?? 0) + 1);
        if (Array.isArray(n['content'])) n['content'].forEach(visit);
      };
      visit(value);
      return counts;
    };
    fc.assert(
      fc.property(fc.oneof(garbageDoc, damagedDoc), (input) => {
        const before = characters(input);
        let after: Map<string, number>;
        try {
          after = characters(normalizeEditorDoc(input));
        } catch (error) {
          expect(error).toBeInstanceOf(EditorLimitError);
          return;
        }
        for (const [ch, count] of before)
          expect({ ch, count: after.get(ch) ?? 0 }).toEqual({
            ch,
            count: Math.max(count, after.get(ch) ?? 0),
          });
      }),
      { numRuns: 1000 },
    );
  });

  it('leaves fromEditor nothing but ConversionErrors', () => {
    fc.assert(
      fc.property(brokenDoc, (input) => {
        try {
          fromEditor(normalizeEditorDoc(input));
        } catch (error) {
          if (!(error instanceof EditorLimitError))
            expect(error).toBeInstanceOf(ConversionError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  const doc = (content: unknown[]): unknown => ({
    type: 'doc',
    attrs: { moduleId: 'm', schemaVersion: 1, meta: null },
    content,
  });
  const p = (id: unknown, text?: string) => ({
    type: 'paragraph',
    attrs: { id },
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  });
  let counter = 0;
  const newId = (taken: ReadonlySet<string>) => {
    let id: string;
    do id = `new-${++counter}`;
    while (taken.has(id));
    return id;
  };
  beforeEach(() => {
    counter = 0;
  });

  it('keeps the first of two equal IDs and gives the later block, and blocks without one, a new ID', () => {
    const out = normalizeEditorDoc(
      doc([
        p('a', 'one'),
        p('a', 'two'),
        p(null, 'three'),
        p('Not valid', 'four'),
      ]),
      {
        newId,
      },
    );
    expect(ids(out)).toEqual(['a', 'new-1', 'new-2', 'new-3']);
  });

  it('never hands out an ID that is already taken further on', () => {
    const out = normalizeEditorDoc(doc([p(null, 'x'), p('new-1', 'y')]), {
      newId,
    });
    expect(ids(out)).toEqual(['new-2', 'new-1']);
  });

  it('turns line breaks into hardBreak nodes, and into spaces in a title', () => {
    const out = normalizeEditorDoc(
      doc([
        {
          type: 'paragraph',
          attrs: { id: 'p' },
          content: [{ type: 'text', text: 'a\nb' }],
        },
        {
          type: 'section',
          attrs: { id: 's' },
          content: [
            {
              type: 'title',
              content: [
                { type: 'text', text: 'c\r\nd' },
                { type: 'hardBreak' },
                { type: 'text', text: 'e' },
              ],
            },
          ],
        },
      ]),
    );
    expect(out.content?.[0]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
    expect(out.content?.[1]?.content?.[0]).toEqual({
      type: 'title',
      content: [{ type: 'text', text: 'c d e' }],
    });
  });

  it('sorts marks, keeps one of each type, drops unknown ones and merges equal runs', () => {
    const out = normalizeEditorDoc(
      doc([
        {
          type: 'paragraph',
          attrs: { id: 'p' },
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [
                { type: 'strong' },
                { type: 'link', attrs: { href: 'https://x.org' } },
                { type: 'strong' },
                { type: 'bold' },
              ],
            },
            {
              type: 'text',
              text: 'b',
              marks: [
                { type: 'link', attrs: { href: 'https://x.org' } },
                { type: 'strong' },
              ],
            },
            {
              type: 'attribute',
              attrs: { name: 'n' },
              marks: [{ type: 'strong' }],
            },
            { type: 'text', text: '' },
          ],
        },
      ]),
    );
    expect(out.content?.[0]?.content).toEqual([
      {
        type: 'text',
        text: 'ab',
        marks: [
          { type: 'link', attrs: { href: 'https://x.org' } },
          { type: 'strong' },
        ],
      },
      { type: 'attribute', attrs: { name: 'n' } },
    ]);
  });

  it('drops a link to an address the model refuses, keeping its text', () => {
    const run = (href: unknown) => ({
      type: 'text',
      text: 'x',
      marks: [{ type: 'strong' }, { type: 'link', attrs: { href } }],
    });
    for (const href of ['javascript:alert(1)', 'data:,x', '/a', '', 3]) {
      const out = normalizeEditorDoc(
        doc([{ type: 'paragraph', attrs: { id: 'p' }, content: [run(href)] }]),
      );
      expect(out.content?.[0]?.content, String(href)).toEqual([
        { type: 'text', text: 'x', marks: [{ type: 'strong' }] },
      ]);
    }
  });

  it('moves a block after a section into that section, at its deepest end', () => {
    const section = (id: string, content: unknown[]) => ({
      type: 'section',
      attrs: { id },
      content: [
        { type: 'title', content: [{ type: 'text', text: id }] },
        ...content,
      ],
    });
    const out = normalizeEditorDoc(
      doc([section('s1', [section('s2', [])]), p('late', 'text')]),
    );
    expect(out.content).toHaveLength(1);
    const inner = out.content?.[0]?.content?.[1];
    expect(inner?.attrs?.['id']).toBe('s2');
    expect(inner?.content?.at(-1)?.attrs?.['id']).toBe('late');
  });

  it('unwraps what may not stand somewhere, keeping its text', () => {
    const out = normalizeEditorDoc(
      doc([
        { type: 'blockquote', content: [p('q', 'quoted')] },
        { type: 'text', text: 'loose' },
        {
          type: 'admonition',
          attrs: { id: 'a', kind: 'tip' },
          content: [
            {
              type: 'section',
              attrs: { id: 'inner' },
              content: [
                { type: 'title', content: [{ type: 'text', text: 'T' }] },
                p('x', 'body'),
              ],
            },
          ],
        },
      ]),
      { newId },
    );
    expect(out.content?.map((n) => n.attrs?.['id'])).toEqual([
      'q',
      'new-1',
      'a',
    ]);
    expect(out.content?.[1]?.content).toEqual([
      { type: 'text', text: 'loose' },
    ]);
    expect(
      out.content?.[2]?.content?.map((n) => [n.type, n.attrs?.['id']]),
    ).toEqual([
      ['paragraph', 'inner'],
      ['paragraph', 'x'],
    ]);
  });

  it('keeps a page break in the document and a section, and drops one anywhere else', () => {
    const pageBreak = (id: string) => ({ type: 'pageBreak', attrs: { id } });
    const out = normalizeEditorDoc(
      doc([
        p('a', 'one'),
        pageBreak('b1'),
        {
          type: 'admonition',
          attrs: { id: 'n', kind: 'note' },
          content: [p('x', 'in a note'), pageBreak('b2')],
        },
        {
          type: 'section',
          attrs: { id: 's' },
          content: [
            { type: 'title', content: [{ type: 'text', text: 'S' }] },
            pageBreak('b3'),
            p('y', 'in a section'),
          ],
        },
      ]),
    );
    expect(out.content?.map((n) => [n.type, n.attrs?.['id']])).toEqual([
      ['paragraph', 'a'],
      ['pageBreak', 'b1'],
      ['admonition', 'n'],
      ['section', 's'],
    ]);
    expect(out.content?.[2]?.content?.map((n) => n.type)).toEqual([
      'paragraph',
    ]);
    expect(out.content?.[3]?.content?.map((n) => n.type)).toEqual([
      'title',
      'pageBreak',
      'paragraph',
    ]);
  });

  it('fills what the schema requires: a title, a hazard, item text, a paragraph in an empty container', () => {
    const out = normalizeEditorDoc(
      doc([
        { type: 'safety', attrs: { id: 'w', severity: 'danger' } },
        {
          type: 'list',
          attrs: { id: 'l' },
          content: [{ type: 'listItem', attrs: { id: 'i' } }],
        },
        {
          type: 'variant',
          attrs: { id: 'v', when: { op: 'in', attr: 'model', values: ['x'] } },
        },
        { type: 'section', attrs: { id: 's' } },
      ]),
      { newId },
    );
    expect(throughProseMirror(out)).toStrictEqual(out);
    expect(out.content?.[0]?.content?.[0]).toEqual({ type: 'hazard' });
    expect(out.content?.[1]?.content?.[0]?.content).toEqual([
      { type: 'itemText' },
    ]);
    expect(out.content?.[2]?.content).toEqual([p('new-1')]);
    expect(out.content?.[3]?.content).toEqual([{ type: 'title' }]);
  });

  it('gives attributes their schema type and drops unknown ones', () => {
    const out = normalizeEditorDoc(
      doc([
        {
          type: 'image',
          attrs: { id: 'i', asset: 42, alt: 'Alt', width: 'wide', extra: true },
        },
        {
          type: 'variant',
          attrs: { id: 'v', when: 'model = x' },
          content: [p('x', 'y')],
        },
      ]),
    );
    expect(out.content?.[0]?.attrs).toEqual({
      id: 'i',
      asset: '',
      alt: 'Alt',
      width: null,
      calloutOrder: null,
      calloutLegend: null,
    });
    // A condition that isn't one stays missing, and fromEditor says so for the block.
    expect(out.content?.[1]?.attrs).toEqual({ id: 'v', when: null });
    expect(() => fromEditor(out)).toThrow(ConversionError);
  });

  it('refuses a document over the caps, or one its repair would take over them, with the named error', () => {
    const many = doc(
      Array.from({ length: MAX_EDITOR_NODES }, (_, i) => p(`p${i}`, 'x')),
    );
    expect(() => normalizeEditorDoc(many)).toThrow(TooManyNodesError);

    let deep: unknown = p('leaf', 'x');
    for (let i = 0; i < 100_000; i++)
      deep = { type: 'admonition', attrs: { id: `a${i}` }, content: [deep] };
    expect(() => normalizeEditorDoc(doc([deep]))).toThrow(NestingTooDeepError);

    // Line breaks become nodes: within the caps as given, over them once repaired.
    const breaks = doc([p('p', '\n'.repeat(MAX_EDITOR_NODES + 10))]);
    expect(exceededLimit(breaks)).toBeNull();
    expect(() => normalizeEditorDoc(breaks)).toThrow(TooManyNodesError);

    const cyclic = doc([]) as { content: unknown[] };
    cyclic.content.push(cyclic);
    expect(() => normalizeEditorDoc(cyclic)).toThrow(EditorLimitError);

    let nested: unknown = 'x';
    for (let i = 0; i < 100_000; i++) nested = { op: 'not', of: nested };
    const condition = doc([
      {
        type: 'variant',
        attrs: { id: 'v', when: nested },
        content: [p('x', 'y')],
      },
    ]);
    expect(() => normalizeEditorDoc(condition)).toThrow(NestingTooDeepError);
  });

  it('stops quickly on a shared object met again and again', () => {
    let shared: unknown = { a: 1 };
    for (let i = 0; i < 40; i++) shared = { a: shared, b: shared };
    const start = Date.now();
    const input = doc([
      { type: 'paragraph', attrs: { id: 'p', extra: shared } },
    ]);
    expect(exceededLimit(input)).toBeInstanceOf(EditorLimitError);
    expect(() =>
      normalizeEditorDoc({ ...(input as object), attrs: { meta: shared } }),
    ).toThrow(EditorLimitError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("lets a getter's or newId's own error through, and returns nothing short", () => {
    const hostile = doc([
      Object.defineProperty({ type: 'paragraph' }, 'content', {
        enumerable: true,
        get() {
          throw new Error('no');
        },
      }),
    ]);
    expect(() => normalizeEditorDoc(hostile)).toThrow('no');
    expect(() =>
      normalizeEditorDoc(doc([p(null, 'x')]), {
        newId: () => {
          throw new Error('no ids today');
        },
      }),
    ).toThrow('no ids today');
  });

  it('moves a block found in a line of text out after it, whole', () => {
    const out = normalizeEditorDoc(
      doc([
        {
          type: 'paragraph',
          attrs: { id: 'p' },
          content: [
            { type: 'text', text: 'before ' },
            {
              type: 'passthrough',
              attrs: { id: 'raw', format: 'xml', raw: '<important/>' },
            },
            {
              type: 'image',
              attrs: { id: 'img', asset: 'sha256:x', alt: 'A' },
            },
            { type: 'text', text: 'after' },
          ],
        },
        {
          type: 'section',
          attrs: { id: 's' },
          content: [
            {
              type: 'title',
              content: [
                { type: 'text', text: 'T' },
                {
                  type: 'literal',
                  attrs: { id: 'code', language: 'yaml' },
                  content: [{ type: 'text', text: 'a: 1' }],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(out.content?.map((n) => [n.type, n.attrs?.['id']])).toEqual([
      ['paragraph', 'p'],
      ['passthrough', 'raw'],
      ['image', 'img'],
      ['section', 's'],
    ]);
    expect(out.content?.[0]?.content).toEqual([
      { type: 'text', text: 'before after' },
    ]);
    expect(out.content?.[1]?.attrs).toEqual({
      id: 'raw',
      format: 'xml',
      raw: '<important/>',
    });
    expect(out.content?.[3]?.content?.[1]).toEqual({
      type: 'literal',
      attrs: { id: 'code', language: 'yaml' },
      content: [{ type: 'text', text: 'a: 1' }],
    });
  });

  it('takes a list of nodes as the content, and bare strings as text', () => {
    const out = normalizeEditorDoc(
      [p('p', 'hello'), 'loose', { text: 'typeless' }],
      { newId },
    );
    expect(out.content).toEqual([
      p('p', 'hello'),
      {
        type: 'paragraph',
        attrs: { id: 'new-1' },
        content: [{ type: 'text', text: 'loosetypeless' }],
      },
    ]);
  });

  it('counts the size as JSON.stringify writes it', () => {
    const sized = (length: number) => doc([p('p', 'x'.repeat(length))]);
    const base = JSON.stringify(sized(1)).length - 1;
    expect(JSON.stringify(sized(MAX_EDITOR_CHARS - base)).length).toBe(
      MAX_EDITOR_CHARS,
    );
    expect(exceededLimit(sized(MAX_EDITOR_CHARS - base))).toBeNull();
    expect(exceededLimit(sized(MAX_EDITOR_CHARS - base + 1))).toBeInstanceOf(
      EditorLimitError,
    );
  });

  it('merges many runs with long marks quickly', () => {
    const href = `https://example.com/${'x'.repeat(1_000_000)}`;
    const title = {
      type: 'section',
      attrs: { id: 's' },
      content: [
        {
          type: 'title',
          content: [
            {
              type: 'text',
              text: 'a\n'.repeat(5_000),
              marks: [{ type: 'link', attrs: { href } }],
            },
          ],
        },
      ],
    };
    const start = Date.now();
    const out = normalizeEditorDoc(doc([title]));
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(out.content?.[0]?.content?.[0]?.content).toHaveLength(1);
  });

  it('writes an inline atom inside a literal as its text', () => {
    const out = normalizeEditorDoc(
      doc([
        {
          type: 'literal',
          attrs: { id: 'l', language: null },
          content: [
            { type: 'text', text: 'v=' },
            { type: 'attribute', attrs: { name: 'rated-load' } },
            { type: 'text', text: ' ' },
            { type: 'kbd', attrs: { keys: ['Ctrl', 'S'] } },
          ],
        },
      ]),
    );
    expect(out.content?.[0]?.content).toEqual([
      { type: 'text', text: 'v={rated-load} Ctrl+S' },
    ]);
  });

  it('leaves out an undefined property instead of losing the whole value', () => {
    const out = normalizeEditorDoc({
      type: 'doc',
      attrs: {
        moduleId: 'm',
        schemaVersion: 1,
        meta: { title: 'T', type: 'concept', lang: 'en', audience: undefined },
      },
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p' },
          content: [
            {
              type: 'xref',
              attrs: {
                module: 'm2',
                text: [{ type: 'text', text: 'hi', marks: undefined }],
              },
            },
          ],
        },
      ],
    });
    expect(out.attrs.meta).toEqual({ title: 'T', type: 'concept', lang: 'en' });
    expect(out.content?.[0]?.content?.[0]?.attrs?.['text']).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });
});
