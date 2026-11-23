import type { Block } from '../lib/blocks.js';
import { Module } from '../lib/module.js';

/**
 * Content whose module references multiply (#679, #681), for tests that count the work of a
 * walk over references instead of timing it.
 */

const text = (t: string) => [{ type: 'text' as const, text: t }];

/**
 * A diamond `depth` levels deep: `j0` refers to `a0` and `b0`, both refer to `j1`, and so on;
 * `j<depth>` is the bottom. Each module holds one block of its own (`own`), a paragraph or,
 * with `notices`, a warning; the references sit in a section, so the walk goes into blocks.
 */
export function diamond(
  depth: number,
  options: { notices?: boolean; lang?: string } = {},
): Map<string, Module> {
  const lang = options.lang ?? 'en';
  const own = (id: string): Block =>
    options.notices
      ? {
          type: 'safety',
          id: 'own',
          severity: 'warning',
          hazard: text(id),
          symbols: [],
          blocks: [],
        }
      : { type: 'paragraph', id: 'own', content: text(id) };
  const module = (id: string, refs: string[]) =>
    Module.parse({
      schemaVersion: 1,
      id,
      meta: { title: id, type: 'concept', lang, audience: 'public' },
      blocks: [
        own(id),
        ...(refs.length > 0
          ? [
              {
                type: 'section',
                id: 'refs',
                title: text('refs'),
                blocks: refs.map((ref) => ({
                  type: 'moduleRef',
                  id: `to-${ref}`,
                  module: ref,
                })),
              },
            ]
          : []),
      ],
    });
  const modules = new Map<string, Module>();
  for (let level = 0; level < depth; level++) {
    const next = `j${level + 1}`;
    modules.set(`j${level}`, module(`j${level}`, [`a${level}`, `b${level}`]));
    modules.set(`a${level}`, module(`a${level}`, [next]));
    modules.set(`b${level}`, module(`b${level}`, [next]));
  }
  modules.set(`j${depth}`, module(`j${depth}`, []));
  return modules;
}

/**
 * Counts each `loadModule` call by `lang/id`, and each read of a module's blocks by its ID.
 * `byLang`: per language, the modules there are.
 */
export function counting(byLang: Record<string, Map<string, Module>>) {
  const loads = new Map<string, number>();
  const blockReads = new Map<string, number>();
  const counted = new Map<string, Module>();
  for (const [lang, modules] of Object.entries(byLang)) {
    for (const [id, module] of modules) {
      const copy = { ...module } as Module;
      Object.defineProperty(copy, 'blocks', {
        get() {
          blockReads.set(id, (blockReads.get(id) ?? 0) + 1);
          return module.blocks;
        },
      });
      counted.set(`${lang}/${id}`, copy);
    }
  }
  const loadModule = (id: string, lang: string): Module | undefined => {
    loads.set(`${lang}/${id}`, (loads.get(`${lang}/${id}`) ?? 0) + 1);
    return counted.get(`${lang}/${id}`);
  };
  const most = (counts: Map<string, number>) => Math.max(0, ...counts.values());
  return { loadModule, loads, blockReads, most };
}
