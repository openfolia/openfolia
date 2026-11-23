import {
  termLinks,
  type Manifest,
  type Module,
  type PageDesign,
  type Term,
} from '@openfolia/content-model';
import { type Problem, UnprocessableProblems } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { subjectName, type LockSubject } from './lock.js';
import type { DraftManifest } from './working-copy.js';

/** A term link (#245) to a term a commit deletes. */
export interface TermUsage {
  readonly subject: Extract<LockSubject, { type: 'module' }>;
  /** The block (or list item) the link is in. */
  readonly blockId: string;
  readonly termId: string;
  /** Whether the actor may read the module. */
  readonly seen: boolean;
}

/** The most usages one refusal names; the detail says there are more. */
export const MAX_TERM_USAGES = 100;

/**
 * The term links to `deleted` (term IDs) in `content` (a change set's head)
 * as a commit leaves it: `replaced` holds the files the same commit writes
 * (by subject name, `null` for a deletion), read in place of what is
 * committed. Every module counts, in every language, whether or not the
 * actor may read it (read past the reading filter: a check, never a
 * response); `seen` says whether they may.
 */
export async function termUsages(
  content: ReadableContent,
  deleted: ReadonlySet<string>,
  replaced: ReadonlyMap<
    string,
    Module | Manifest | DraftManifest | Term | PageDesign | null
  >,
): Promise<TermUsage[]> {
  if (deleted.size === 0) return [];
  const usages: TermUsage[] = [];
  const check = async (
    subject: TermUsage['subject'],
    module: Module,
  ): Promise<void> => {
    const links = [...termLinks(module.blocks)].filter((l) =>
      deleted.has(l.termId),
    );
    if (links.length === 0) return;
    const seen = await content.wouldSee({ module });
    const named = new Set<string>();
    for (const { termId, blockId } of links) {
      const key = `${blockId}\u0000${termId}`;
      if (named.has(key)) continue;
      named.add(key);
      usages.push({ subject, blockId, termId, seen });
    }
  };
  for await (const file of content.everythingForCheck()) {
    if (file.kind !== 'module' || file.module === 'unreadable') continue;
    const subject = {
      type: 'module' as const,
      lang: file.lang,
      moduleId: file.id,
    };
    if (replaced.has(subjectName(subject))) continue;
    await check(subject, file.module);
  }
  for (const file of replaced.values()) {
    // A module the commit writes: its blocks as written (a manifest has
    // entries, a term languages).
    if (file === null || !('blocks' in file)) continue;
    await check(
      { type: 'module', lang: file.meta.lang, moduleId: file.id },
      file,
    );
  }
  return usages.sort(
    (a, b) =>
      subjectName(a.subject).localeCompare(subjectName(b.subject)) ||
      a.blockId.localeCompare(b.blockId) ||
      a.termId.localeCompare(b.termId),
  );
}

/**
 * 422 `term-in-use` when a term to delete is still linked: one error object
 * per link the actor may read (at most `MAX_TERM_USAGES`), `source.pointer`
 * naming the module and block (`/module/en/charging/blocks/<id>`), `meta`
 * the subject, the block (`at`) and the term; links in modules the actor
 * may not read are one error object without a pointer, which names
 * neither them nor how many there are.
 */
export function refuseTermUsages(usages: readonly TermUsage[]): void {
  if (usages.length === 0) return;
  const seen = usages.filter((u) => u.seen);
  const problems: Problem[] = seen
    .slice(0, MAX_TERM_USAGES)
    .map(({ subject, blockId, termId }) => ({
      detail: `The term "${termId}" is linked here.`,
      pointer: `/module/${subject.lang}/${subject.moduleId}/blocks/${blockId}`,
      meta: { subject, at: blockId, term: termId },
    }));
  const hidden = usages.filter((u) => !u.seen);
  if (hidden.length > 0) {
    problems.push({
      detail: 'Content you may not read links it too.',
      meta: { terms: [...new Set(hidden.map((u) => u.termId))].sort() },
    });
  }
  throw new UnprocessableProblems(
    'term-in-use',
    `Modules still link the ${new Set(usages.map((u) => u.termId)).size === 1 ? 'term' : 'terms'} to delete${seen.length > MAX_TERM_USAGES ? ` (the first ${MAX_TERM_USAGES} places listed)` : ''}: remove the term links first.`,
    problems,
  );
}
