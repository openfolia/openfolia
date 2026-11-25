import type { Block } from './blocks.js';
import type { Manifest, ManifestEntry } from './manifest.js';
import type { Module } from './module.js';
import { ownInlineContent } from './term-links.js';
import { walk } from './walk.js';

/**
 * The nodes that name a module by its ID: a module reference block
 * (`moduleRef`, reuse) and a cross-reference (`xref`, inline, to a module or
 * a block in one). Nothing else in a module's blocks names one.
 */
const NAMING = new Set(['moduleRef', 'xref']);

/**
 * The modules `blocks` cross-reference (`xref`), each once, in document order: at any depth,
 * variant blocks included; module references are not followed.
 */
export function crossReferencedModules(blocks: readonly Block[]): string[] {
  const ids = new Set<string>();
  for (const { node } of walk(blocks)) {
    for (const content of ownInlineContent(node)) {
      for (const inline of content) {
        if (inline.type === 'xref') ids.add(inline.module);
      }
    }
  }
  return [...ids];
}

/**
 * Whether a module's blocks name module `id`: a module reference or a
 * cross-reference anywhere in them, at any depth (sections, lists, tables,
 * notices, variant blocks, titles and link texts).
 */
export function namesModule(module: Module, id: string): boolean {
  return renamedIn(module.blocks, id, id) !== module.blocks;
}

/**
 * The module with every module reference and cross-reference to `from`
 * naming `to` instead, and nothing else changed (block IDs, a
 * cross-reference's block and link text stay). The same object when it
 * names no `from`, so a caller can tell whether anything changed.
 */
export function renameModuleReferences(
  module: Module,
  from: string,
  to: string,
): Module {
  const blocks = renamedIn(module.blocks, from, to, true);
  return blocks === module.blocks ? module : { ...module, blocks };
}

/**
 * Whether a manifest's entries (groups included) name module `id`; for a derived manual (#451),
 * whether its rule does (`exclude`, `front`, `back`), its entries being gathered, not written.
 */
export function manifestNamesModule(manifest: Manifest, id: string): boolean {
  if (manifest.kind === 'derived') {
    const rule = manifest.rule;
    return (
      rule !== undefined &&
      [rule.exclude, rule.front, rule.back].some((ids) => ids.includes(id))
    );
  }
  // An update guide's entries are its steps (#906), and may not be filled in yet (a draft).
  if (manifest.kind === 'update-guide' && manifest.guide)
    return manifest.guide.steps.some((step) => step.module === id);
  return renamedEntries(manifest.entries, id, id, false) !== manifest.entries;
}

/**
 * The manifest with every entry naming module `from` naming `to` instead
 * (its condition kept); for a derived manual, its rule's lists. The same
 * object when nothing names `from`.
 */
export function renameManifestModule(
  manifest: Manifest,
  from: string,
  to: string,
): Manifest {
  if (manifest.kind === 'derived') {
    const rule = manifest.rule;
    if (!rule || !manifestNamesModule(manifest, from)) return manifest;
    const rename = (ids: string[]) => ids.map((id) => (id === from ? to : id));
    return {
      ...manifest,
      rule: {
        ...rule,
        exclude: rename(rule.exclude),
        front: rename(rule.front),
        back: rename(rule.back),
      },
    };
  }
  const guide = manifest.kind === 'update-guide' ? manifest.guide : undefined;
  if (guide) {
    if (!manifestNamesModule(manifest, from)) return manifest;
    return {
      ...manifest,
      guide: {
        ...guide,
        steps: guide.steps.map((step) =>
          step.module === from ? { ...step, module: to } : step,
        ),
      },
      entries: renamedEntries(manifest.entries, from, to, true),
    };
  }
  const entries = renamedEntries(manifest.entries, from, to, true);
  return entries === manifest.entries ? manifest : { ...manifest, entries };
}

/**
 * `value` with every naming node's `module` that is `from` set to `to`; a
 * structural walk, so a block kind added later that holds blocks or inline
 * content is covered without a change here. Unchanged parts keep their
 * identity, and `value` itself is returned when nothing named `from`.
 * Without `rewrite`, the first match returns a fresh copy at once (a
 * cheap "does it name it?").
 */
function renamedIn<T>(value: T, from: string, to: string, rewrite = false): T {
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const next = renamedIn(item, from, to, rewrite);
      if (next !== item) {
        if (!rewrite) return [...value] as T;
        out ??= [...value];
        out[i] = next;
      }
    }
    return (out ?? value) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record['type'] === 'string' &&
    NAMING.has(record['type']) &&
    record['module'] === from
  ) {
    return { ...record, module: to } as T;
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(record)) {
    if (child === null || typeof child !== 'object') continue;
    const next = renamedIn(child, from, to, rewrite);
    if (next !== child) {
      if (!rewrite) return { ...record } as T;
      out ??= { ...record };
      out[key] = next;
    }
  }
  return (out ?? value) as T;
}

function renamedEntries(
  entries: ManifestEntry[],
  from: string,
  to: string,
  rewrite: boolean,
): ManifestEntry[] {
  let out: ManifestEntry[] | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as ManifestEntry;
    let next: ManifestEntry = entry;
    if ('module' in entry) {
      if (entry.module === from) next = { ...entry, module: to };
    } else {
      const inner = renamedEntries(entry.entries, from, to, rewrite);
      if (inner !== entry.entries) next = { ...entry, entries: inner };
    }
    if (next !== entry) {
      if (!rewrite) return [...entries];
      out ??= [...entries];
      out[i] = next;
    }
  }
  return out ?? entries;
}

/**
 * Whether a module's deprecation names module `id` as its replacement
 * (`meta.deprecated.replacedBy`, #360). Only a module's source-language
 * file holds its deprecation; which file that is, is the caller's to say.
 */
export function replacementNamesModule(module: Module, id: string): boolean {
  return module.meta.deprecated?.replacedBy === id;
}

/**
 * The module with a deprecation replaced by module `from` replaced by `to`
 * instead (its reason kept). The same object when its replacement is not
 * `from`.
 */
export function renameReplacement(
  module: Module,
  from: string,
  to: string,
): Module {
  const deprecated = module.meta.deprecated;
  if (deprecated?.replacedBy !== from) return module;
  return {
    ...module,
    meta: { ...module.meta, deprecated: { ...deprecated, replacedBy: to } },
  };
}
