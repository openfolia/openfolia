import type { JSONContent } from '@tiptap/core';

import { isUnconfirmed } from '../permissions/unconfirmed';
import { readStored, writeStored } from '../session/stored';

/** The module a draft belongs to, in the change set it is edited in. */
export interface DraftSubject {
  readonly changeSetId: string;
  readonly lang: string;
  readonly moduleId: string;
}

/**
 * What the browser keeps of a module while it is not saved: the editor's document (which may not
 * convert to a module yet: an empty table cell), and the working copy's version and base commit
 * it was edited on, so a stored draft is only taken back on the very copy it was made from.
 */
export interface LocalDraft {
  readonly doc: JSONContent;
  readonly version: number;
  readonly baseCommit: string;
  /** When it was kept (ISO 8601). */
  readonly at: string;
}

// Compatibility: the working name stays in this key, so drafts a browser kept before the product
// was named are still offered back (a lost draft is lost work).
const PREFIX = 'ccms.draft';

/** One key per person, change set, language and module: a draft never reaches anyone else. */
export function draftKey(person: string, subject: DraftSubject): string {
  return [PREFIX, person, subject.changeSetId, subject.lang, subject.moduleId]
    .map(encodeURIComponent)
    .join('/');
}

const isDraft = (value: unknown): value is LocalDraft => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const doc = v['doc'] as Record<string, unknown> | null;
  return (
    typeof doc === 'object' &&
    doc !== null &&
    doc['type'] === 'doc' &&
    typeof v['version'] === 'number' &&
    Number.isInteger(v['version']) &&
    v['version'] >= 0 &&
    typeof v['baseCommit'] === 'string' &&
    typeof v['at'] === 'string'
  );
};

/** The draft kept for this module, or null (none, unreadable or not ours). */
export function readDraft(
  person: string,
  subject: DraftSubject,
): LocalDraft | null {
  // Nobody's while another tab's sign-in is unconfirmed here (#716): nothing kept under it.
  if (isUnconfirmed(person)) return null;
  const raw = readStored(draftKey(person, subject));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isDraft(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the draft; false when the browser would not (storage blocked or full). Then the text is
 * only on the page, and the save status says so.
 */
export function writeDraft(
  person: string,
  subject: DraftSubject,
  draft: LocalDraft,
): boolean {
  if (isUnconfirmed(person)) return false;
  try {
    localStorage.setItem(draftKey(person, subject), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the draft: it is saved, or the person chose the saved version. */
export function clearDraft(person: string, subject: DraftSubject): void {
  if (isUnconfirmed(person)) return;
  writeStored(draftKey(person, subject), null);
}
