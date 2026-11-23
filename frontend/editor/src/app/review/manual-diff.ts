import { sameText } from '@openfolia/content-model/core';

import type { Schema } from '../api';
import { comparedTitle } from './meta-diff';
import { conditionText } from './review-diff';
import { diffTree, type DiffNode, type TreeAdapter } from './tree-diff';

export type ManifestEntry = Schema<'ManifestEntry'>;

/**
 * An entry of a manual's outline with the key the diff matches it by: a module by its ID (a
 * second use of the same module by its ID and count), a chapter by its title, or, renamed, by
 * the modules it holds.
 */
export interface EntryNode {
  readonly key: string;
  readonly entry: ManifestEntry;
  readonly children: readonly EntryNode[];
}

export type EntryDiff = DiffNode<EntryNode>;

const isChapter = (
  e: ManifestEntry,
): e is Extract<ManifestEntry, { entries: unknown }> => 'entries' in e;

interface Chapter {
  readonly entry: Extract<ManifestEntry, { entries: unknown }>;
  readonly modules: ReadonlySet<string>;
  key?: string;
}

/** The chapters of a side, in reading order, with the modules each holds (at any depth). */
function chaptersOf(entries: readonly ManifestEntry[]): Chapter[] {
  const out: Chapter[] = [];
  const modulesIn = (list: readonly ManifestEntry[]): string[] =>
    list.flatMap((e) => (isChapter(e) ? modulesIn(e.entries) : [e.module]));
  const walk = (list: readonly ManifestEntry[]) => {
    for (const e of list) {
      if (!isChapter(e)) continue;
      out.push({ entry: e, modules: new Set(modulesIn(e.entries)) });
      walk(e.entries);
    }
  };
  walk(entries);
  return out;
}

/** Gives each chapter its key: the same title on both sides, else the most modules shared. */
function matchChapters(before: Chapter[], after: Chapter[]): void {
  let next = 0;
  for (const a of after) {
    const b = before.find(
      (c) => !c.key && sameText(c.entry.title, a.entry.title),
    );
    if (b) b.key = a.key = `chapter:${next++}`;
  }
  for (const a of after) {
    if (a.key) continue;
    let best: Chapter | undefined;
    let shared = 0;
    for (const b of before) {
      if (b.key) continue;
      const n = [...a.modules].filter((m) => b.modules.has(m)).length;
      if (n > shared) {
        best = b;
        shared = n;
      }
    }
    if (best) best.key = a.key = `chapter:${next++}`;
  }
  for (const c of [...before, ...after]) c.key ??= `chapter:${next++}`;
}

function nodesOf(
  entries: readonly ManifestEntry[],
  chapters: readonly Chapter[],
): EntryNode[] {
  const uses = new Map<string, number>();
  let chapter = 0;
  const walk = (list: readonly ManifestEntry[]): EntryNode[] =>
    list.map((entry) => {
      if (isChapter(entry)) {
        const key = (chapters[chapter++] as Chapter).key as string;
        return { key, entry, children: walk(entry.entries) };
      }
      const n = (uses.get(entry.module) ?? 0) + 1;
      uses.set(entry.module, n);
      const key =
        n === 1 ? `module:${entry.module}` : `module:${entry.module}:${n}`;
      return { key, entry, children: [] };
    });
  return walk(entries);
}

const ENTRY_ADAPTER: TreeAdapter<EntryNode> = {
  id: (n) => n.key,
  children: (n) => n.children,
  same: (a, b) =>
    sameText(
      isChapter(a.entry) ? a.entry.title : '',
      isChapter(b.entry) ? b.entry.title : '',
    ) &&
    JSON.stringify(a.entry.when ?? null) ===
      JSON.stringify(b.entry.when ?? null),
  texts: (n) => ({
    // A title per language (#731) compares as `en: …, de: …`, so a change in one shows.
    text: isChapter(n.entry) ? comparedTitle(n.entry.title) : '',
    when: n.entry.when ? conditionText(n.entry.when) : '',
  }),
};

/** A manual's outline compared: entries added, removed, moved (from which chapter), renamed. */
export function diffEntries(
  before: readonly ManifestEntry[],
  after: readonly ManifestEntry[],
): EntryDiff[] {
  const b = chaptersOf(before);
  const a = chaptersOf(after);
  matchChapters(b, a);
  return diffTree(nodesOf(before, b), nodesOf(after, a), ENTRY_ADAPTER);
}

/** The module an entry names; null for a chapter. */
export const entryModule = (n: EntryNode): string | null =>
  isChapter(n.entry) ? null : n.entry.module;

/** The title of the chapter `key` on a side; null for the top level or no such chapter. */
export function chapterTitle(
  nodes: readonly EntryDiff[],
  key: string | null,
  side: 'before' | 'after',
): string | null {
  if (key === null) return null;
  for (const n of nodes) {
    const e = n[side];
    if (n.id === key && e && isChapter(e.entry))
      return comparedTitle(e.entry.title);
    const found = chapterTitle(n.children, key, side);
    if (found !== null) return found;
  }
  return null;
}
