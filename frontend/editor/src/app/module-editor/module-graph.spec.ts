import type { Item } from '../api';
import {
  cyclePath,
  graphOf,
  includedBy,
  reachingModules,
  refsOf,
} from './module-graph';

type ModuleItem = Item<'/modules'>;

const ref = (id: string, module: string) => ({
  type: 'moduleRef' as const,
  id,
  module,
});

function item(
  id: string,
  refs: readonly string[],
  lang = 'en',
  title = id,
): ModuleItem {
  return {
    type: 'Module',
    id: `${lang}/${id}`,
    attributes: {
      moduleId: id,
      lang,
      schemaVersion: 1,
      title,
      moduleType: 'concept',
      facets: {},
      // References nested in a section and a variant count as well as top-level ones.
      blocks: [
        {
          type: 'section',
          id: 's',
          title: [{ type: 'text', text: 'Section' }],
          blocks: refs.map((r, i) =>
            i % 2 === 0
              ? ref(`r${i}`, r)
              : {
                  type: 'variant',
                  id: `v${i}`,
                  when: { op: 'in', attr: 'edition', values: ['a'] },
                  blocks: [ref(`r${i}`, r)],
                },
          ),
        },
      ],
    },
    meta: { issues: [], status: { release: null, main: null } },
  } as unknown as ModuleItem;
}

describe('module graph', () => {
  it('finds every module reference, nested ones too, each once', () => {
    const { attributes } = item('a', ['b', 'c', 'b']);
    const blocks = 'blocks' in attributes ? attributes.blocks : [];
    expect(refsOf(blocks)).toEqual(['b', 'c']);
  });

  it('reads a module in the document language, else in the source language', () => {
    const graph = graphOf(
      [item('a', ['b'], 'en'), item('a', ['c'], 'de'), item('d', ['a'], 'en')],
      'de',
      'en',
    );
    expect(graph.modules.get('a')?.refs).toEqual(['c']);
    expect(graph.modules.get('a')?.lang).toBe('de');
    expect(graph.modules.get('d')?.lang).toBe('en');
  });

  it('leaves out a module file that cannot be read', () => {
    const broken = {
      type: 'Module',
      id: 'en/broken',
      attributes: { moduleId: 'broken', lang: 'en' },
      meta: { error: 'unreadable' },
    } as unknown as ModuleItem;
    expect(graphOf([broken], 'en', 'en').modules.has('broken')).toBe(false);
  });

  it('names the way back: a module including the edited one, directly or through others', async () => {
    // edited ← b ← c ← d; e stands apart.
    const graph = graphOf(
      [
        item('edited', ['x']),
        item('b', ['edited']),
        item('c', ['b']),
        item('d', ['c', 'e']),
        item('e', []),
      ],
      'en',
      'en',
    );
    const refs = (id: string) => graph.modules.get(id)?.refs ?? null;
    expect(await cyclePath('edited', 'edited', refs)).toEqual(['edited']);
    expect(await cyclePath('b', 'edited', refs)).toEqual(['b', 'edited']);
    expect(await cyclePath('d', 'edited', refs)).toEqual([
      'd',
      'c',
      'b',
      'edited',
    ]);
    expect(await cyclePath('e', 'edited', refs)).toBeNull();
    // A module the edited one includes is no way back by itself.
    expect(await cyclePath('x', 'edited', refs)).toBeNull();
    expect([...reachingModules(graph, 'edited')].sort()).toEqual([
      'b',
      'c',
      'd',
      'edited',
    ]);
  });

  it('ends on cycles that do not lead back, and reads missing modules through the callback', async () => {
    const reads: string[] = [];
    const known: Record<string, string[]> = {
      a: ['b'],
      b: ['a', 'far'],
    };
    const path = await cyclePath('a', 'edited', async (id) => {
      reads.push(id);
      if (id === 'far') return ['edited'];
      return known[id] ?? null;
    });
    expect(path).toEqual(['a', 'b', 'far', 'edited']);
    expect(reads).toEqual(['a', 'b', 'far']);
  });

  it('reads nothing more once aborted', async () => {
    const abort = new AbortController();
    const reads: string[] = [];
    const path = await cyclePath(
      'a',
      'edited',
      async (id) => {
        reads.push(id);
        abort.abort();
        return id === 'a' ? ['b'] : ['edited'];
      },
      undefined,
      abort.signal,
    );
    expect(path).toBeNull();
    expect(reads).toEqual(['a']);
  });

  it('stops after the limit', async () => {
    const chain = (id: string) => [String(Number(id) + 1)];
    expect(await cyclePath('0', 'edited', chain, 50)).toBeNull();
  });

  it('lists the modules that include one directly, by title', () => {
    const graph = graphOf(
      [
        item('shared', []),
        item('z', ['shared'], 'en', 'Zeta'),
        item('a', ['shared'], 'en', 'Alpha'),
        item('n', ['z']),
      ],
      'en',
      'en',
    );
    expect(includedBy(graph, 'shared').map((m) => m.title)).toEqual([
      'Alpha',
      'Zeta',
    ]);
  });
});
