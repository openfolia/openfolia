import type { Manifest, Module } from '@openfolia/content-model';
import { InvalidContentError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { Side, SubjectContent } from './change-set-diff.js';
import { committedPageDesign, committedTerm } from './subject-scope.js';
import { TEMPLATE_FILE_SCHEMA_VERSION } from './working-copy.js';
import type { LockSubject } from './lock.js';

/**
 * `subject` in `content` as the actor sees it there and would also see it
 * in `other` (the other side of the same change set): a change set's base
 * and head are opened with the permission each commit takes (a released
 * base with `content.read`, a draft head with `content.read.draft`), and a
 * reader whose two scopes differ must not learn of a draft change outside
 * their draft scope from the released side, nor see a module as added or
 * removed only because their scopes differ. So both sides are read
 * through the reader's scopes for both permissions: what either would
 * hide is not there, exactly like a missing one (a manifest names only
 * the modules it may name to them on both).
 *
 * `'unreadable'` for a broken file only where both would report one (to a
 * reader of all of its language, or of every audience).
 */
export async function seenOnBoth(
  content: ReadableContent,
  other: ReadableContent,
  subject: LockSubject,
): Promise<Side<SubjectContent>> {
  const side = await sideOf(content, subject);
  // The configuration, terms and page designs are read by every reader of a commit.
  if (
    side === undefined ||
    content.permission === other.permission ||
    subject.type === 'config' ||
    subject.type === 'term' ||
    subject.type === 'design' ||
    subject.type === 'template'
  ) {
    return side;
  }
  if (subject.type === 'module') {
    const seen =
      side === 'unreadable'
        ? await other.wouldSee({ brokenModuleIn: subject.lang })
        : await other.wouldSee({ module: side as Module });
    return seen ? side : undefined;
  }
  if (side === 'unreadable') {
    return (await other.wouldSee({ brokenManual: true })) ? side : undefined;
  }
  const manifest = side as Manifest;
  if (!(await other.wouldSee({ manualAudience: manifest.audience }))) {
    return undefined;
  }
  // Its references too: only the modules a manifest may name on both.
  return other.namedHere(manifest, content);
}

/**
 * The subject as `content` lets the actor read it: `'unreadable'` for a
 * broken file only where it reports one, else not there.
 */
async function sideOf(
  content: ReadableContent,
  subject: LockSubject,
): Promise<Side<SubjectContent>> {
  try {
    switch (subject.type) {
      case 'module':
        return await content.module(subject.moduleId, subject.lang);
      case 'manual':
        return (await content.manual(subject.manualId))?.manifest;
      case 'config':
        return await content.config();
      case 'term':
        return await committedTerm(content, subject.termId);
      case 'design':
        return await committedPageDesign(content, subject.designId);
      case 'template': {
        // A template file is its text (#396); one that is no text reads as broken.
        const data = await content.designTemplateFile(
          subject.templateId,
          subject.path,
        );
        if (data === undefined) return undefined;
        const text = utf8Text(data);
        return text === undefined
          ? 'unreadable'
          : { schemaVersion: TEMPLATE_FILE_SCHEMA_VERSION, text };
      }
    }
  } catch (error) {
    if (error instanceof InvalidContentError) {
      // The configuration's own file is what cannot be read.
      if (subject.type === 'config') return 'unreadable';
      // The configuration is broken too: that is no file of this subject.
      await content.config();
      return 'unreadable';
    }
    throw error;
  }
}

/** `bytes` as UTF-8 text; undefined when they are no such text. */
function utf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
