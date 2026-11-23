import { Injectable } from '@nestjs/common';
import type { Manifest } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  type Side,
  subjectChange,
  type SubjectChange,
} from '../../../change-sets/core/change-set-diff.js';
import { seenOnBoth } from '../../../change-sets/core/diff-sides.js';
import type { LockSubject } from '../../../change-sets/core/lock.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';

/** One side of a comparison: the commit read and the manifest there. */
export interface ComparedManualSide {
  readonly commit: string;
  /** As the reader sees it on both sides; undefined when not there. */
  readonly manifest: Side<Manifest>;
}

export interface ManualComparison {
  readonly base: ComparedManualSide;
  readonly head: ComparedManualSide;
  /** How it changed from base to head; undefined when it is the same. */
  readonly change: SubjectChange | undefined;
}

interface Input {
  readonly actor: Actor;
  readonly id: string;
  /** A commit ID or tag (any ref the actor may open). */
  readonly base: string;
  readonly head: string;
}

/**
 * A manual at two versions and how it changed between them, as a module's
 * (`CompareModuleVersionsAction`): each side opened as reading it needs
 * (a released commit with `content.read`, any other with
 * `content.read.draft`, else 404 like a ref that does not exist), each
 * side's manifest only as the reader would see it on the other too
 * (`seenOnBoth`: by its audience on both, naming only the modules it may
 * name to them on both), so a reader whose scopes differ between the two
 * permissions learns nothing from the wider one. Not found when neither
 * side has it.
 */
@Injectable()
export class CompareManualVersionsAction extends ActorAction<
  Input,
  ManualComparison
> {
  readonly policy = 'content.read';

  constructor(private readonly openSnapshot: OpenSnapshotAction) {
    super();
  }

  protected async run({
    actor,
    id,
    base,
    head,
  }: Input): Promise<ManualComparison> {
    const [from, to] = await Promise.all([
      this.openSnapshot.handle({ actor, ref: base }),
      this.openSnapshot.handle({ actor, ref: head }),
    ]);
    const subject: LockSubject = { type: 'manual', manualId: id };
    const [before, after] = await Promise.all([
      seenOnBoth(from, to, subject) as Promise<Side<Manifest>>,
      seenOnBoth(to, from, subject) as Promise<Side<Manifest>>,
    ]);
    if (before === undefined && after === undefined) {
      throw new NotFoundError(`No manual "${id}" at either side.`);
    }
    return {
      base: { commit: from.commit, manifest: before },
      head: { commit: to.commit, manifest: after },
      change: subjectChange(subject, before, after),
    };
  }
}
