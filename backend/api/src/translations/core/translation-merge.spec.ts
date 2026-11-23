import {
  Module,
  translatableUnits,
  walk,
  type Block,
  type Condition,
  type TranslatablePart,
} from '@openfolia/content-model';
import fc from 'fast-check';
import { mergeTranslation } from './translation-merge.js';

const hash = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const when = (value: string): Condition => ({
  op: 'in',
  attr: 'model',
  values: [value],
});

/** A tree of blocks with IDs given later: paragraphs, images, sections and variant blocks. */
type Shape =
  | { kind: 'paragraph'; text: string }
  | { kind: 'image'; asset: number; alt: string }
  | { kind: 'section'; title: string; children: Shape[] }
  | { kind: 'variant'; value: string; children: Shape[] };

const text = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,11}[A-Za-z]$/);
/** Blocks but sections: paragraphs, images, variant blocks of them. */
const plain: fc.Arbitrary<Shape> = fc.letrec<{ plain: Shape }>((tie) => ({
  plain: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ kind: fc.constant('paragraph' as const), text }),
    fc.record({
      kind: fc.constant('image' as const),
      asset: fc.nat(20),
      alt: text,
    }),
    fc.record({
      kind: fc.constant('variant' as const),
      value: fc.constantFrom('a', 'b', 'c'),
      children: fc.array(tie('plain'), { minLength: 1, maxLength: 3 }),
    }),
  ),
})).plain;
/** A level of a module: blocks, then sections (as the model wants them), at most `depth` deep. */
const level = (depth: number): fc.Arbitrary<Shape[]> =>
  fc
    .tuple(
      fc.array(plain, { maxLength: 3 }),
      depth === 0
        ? fc.constant([])
        : fc.array(
            fc.record({
              kind: fc.constant('section' as const),
              title: text,
              children: level(depth - 1),
            }),
            { maxLength: 2 },
          ),
    )
    .map(([blocks, sections]) => [...blocks, ...sections]);

function build(shapes: Shape[], next: { n: number }): Block[] {
  return shapes.map((s): Block => {
    const id = `b${++next.n}`;
    switch (s.kind) {
      case 'paragraph':
        return {
          type: 'paragraph',
          id,
          content: [{ type: 'text', text: s.text }],
        };
      case 'image':
        return { type: 'image', id, asset: hash(s.asset), alt: s.alt };
      case 'section':
        return {
          type: 'section',
          id,
          title: [{ type: 'text', text: s.title }],
          blocks: build(s.children, next),
        };
      case 'variant':
        return {
          type: 'variant',
          id,
          when: when(s.value),
          blocks: build(s.children, next),
        };
    }
  });
}

const sourceOf = (shapes: Shape[]): Module =>
  Module.parse({
    schemaVersion: 1,
    id: 'guide',
    meta: { title: 'Guide', type: 'concept', lang: 'en', facets: {} },
    blocks: build(shapes, { n: 0 }),
  });

/**
 * A translation of `source` as one might be: some blocks dropped (with
 * what they hold, and a variant block left empty), every image of its own file, every variant of its own
 * condition, the text in another language.
 */
function targetOf(source: Module, dropped: ReadonlySet<string>): Module {
  const copy = (blocks: Block[]): Block[] =>
    blocks
      .filter((b) => !dropped.has(b.id))
      .map((b): Block => {
        switch (b.type) {
          case 'paragraph':
            return { ...b, content: [{ type: 'text', text: 'DE text' }] };
          case 'image':
            return {
              ...b,
              asset: hash(1000 + Number(b.id.slice(1))),
              alt: 'DE alt',
            };
          case 'section':
            return { ...b, blocks: copy(b.blocks) };
          case 'variant':
            return { ...b, when: when(`de-${b.id}`), blocks: copy(b.blocks) };
          default:
            return b;
        }
      })
      // A variant block left empty goes too (one is never empty).
      .filter((b) => b.type !== 'variant' || b.blocks.length > 0);
  return {
    ...source,
    meta: { ...source.meta, lang: 'de' },
    blocks: copy(source.blocks),
  };
}

const nodes = (m: Module) => [...walk(m.blocks)].map(({ node }) => node);
const byId = (m: Module) => new Map(nodes(m).map((n) => [n.id, n]));

const scenario = fc
  .array(fc.constant(0), { maxLength: 0 })
  .chain(() => level(2))
  .filter((shapes) => shapes.length > 0)
  .map(sourceOf)
  .chain((source) => {
    const ids = nodes(source).map((n) => n.id);
    const units = translatableUnits(source);
    return fc.record({
      source: fc.constant(source),
      dropped: fc.subarray(ids),
      noTarget: fc.boolean(),
      translated: fc.subarray(units),
      text,
    });
  });

describe('mergeTranslation', () => {
  it('never changes an image’s file, a condition or an ID of the target, and adds only the source’s blocks', () => {
    fc.assert(
      fc.property(
        scenario,
        ({ source, dropped, noTarget, translated, text: word }) => {
          const target = noTarget
            ? undefined
            : targetOf(source, new Set(dropped));
          const units = new Map<string, TranslatablePart[]>(
            translated.map((u) => [
              u.blockId,
              u.parts.map((p) => ({
                field: p.field,
                content: [{ type: 'text', text: word }],
              })),
            ]),
          );
          const merged = mergeTranslation(target, source, 'de', units);
          // Still valid content, in the target's language, every ID once.
          expect(() => Module.parse(merged)).not.toThrow();
          expect(merged.meta.lang).toBe('de');
          const ids = nodes(merged).map((n) => n.id);
          expect(new Set(ids).size).toBe(ids.length);

          const inSource = byId(source);
          const inTarget = target ? byId(target) : new Map();
          const inMerged = byId(merged);
          // The target's blocks all stay, with their files and conditions.
          for (const [id, node] of inTarget) {
            const now = inMerged.get(id);
            expect(now?.id).toBe(id);
            if ('type' in node && node.type === 'image') {
              expect(now).toMatchObject({ asset: node.asset });
            }
            if ('type' in node && node.type === 'variant') {
              expect(now).toMatchObject({ when: node.when });
            }
          }
          // What is added is the source's, with the source's file and condition.
          for (const [id, node] of inMerged) {
            if (inTarget.has(id)) continue;
            const original = inSource.get(id);
            expect(original).toBeDefined();
            if ('type' in node && node.type === 'image') {
              expect(node.asset).toBe((original as { asset: string }).asset);
            }
            if ('type' in node && node.type === 'variant') {
              expect(node.when).toEqual((original as { when: Condition }).when);
            }
          }
          // Every translated unit landed (its block is in the merge, with the text).
          for (const id of units.keys()) {
            const node = inMerged.get(id);
            expect(node).toBeDefined();
            if (node && 'type' in node && node.type === 'paragraph') {
              expect(node.content).toEqual([{ type: 'text', text: word }]);
            }
            if (node && 'type' in node && node.type === 'image') {
              expect(node.alt).toBe(word);
            }
          }
          // The target itself is never changed in place.
          if (target)
            expect(target).toEqual(targetOf(source, new Set(dropped)));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('places a missing block after its nearest preceding sibling the target has', () => {
    const source = sourceOf([
      { kind: 'paragraph', text: 'One' },
      { kind: 'paragraph', text: 'Two' },
      {
        kind: 'section',
        title: 'Sec',
        children: [{ kind: 'paragraph', text: 'Inner' }],
      },
    ]);
    const target = targetOf(source, new Set(['b2', 'b4']));
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([
        [
          'b2',
          [{ field: 'content', content: [{ type: 'text', text: 'Zwei' }] }],
        ],
        [
          'b4',
          [{ field: 'content', content: [{ type: 'text', text: 'Innen' }] }],
        ],
      ]),
    );
    expect(merged.blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(merged.blocks[1]).toEqual({
      type: 'paragraph',
      id: 'b2',
      content: [{ type: 'text', text: 'Zwei' }],
    });
    expect((merged.blocks[2] as { blocks: Block[] }).blocks).toEqual([
      {
        type: 'paragraph',
        id: 'b4',
        content: [{ type: 'text', text: 'Innen' }],
      },
    ]);
  });

  it('leaves out a variant block it would add empty, its content living elsewhere in the target', () => {
    const source = sourceOf([
      { kind: 'paragraph', text: 'Top' },
      {
        kind: 'section',
        title: 'Sec',
        children: [
          {
            kind: 'variant',
            value: 'a',
            children: [{ kind: 'paragraph', text: 'Only' }],
          },
          { kind: 'paragraph', text: 'After' },
        ],
      },
    ]);
    // b1 Top, b2 section, b3 variant, b4 Only, b5 After. The target moved b4 up, lacks the section.
    const target: Module = {
      ...source,
      meta: { ...source.meta, lang: 'de' },
      blocks: [
        source.blocks[0] as Block,
        {
          type: 'paragraph',
          id: 'b4',
          content: [{ type: 'text', text: 'Nur' }],
        },
      ],
    };
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([
        [
          'b5',
          [{ field: 'content', content: [{ type: 'text', text: 'Danach' }] }],
        ],
      ]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    // The section after every other block of its level.
    expect(merged.blocks.map((b) => b.id)).toEqual(['b1', 'b4', 'b2']);
    expect(
      (merged.blocks[2] as { blocks: Block[] }).blocks.map((b) => b.id),
    ).toEqual(['b5']);
  });

  it('translates an FAQ entry’s question and the blocks of its answer, with and without a target', () => {
    const t = (text: string) => [{ type: 'text' as const, text }];
    const source: Module = {
      schemaVersion: 1,
      id: 'questions',
      meta: { title: 'Questions', type: 'concept', lang: 'en', facets: {} },
      blocks: [
        {
          type: 'faq',
          id: 'ask',
          question: t('Why?'),
          blocks: [
            { type: 'paragraph', id: 'answer', content: t('Because.') },
            { type: 'paragraph', id: 'more', content: t('And more.') },
          ],
        },
      ],
    };
    const units = new Map<string, TranslatablePart[]>([
      ['ask', [{ field: 'question', content: t('Warum?') }]],
      ['answer', [{ field: 'content', content: t('Darum.') }]],
      ['more', [{ field: 'content', content: t('Und mehr.') }]],
    ]);
    expect(
      translatableUnits(source).map((u) => [u.blockId, u.parts[0]?.field]),
    ).toEqual([
      ['ask', 'question'],
      ['answer', 'content'],
      ['more', 'content'],
    ]);
    const want = {
      type: 'faq',
      id: 'ask',
      question: t('Warum?'),
      blocks: [
        { type: 'paragraph', id: 'answer', content: t('Darum.') },
        { type: 'paragraph', id: 'more', content: t('Und mehr.') },
      ],
    };
    const fresh = mergeTranslation(undefined, source, 'de', units);
    expect(() => Module.parse(fresh)).not.toThrow();
    expect(fresh.blocks).toEqual([want]);
    // A target that has the entry but not its second answer block.
    const target: Module = {
      ...source,
      meta: { ...source.meta, lang: 'de' },
      blocks: [
        {
          type: 'faq',
          id: 'ask',
          question: t('Wieso?'),
          blocks: [{ type: 'paragraph', id: 'answer', content: t('Alt.') }],
        },
      ],
    };
    expect(mergeTranslation(target, source, 'de', units).blocks).toEqual([
      want,
    ]);
  });

  it('keeps the term links of the translated text, never the target’s old ones (#245)', () => {
    const linked = (text: string, termId: string) => ({
      type: 'text' as const,
      text,
      marks: [{ type: 'term' as const, termId }],
    });
    const source: Module = {
      schemaVersion: 1,
      id: 'charging',
      meta: { title: 'Charging', type: 'concept', lang: 'en', facets: {} },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [
            { type: 'text', text: 'Use the ' },
            linked('charger', 'charger'),
          ],
        },
      ],
    };
    const target: Module = {
      ...source,
      meta: { ...source.meta, lang: 'de' },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [linked('Lader', 'loader')],
        },
      ],
    };
    const content = [
      { type: 'text' as const, text: 'Das ' },
      linked('Ladegerät', 'charger'),
      { type: 'text' as const, text: ' benutzen.' },
    ];
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([['p', [{ field: 'content', content }]]]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    expect(merged.blocks).toEqual([{ type: 'paragraph', id: 'p', content }]);
  });
});

describe('mergeTranslation of callout legends (#548)', () => {
  const t = (value: string) => [{ type: 'text' as const, text: value }];
  const legend = (value: string): TranslatablePart[] => [
    { field: 'legend', content: t(value) },
  ];
  const source: Module = {
    schemaVersion: 1,
    id: 'parts',
    meta: { title: 'Parts', type: 'concept', lang: 'en', facets: {} },
    blocks: [
      { type: 'paragraph', id: 'intro', content: t('Intro') },
      {
        type: 'image',
        id: 'photo',
        asset: hash(1),
        alt: 'Charger',
        callouts: [
          { id: 'lid', anchor: { x: 0.1, y: 0.1 }, legend: t('Lid') },
          {
            id: 'seal',
            anchor: { x: 0.5, y: 0.5 },
            legend: t('Seal'),
            when: when('large'),
          },
          { id: 'plug', anchor: { x: 0.9, y: 0.9 }, legend: t('Plug') },
        ],
      },
    ],
  };
  const de = (blocks: Block[]): Module => ({
    ...source,
    meta: { ...source.meta, lang: 'de' },
    blocks,
  });

  it('writes a legend into the target’s callout, nothing else of it', () => {
    const target = de([
      { type: 'paragraph', id: 'intro', content: t('Einleitung') },
      {
        type: 'image',
        id: 'photo',
        asset: hash(2),
        alt: 'Ladegerät',
        callouts: [
          {
            id: 'lid',
            anchor: { x: 0.2, y: 0.3 },
            label: { x: 0.4, y: 0.3 },
            legend: t('Deckel (alt)'),
            style: 'square',
          },
          { id: 'seal', anchor: { x: 0.5, y: 0.5 }, legend: t('Dichtung') },
          { id: 'plug', anchor: { x: 0.9, y: 0.9 }, legend: t('Stecker') },
        ],
      },
    ]);
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([['lid', legend('Deckel')]]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    const image = merged.blocks[1];
    expect(image).toMatchObject({ asset: hash(2), alt: 'Ladegerät' });
    expect(image?.type === 'image' && image.callouts?.[0]).toEqual({
      id: 'lid',
      anchor: { x: 0.2, y: 0.3 },
      label: { x: 0.4, y: 0.3 },
      legend: t('Deckel'),
      style: 'square',
    });
  });

  it('adds a callout the target lacks after the one before it in the source', () => {
    const target = de([
      {
        type: 'image',
        id: 'photo',
        asset: hash(1),
        alt: 'Ladegerät',
        callouts: [
          { id: 'lid', anchor: { x: 0.1, y: 0.1 }, legend: t('Deckel') },
          { id: 'plug', anchor: { x: 0.9, y: 0.9 }, legend: t('Stecker') },
        ],
      },
    ]);
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([['seal', legend('Dichtung')]]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    const image = merged.blocks[0];
    expect(
      image?.type === 'image' &&
        image.callouts?.map((c) => [c.id, c.legend, c.when]),
    ).toEqual([
      ['lid', t('Deckel'), undefined],
      ['seal', t('Dichtung'), when('large')],
      ['plug', t('Stecker'), undefined],
    ]);
  });

  it('places the image from the source when the target lacks it, its other legends untranslated', () => {
    const target = de([
      { type: 'paragraph', id: 'intro', content: t('Einleitung') },
    ]);
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([
        ['photo', [{ field: 'alt', content: t('Ladegerät') }]],
        ['plug', legend('Stecker')],
      ]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    expect(merged.blocks.map((b) => b.id)).toEqual(['intro', 'photo']);
    const image = merged.blocks[1];
    expect(image).toMatchObject({ alt: 'Ladegerät' });
    expect(
      image?.type === 'image' && image.callouts?.map((c) => c.legend),
    ).toEqual([t('Lid'), t('Seal'), t('Stecker')]);
  });

  it('leaves out a unit for a callout the source no longer has', () => {
    const target = de(structuredClone(source.blocks));
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([['gone', legend('Weg')]]),
    );
    expect(merged.blocks).toEqual(source.blocks);
  });

  it('never copies a callout the target already has on another image', () => {
    const target = de([
      {
        type: 'image',
        id: 'other',
        asset: hash(3),
        alt: 'Andere',
        callouts: [
          { id: 'lid', anchor: { x: 0.1, y: 0.1 }, legend: t('Deckel') },
        ],
      },
    ]);
    const merged = mergeTranslation(
      target,
      source,
      'de',
      new Map([['plug', legend('Stecker')]]),
    );
    expect(() => Module.parse(merged)).not.toThrow();
    const ids = merged.blocks.flatMap((b) =>
      b.type === 'image' ? (b.callouts ?? []).map((c) => c.id) : [],
    );
    expect(ids.sort()).toEqual(['lid', 'plug', 'seal']);
  });

  it('leaves a legend out rather than clash with a target block or overfill the image', () => {
    const clash = de([
      { type: 'paragraph', id: 'seal', content: t('Absatz') },
      {
        type: 'image',
        id: 'photo',
        asset: hash(1),
        alt: 'Ladegerät',
        callouts: [
          { id: 'lid', anchor: { x: 0.1, y: 0.1 }, legend: t('Deckel') },
        ],
      },
    ]);
    const merged = mergeTranslation(
      clash,
      source,
      'de',
      new Map([['seal', legend('Dichtung')]]),
    );
    expect(merged).toEqual(clash);
    const full = de([
      {
        type: 'image',
        id: 'photo',
        asset: hash(1),
        alt: 'Ladegerät',
        callouts: Array.from({ length: 100 }, (_, i) => ({
          id: `x${i}`,
          anchor: { x: 0.1, y: 0.1 },
          legend: t(`${i}`),
        })),
      },
    ]);
    expect(
      mergeTranslation(full, source, 'de', new Map([['plug', legend('S')]])),
    ).toEqual(full);
  });

  it('agrees with translatableUnits: every callout legend unit is merged', () => {
    const units = translatableUnits(source).filter((u) => u.kind === 'callout');
    const merged = mergeTranslation(
      undefined,
      source,
      'de',
      new Map(units.map((u) => [u.blockId, legend(`DE ${u.blockId}`)])),
    );
    const image = merged.blocks[1];
    expect(
      image?.type === 'image' && image.callouts?.map((c) => c.legend),
    ).toEqual([t('DE lid'), t('DE seal'), t('DE plug')]);
  });
});
