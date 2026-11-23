import {
  Block,
  Condition,
  Inline,
  MARK_ORDER,
  Mark,
  type Module,
  walk,
} from '@openfolia/content-model';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatorTypes, moduleArb } from '../testing/arbitraries.js';
import { must } from '../testing/must.js';
import { getEditorSchema } from './extensions.js';
import type { EditorNode } from './json.js';
import { toEditor } from './to-editor.js';
import {
  BLOCK_NODES,
  INLINE_NODES,
  MARK_ATTRS,
  NODE_ATTRS,
  STRUCTURAL_NODES,
} from './spec.js';

// The editor schema against the content model: a node type, attribute or
// mark that one has and the other hasn't fails here, instead of silently
// losing what someone wrote.

/** Just enough of a Zod schema's internals to read its shape. */
interface ZodLike {
  _zod: { def: Record<string, unknown> };
}
type Shape = Record<string, ZodLike>;

/** The member schemas of a (lazy) discriminated union, by discriminator value. */
function members(zodSchema: unknown, key: string): Map<string, Shape> {
  const schema = zodSchema as ZodLike;
  const def = schema._zod.def;
  const union = (def['type'] === 'lazy'
    ? (def['getter'] as () => ZodLike)()
    : schema) as unknown as { options: { shape: Shape }[] };
  return new Map(
    union.options.map((o) => [
      (o.shape[key] as unknown as { value: string }).value,
      o.shape,
    ]),
  );
}

function unwrap(schema: ZodLike): ZodLike {
  let current = schema;
  for (;;) {
    const def = current._zod.def;
    if (def['type'] === 'optional' || def['type'] === 'default') {
      current = def['innerType'] as typeof current;
    } else if (def['type'] === 'array') {
      current = def['element'] as typeof current;
    } else if (def['type'] === 'pipe') {
      current = def['in'] as typeof current;
    } else {
      return current;
    }
  }
}

function keysOf(schema: ZodLike): string[] {
  return Object.keys(
    (unwrap(schema) as unknown as { shape: Shape }).shape,
  ).sort();
}

/**
 * Where each field of a block lives in the editor: an attribute of the
 * block's node, or a child node. Typed by the model, so a new block type
 * needs an entry here.
 */
const CHILDREN: { [K in Block['type']]: string[] } = {
  paragraph: ['content'],
  section: ['title', 'blocks'],
  list: ['items'],
  procedure: ['title', 'steps'],
  table: ['title', 'rows'],
  image: ['title', 'callouts'],
  attachment: [],
  safety: ['hazard', 'blocks'],
  admonition: ['blocks'],
  faq: ['question', 'blocks'],
  variant: ['blocks'],
  moduleRef: [],
  literal: ['text'],
  passthrough: [],
  pageBreak: [],
};

const sorted = (list: Iterable<string>) => [...list].sort();

describe('the editor schema', () => {
  const schema = getEditorSchema();

  it('has a node for every block and inline type, and the structural nodes, nothing else', () => {
    const blocks = members(Block, 'type');
    const inlines = members(Inline, 'type');
    expect(sorted(Object.keys(BLOCK_NODES))).toEqual(sorted(blocks.keys()));
    expect(sorted(Object.keys(INLINE_NODES))).toEqual(sorted(inlines.keys()));
    expect(sorted(Object.keys(schema.nodes))).toEqual(
      sorted([
        ...Object.values(BLOCK_NODES),
        ...Object.values(INLINE_NODES),
        ...STRUCTURAL_NODES,
      ]),
    );
    expect(sorted(Object.keys(schema.nodes))).toEqual(
      sorted(Object.keys(NODE_ATTRS)),
    );
  });

  it("gives each block node the block's fields as attributes, apart from its children", () => {
    for (const [type, shape] of members(Block, 'type')) {
      const name = BLOCK_NODES[type as Block['type']];
      const children = CHILDREN[type as Block['type']];
      const fields = Object.keys(shape).filter(
        (k) => k !== 'type' && !children.includes(k),
      );
      expect({ type, attrs: sorted(Object.keys(NODE_ATTRS[name])) }).toEqual({
        type,
        attrs: sorted(fields),
      });
      expect({
        type,
        attrs: sorted(Object.keys(must(schema.nodes[name]).spec.attrs ?? {})),
      }).toEqual({ type, attrs: sorted(fields) });
    }
  });

  it("gives list items, table cells and inline nodes the model's fields", () => {
    const blocks = members(Block, 'type');
    const list = must(blocks.get('list'));
    expect(keysOf(must(list['items']))).toEqual(['blocks', 'content', 'id']);
    expect(sorted(Object.keys(NODE_ATTRS.listItem))).toEqual(['id']);

    // A callout is a node in its image, holding its legend; its other fields are attributes.
    const callouts = must(must(blocks.get('image'))['callouts']);
    expect(sorted(Object.keys(NODE_ATTRS.callout))).toEqual(
      keysOf(callouts).filter((k) => k !== 'legend'),
    );

    const rows = must(must(blocks.get('table'))['rows']);
    expect(keysOf(rows)).toEqual(['cells']);
    const cells = must(
      (unwrap(rows) as unknown as { shape: Shape }).shape['cells'],
    );
    expect(keysOf(cells)).toEqual(['blocks', 'colspan', 'rowspan']);
    expect(sorted(Object.keys(NODE_ATTRS.tableCell))).toEqual([
      'colspan',
      'rowspan',
    ]);

    for (const [type, shape] of members(Inline, 'type')) {
      const name = INLINE_NODES[type as Inline['type']];
      const fields = Object.keys(shape).filter(
        (k) =>
          k !== 'type' && !(type === 'text' && (k === 'text' || k === 'marks')),
      );
      expect({ type, attrs: sorted(Object.keys(NODE_ATTRS[name])) }).toEqual({
        type,
        attrs: sorted(fields),
      });
    }
  });

  it("has the model's marks with their fields, ranked in the model's order", () => {
    const marks = members(Mark, 'type');
    expect(sorted(Object.keys(MARK_ATTRS))).toEqual(sorted(marks.keys()));
    for (const [type, shape] of marks) {
      expect({
        type,
        attrs: sorted(Object.keys(MARK_ATTRS[type as Mark['type']])),
      }).toEqual({
        type,
        attrs: sorted(Object.keys(shape).filter((k) => k !== 'type')),
      });
    }
    const ranked = Object.values(schema.marks)
      .sort(
        (a, b) =>
          (a as unknown as { rank: number }).rank -
          (b as unknown as { rank: number }).rank,
      )
      .map((m) => m.name);
    expect(ranked).toEqual([...MARK_ORDER]);
  });

  it('keeps the attribute defaults of the spec table', () => {
    for (const [name, attrs] of Object.entries(NODE_ATTRS)) {
      const type = must(schema.nodes[name]);
      for (const [key, def] of Object.entries(attrs)) {
        expect({ name, key, value: type.spec.attrs?.[key]?.default }).toEqual({
          name,
          key,
          value: def.default,
        });
      }
    }
  });

  it('refuses an attribute of the wrong type', () => {
    const bad = {
      type: 'doc',
      attrs: { moduleId: 'm', schemaVersion: 1, meta: null },
      content: [
        {
          type: 'list',
          attrs: { id: 'l', ordered: false },
          content: [
            {
              type: 'listItem',
              attrs: { id: 'i' },
              content: [{ type: 'itemText' }],
            },
          ],
        },
      ],
    };
    expect(() => schema.nodeFromJSON(bad).check()).not.toThrow();
    must(bad.content[0]).attrs.ordered = 'yes' as never;
    expect(() => schema.nodeFromJSON(bad).check()).toThrow(/ordered/);
  });
});

describe('the generators', () => {
  it('produce every block, inline, mark and condition type', () => {
    const seen = {
      blocks: new Set<string>(),
      inlines: new Set<string>(),
      marks: new Set<string>(),
      conditions: new Set<string>(),
    };
    const visitCondition = (c: Condition) => {
      seen.conditions.add(c.op);
      if (c.op === 'not') visitCondition(c.of);
      if (c.op === 'all' || c.op === 'any') c.of.forEach(visitCondition);
    };
    const visitInline = (nodes: Inline[] | undefined) =>
      nodes?.forEach((n) => {
        seen.inlines.add(n.type);
        if (n.type === 'text') n.marks?.forEach((m) => seen.marks.add(m.type));
      });
    const visit = (module: Module) => {
      for (const { kind, node } of walk(module.blocks)) {
        if (kind === 'item') {
          visitInline(node.content);
          continue;
        }
        seen.blocks.add(node.type);
        if (node.type === 'paragraph') visitInline(node.content);
        if (node.type === 'section') visitInline(node.title);
        if (node.type === 'safety') visitInline(node.hazard);
        if (node.type === 'faq') visitInline(node.question);
        if (node.type === 'variant') visitCondition(node.when);
      }
    };
    fc.sample(moduleArb, { numRuns: 500, seed: 42 }).forEach(visit);
    expect(sorted(seen.blocks)).toEqual(sorted(generatorTypes.blocks));
    expect(sorted(seen.inlines)).toEqual(sorted(generatorTypes.inlines));
    expect(sorted(seen.marks)).toEqual(sorted(generatorTypes.marks));
    expect(sorted(seen.conditions)).toEqual(sorted(generatorTypes.conditions));
    expect(sorted(generatorTypes.blocks)).toEqual(
      sorted(members(Block, 'type').keys()),
    );
    expect(sorted(generatorTypes.conditions)).toEqual(
      sorted(members(Condition, 'op').keys()),
    );
  });
});

describe('the converted documents', () => {
  it('give every attribute of every node a value other than its default somewhere', () => {
    // A new field the converters or the generator don't carry stays at its default and fails here.
    const seen = new Set<string>();
    const visit = (node: EditorNode) => {
      const defs = NODE_ATTRS[node.type as keyof typeof NODE_ATTRS];
      for (const [key, def] of Object.entries(defs ?? {}))
        if (JSON.stringify(node.attrs?.[key]) !== JSON.stringify(def.default))
          seen.add(`${node.type}.${key}`);
      node.content?.forEach(visit);
    };
    fc.sample(moduleArb, { numRuns: 500, seed: 7 }).forEach((m) =>
      visit(toEditor(m)),
    );
    const expected = Object.entries(NODE_ATTRS).flatMap(([name, attrs]) =>
      Object.keys(attrs).map((key) => `${name}.${key}`),
    );
    // The only schema version there is is the default.
    const missing = expected.filter(
      (key) => !seen.has(key) && key !== 'doc.schemaVersion',
    );
    expect(missing).toEqual([]);
  });
});

describe('dependencies', () => {
  it('has one TipTap version across its packages', () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };
    const versions = new Set(
      Object.entries(manifest.dependencies)
        .filter(([name]) => name.startsWith('@tiptap/'))
        .map(([, version]) => version),
    );
    expect(versions.size).toBe(1);
    expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
