import { Injectable } from '@nestjs/common';
import type { Module } from '@openfolia/content-model';
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

/** One side of a comparison: the commit read and the module there. */
export interface ComparedSide {
  readonly commit: string;
  /** As the reader sees it on both sides; undefined when not there. */
  readonly module: Side<Module>;
}

export interface ModuleComparison {
  readonly base: ComparedSide;
  readonly head: ComparedSide;
  /** How it changed from base to head; undefined when it is the same. */
  readonly change: SubjectChange | undefined;
}

interface Input {
  readonly actor: Actor;
  readonly id: string;
  readonly lang: string;
  /** A commit ID or tag (any ref the actor may open). */
  readonly base: string;
  readonly head: string;
}

/**
 * A module at two versions and how it changed between them, block by
 * block (`subjectChange`, `diffBlocks`: the change set diff's shape, so
 * the review screen's diff renders it). Each side is opened as reading it
 * needs (`OpenSnapshotAction`): a released commit with `content.read`,
 * any other, also an older commit of `main`, with `content.read.draft`,
 * else it is 404 like a ref that does not exist. Each side shows the
 * module only as the reader would see it on the other too (`seenOnBoth`),
 * so a reader whose scopes differ between the two permissions learns
 * nothing from the wider one; a side where it is not (or is not seen) is
 * `added` or `removed`. Not found when neither side has it.
 */
@Injectable()
export class CompareModuleVersionsAction extends ActorAction<
  Input,
  ModuleComparison
> {
  readonly policy = 'content.read';

  constructor(private readonly openSnapshot: OpenSnapshotAction) {
    super();
  }

  protected async run({
    actor,
    id,
    lang,
    base,
    head,
  }: Input): Promise<ModuleComparison> {
    const [from, to] = await Promise.all([
      this.openSnapshot.handle({ actor, ref: base }),
      this.openSnapshot.handle({ actor, ref: head }),
    ]);
    const subject: LockSubject = { type: 'module', lang, moduleId: id };
    const [before, after] = await Promise.all([
      seenOnBoth(from, to, subject) as Promise<Side<Module>>,
      seenOnBoth(to, from, subject) as Promise<Side<Module>>,
    ]);
    if (before === undefined && after === undefined) {
      throw new NotFoundError(`No module "${id}" in "${lang}" at either side.`);
    }
    return {
      base: { commit: from.commit, module: before },
      head: { commit: to.commit, module: after },
      change: subjectChange(subject, before, after),
    };
  }
}
