import type { Deprecation } from '@openfolia/content-model';
import { Injectable, Logger } from '@nestjs/common';
import { InvalidContentError } from '../../base/core/errors.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../content/core/content.repository.js';
import type { ChangeSetEvent } from './change-set-events.js';
import { subjectOfPath } from './subject-kinds.js';

/**
 * The outbox topics of a merged deprecation (#266). Their payload holds content read unfiltered
 * (the reason, the replacement), whatever the module's or manual's audience: a consumer that
 * passes rows on applies its readers' rules first, or reads the subject again as them.
 */
export const DEPRECATION_TOPICS = [
  'module.deprecated',
  'manual.deprecated',
] as const;

/**
 * The outbox rows of what a merged change set deprecates (#266): one
 * `module.deprecated` per module whose source-language file is deprecated
 * at `head` (the review head that was merged) and was not at the change
 * set's base commit (a new module that is deprecated counts too), one
 * `manual.deprecated` per manifest alike. Read from Git unfiltered: what a
 * consumer (webhooks #42, the change feed #43, notifications #252) is told
 * is decided there, by its own rules. Keyed by the change set and the
 * subject, so each is written once however often the merge is recorded. A
 * file that cannot be read on a side counts as not deprecated there; an
 * undone deprecation writes nothing.
 */
@Injectable()
export class DeprecationEvents {
  readonly #log = new Logger('DeprecationEvents');

  constructor(private readonly content: ContentRepository) {}

  /**
   * The rows, or none when they cannot be worked out (Git failing): recording a merge that
   * landed never depends on them, so it is logged and the merge is recorded without.
   */
  async of(
    changed: () => Promise<readonly { path: string; deleted: boolean }[]>,
    merge: MergedChangeSet,
  ): Promise<ChangeSetEvent[]> {
    try {
      return await deprecationEvents(this.content, await changed(), merge);
    } catch (error) {
      this.#log.error(
        `The deprecations merged by ${merge.changeSetId} could not be read: no outbox rows written`,
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }
}

/** A merged change set, as `deprecationEvents` compares it. */
export interface MergedChangeSet {
  readonly changeSetId: string;
  readonly baseCommit: string;
  readonly head: string;
  /** Where the base branch is now: the merge commit. */
  readonly commit: string;
}

/** `DeprecationEvents.of`, over any repository. */
export async function deprecationEvents(
  content: Pick<ContentRepository, 'at'>,
  changed: readonly { path: string; deleted: boolean }[],
  merge: MergedChangeSet,
): Promise<ChangeSetEvent[]> {
  const subjects = changed
    .filter((c) => !c.deleted)
    .map((c) => subjectOfPath(c.path))
    .filter((s) => s?.type === 'module' || s?.type === 'manual');
  if (subjects.length === 0) return [];
  const [base, at] = await Promise.all([
    content.at(merge.baseCommit),
    content.at(merge.head),
  ]);
  if (at?.commit !== merge.head) return [];
  const source = await readOrNone(() =>
    at.config().then((c) => c.languages.source),
  );
  const events: ChangeSetEvent[] = [];
  const common = { changeSetId: merge.changeSetId, commit: merge.commit };
  for (const subject of subjects) {
    let found: { id: string; lang?: string; read: Read } | undefined;
    if (subject?.type === 'module' && subject.lang === source) {
      const { moduleId: id, lang } = subject;
      found = {
        id,
        lang,
        read: (s) => s.module(id, lang).then((m) => m?.meta.deprecated),
      };
    } else if (subject?.type === 'manual') {
      const id = subject.manualId;
      found = { id, read: (s) => s.manifest(id).then((m) => m?.deprecated) };
    }
    if (!found) continue;
    const { id, lang, read } = found;
    const now = await readOrNone(() => read(at));
    if (!now || (base && (await readOrNone(() => read(base))))) continue;
    const kind = subject?.type === 'module' ? 'module' : 'manual';
    events.push({
      topic: `${kind}.deprecated`,
      key: `${merge.changeSetId}/${id}`,
      payload: {
        [kind === 'module' ? 'moduleId' : 'manualId']: id,
        // The file it was read from: a webhook tells only who may read that one (#42).
        ...(lang !== undefined && { lang }),
        reason: now.reason,
        replacedBy: now.replacedBy ?? null,
        ...common,
      },
    });
  }
  return events;
}

type Read = (s: ContentSnapshot) => Promise<Deprecation | undefined>;

async function readOrNone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}
