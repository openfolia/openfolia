import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { LockSubject } from '../../../change-sets/core/lock.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ContentChecks, type Checked } from '../content-checks.js';

interface Input {
  readonly actor: Actor;
  readonly snapshot: ReadableContent;
  /** Only this manual's checks (`ContentChecks.manual`); none: everything at the commit. */
  readonly manualId?: string;
}

export interface ContentCheckResult extends Checked {
  /** The commit checked. */
  readonly commit: string;
}

/**
 * Every check of the content at a commit, as the actor sees it (#55, the CLI check for CI,
 * `check-content`): each module in each language it has, and each manual (every published
 * variant in every language, as `GET /manuals/:id/checks`), as if a change set changed all of
 * them (`ContentChecks.changes`). With `manualId`, only that manual's checks; a manual the actor
 * may not see is not found, like a missing one. Not paged: the caller prints every check.
 */
@Injectable()
export class CheckContentAction extends ActorAction<Input, ContentCheckResult> {
  readonly policy = 'content.read';

  constructor(private readonly checks: ContentChecks) {
    super();
  }

  protected async run({
    snapshot,
    manualId,
  }: Input): Promise<ContentCheckResult> {
    if (manualId !== undefined) {
      const checked = await this.checks.manual(snapshot, manualId);
      if (!checked) throw new NotFoundError(`No manual "${manualId}".`);
      return { ...checked, commit: snapshot.commit };
    }
    const [modules, manuals] = await Promise.all([
      snapshot.modules(),
      snapshot.manuals(),
    ]);
    const subjects: LockSubject[] = [
      ...manuals.map(({ id }): LockSubject => ({
        type: 'manual',
        manualId: id,
      })),
      ...modules.map(({ id, lang }): LockSubject => ({
        type: 'module',
        lang,
        moduleId: id,
      })),
    ];
    const checked = await this.checks.changes(snapshot, subjects);
    return { ...checked, commit: snapshot.commit };
  }
}
