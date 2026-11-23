import {
  type LocalizedText,
  sourceTextOf,
} from '@openfolia/content-model/core';
import {
  isValidTree,
  subtreeEnd,
  type ModuleTreeItem,
} from '@openfolia/ui/module-tree';

import type { Schema } from '../api';

export type ManifestEntry = Schema<'ManifestEntry'>;
type Condition = Schema<'Condition'>;

/**
 * One row of a manual's outline: a module or a chapter (a manifest group). A chapter always keeps
 * a row, a module holds none (`nesting`), so every outline the tree allows is a manifest the API
 * stores. `id` names the row for this view (and the URL): a module's ID (`<id>~2` for its
 * second place in the manual), or `chapter-<n>`; it stays while the page is open.
 */
export interface OutlineRow extends ModuleTreeItem {
  readonly kind: 'module' | 'chapter';
  /** The module's ID; for a chapter, its title in the source language. */
  readonly ref: string;
  /** A chapter's title as the manifest stores it: one text, or one per language (#731). */
  readonly heading?: LocalizedText;
  /** The manifest entry's condition, kept as it is. */
  readonly when?: Condition | undefined;
}

/** A chapter title's text in the source language (else its first version). */
export function headingText(heading: LocalizedText, source?: string): string {
  if (typeof heading === 'string') return heading;
  return (
    (source !== undefined ? sourceTextOf(heading, source) : undefined) ??
    Object.values(heading)[0] ??
    ''
  );
}

/**
 * The rows of `entries`, in reading order; `title` gives a module's title (its ID when unknown).
 * A chapter's row shows its title in the source language (`source`; the page shows it in the
 * interface language).
 */
export function toRows(
  entries: readonly ManifestEntry[],
  title: (moduleId: string) => string | undefined = () => undefined,
  source?: string,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const seen = new Map<string, number>();
  let chapters = 0;
  const walk = (list: readonly ManifestEntry[], level: number) => {
    for (const entry of list) {
      if ('module' in entry) {
        const count = (seen.get(entry.module) ?? 0) + 1;
        seen.set(entry.module, count);
        rows.push({
          id: count === 1 ? entry.module : `${entry.module}~${count}`,
          kind: 'module',
          ref: entry.module,
          title: title(entry.module) ?? entry.module,
          level,
          nesting: 'none',
          ...(entry.when ? { when: entry.when } : {}),
        });
      } else {
        const text = headingText(entry.title, source);
        rows.push({
          id: `chapter-${++chapters}`,
          kind: 'chapter',
          ref: text,
          heading: entry.title,
          title: text,
          level,
          nesting: 'required',
          ...(entry.when ? { when: entry.when } : {}),
        });
        walk(entry.entries, level + 1);
      }
    }
  };
  walk(entries, 0);
  return rows;
}

/** The manifest entries of `rows` (a valid outline: see `isValidTree`). */
export function toEntries(rows: readonly OutlineRow[]): ManifestEntry[] {
  let index = 0;
  const read = (level: number): ManifestEntry[] => {
    const list: ManifestEntry[] = [];
    while (index < rows.length && (rows[index]?.level ?? 0) >= level) {
      const row = rows[index++] as OutlineRow;
      const when = row.when ? { when: row.when } : {};
      if (row.kind === 'module') {
        list.push({ module: row.ref, ...when });
      } else {
        list.push({
          title: row.heading ?? row.ref,
          ...when,
          entries: read(row.level + 1),
        });
      }
    }
    return list;
  };
  return read(0);
}

/** A row ID no row has: `<base>`, else `<base>~2`, `~3`, … */
function freshId(rows: readonly OutlineRow[], base: string): string {
  const ids = new Set(rows.map((row) => row.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!ids.has(`${base}~${n}`)) return `${base}~${n}`;
  }
}

/** A new chapter row's ID. */
function chapterId(rows: readonly OutlineRow[]): string {
  const numbers = rows
    .filter((row) => row.kind === 'chapter')
    .map((row) => Number(/^chapter-(\d+)$/.exec(row.id)?.[1] ?? 0));
  return `chapter-${Math.max(0, ...numbers) + 1}`;
}

/**
 * Adds a module after the row `after` and the rows under it, at its level (into the chapter
 * when it is one with nothing after it in there); at the end when there is no such row.
 * Gives the new rows and the new row's ID.
 */
export function addModule(
  rows: readonly OutlineRow[],
  module: { readonly id: string; readonly title: string },
  after: string | null,
): { rows: OutlineRow[]; id: string } {
  const id = freshId(rows, module.id);
  const index = rows.findIndex((row) => row.id === after);
  const at = index < 0 ? rows.length : subtreeEnd(rows, index);
  const level = index < 0 ? 0 : (rows[index]?.level ?? 0);
  const row: OutlineRow = {
    id,
    kind: 'module',
    ref: module.id,
    title: module.title,
    level,
    nesting: 'none',
  };
  return { rows: [...rows.slice(0, at), row, ...rows.slice(at)], id };
}

/**
 * Puts the row `id` (with the rows under it) into a new chapter titled `title` (one text, or one
 * per language: `source` is the source language), in its place.
 */
export function wrapInChapter(
  rows: readonly OutlineRow[],
  id: string,
  title: LocalizedText,
  source?: string,
): { rows: OutlineRow[]; id: string } | null {
  const index = rows.findIndex((row) => row.id === id);
  const row = rows[index];
  if (!row) return null;
  const end = subtreeEnd(rows, index);
  const chapter: OutlineRow = {
    id: chapterId(rows),
    kind: 'chapter',
    ref: headingText(title, source),
    heading: title,
    title: headingText(title, source),
    level: row.level,
    nesting: 'required',
  };
  return {
    rows: [
      ...rows.slice(0, index),
      chapter,
      ...rows
        .slice(index, end)
        .map((r): OutlineRow => ({ ...r, level: r.level + 1 })),
      ...rows.slice(end),
    ],
    id: chapter.id,
  };
}

/** Renames the chapter `id` (`title`: one text, or one per language; `source`: the source language). */
export function renameChapter(
  rows: readonly OutlineRow[],
  id: string,
  title: LocalizedText,
  source?: string,
): OutlineRow[] {
  const text = headingText(title, source);
  return rows.map((row) =>
    row.id === id && row.kind === 'chapter'
      ? { ...row, ref: text, heading: title, title: text }
      : row,
  );
}

/** What `removeRow` took out, for its undo. */
export interface Removed {
  readonly index: number;
  readonly rows: readonly OutlineRow[];
}

/**
 * Takes out the row `id` with the rows under it, and the chapters that it leaves empty (a
 * chapter keeps a row). Gives the new rows and what was removed.
 */
export function removeRow(
  rows: readonly OutlineRow[],
  id: string,
): { rows: OutlineRow[]; removed: Removed } | null {
  let index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  let end = subtreeEnd(rows, index);
  // Widen to the chapter around it while that chapter would be left empty.
  for (;;) {
    const level = rows[index]?.level ?? 0;
    let parent = index - 1;
    while (parent >= 0 && (rows[parent]?.level ?? 0) >= level) parent--;
    if (parent < 0 || parent !== index - 1) break;
    if (subtreeEnd(rows, parent) !== end) break;
    index = parent;
  }
  end = subtreeEnd(rows, index);
  return {
    rows: [...rows.slice(0, index), ...rows.slice(end)],
    removed: { index, rows: rows.slice(index, end) },
  };
}

/**
 * Puts removed rows back: where they were when that still makes a valid outline that leaves
 * every other row where it is, else at the end, at the top level. IDs taken meanwhile are not
 * reused (the rows get fresh ones).
 */
export function restoreRows(
  rows: readonly OutlineRow[],
  removed: Removed,
): OutlineRow[] {
  const taken = new Set(rows.map((row) => row.id));
  let copy = [...rows];
  const back = removed.rows.map((row): OutlineRow => {
    if (!taken.has(row.id)) return row;
    const id =
      row.kind === 'chapter' ? chapterId(copy) : freshId(copy, row.ref);
    const fresh = { ...row, id };
    copy = [...copy, fresh];
    return fresh;
  });
  const index = Math.min(removed.index, rows.length);
  const inPlace = [...rows.slice(0, index), ...back, ...rows.slice(index)];
  if (isValidTree(inPlace) && levelsFit(inPlace)) return inPlace;
  const top = back[0]?.level ?? 0;
  return [
    ...rows,
    ...back.map((row): OutlineRow => ({ ...row, level: row.level - top })),
  ];
}

/** No row is more than one level below the row before it, and the first is at the top. */
function levelsFit(rows: readonly OutlineRow[]): boolean {
  return rows.every((row, i) =>
    i === 0 ? row.level === 0 : row.level <= (rows[i - 1]?.level ?? 0) + 1,
  );
}

/** Module rows count: how many modules the outline holds (each place counted). */
export function moduleCount(rows: readonly OutlineRow[]): number {
  return rows.filter((row) => row.kind === 'module').length;
}
