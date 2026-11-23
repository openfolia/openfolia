import { ModuleId } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import { CommitIntents } from '../commit-intents.js';
import { bySubjectKey } from '../commit.js';
import { CommitRecorder } from '../commit-recorder.js';
import type { LockSubject } from '../lock.js';
import { LockStore } from '../lock-store.js';
import {
  moduleSubjects,
  recordRewrites,
  renameScope,
} from '../module-rename.js';
import { keyOf, SavePoints } from '../save-point.js';
import { authorsChangeSet } from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';

export interface GetModuleReferencesInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly moduleId: string;
}

/** What renaming a module would touch, before it is renamed. */
export interface ModuleReferences {
  readonly moduleId: string;
  /** The branch head it was worked out at. */
  readonly head: string;
  /** The languages the module has a file in. */
  readonly languages: readonly string[];
  /**
   * The other modules (per language) and manuals naming it, and the
   * modules deprecated in favour of it (#360): rewritten by a rename.
   */
  readonly references: readonly LockSubject[];
  /**
   * The modules, in a target language, whose translation records the
   * rename brings up to date (#354): locked like the references.
   */
  readonly translations: readonly LockSubject[];
  /** Those subjects (the module's own too) with a working copy in the change set: a rename refuses them. */
  readonly workingCopies: readonly LockSubject[];
}

/** What only a draft is (the `invalid-state` answer's end). */
const RENAMED_IN = 'has modules renamed in it';

/**
 * What renaming module `moduleId` in a change set would touch at its
 * branch head (#265): its languages and every module and manual naming it,
 * so the client takes their locks (and the new ID's) and commits their
 * working copies before `RenameModuleAction`. The same checks as the
 * rename, the new ID aside: the author only, a draft only, and one 403
 * when any of it lies outside the actor's scope (`renameScope`); 404 for a
 * module with no file.
 */
@Injectable()
export class GetModuleReferencesAction extends ActorAction<
  GetModuleReferencesInput,
  ModuleReferences
> {
  readonly policy = 'content.edit';
  private readonly savePoints: SavePoints;

  constructor(
    private readonly changeSets: ChangeSetStore,
    locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    branches: ChangeSetBranches,
    recorder: CommitRecorder,
    intents: CommitIntents,
    openSnapshot: OpenSnapshotAction,
    private readonly unit: UnitOfWork,
  ) {
    super();
    this.savePoints = new SavePoints(
      changeSets,
      locks,
      workingCopies,
      branches,
      recorder,
      intents,
      openSnapshot,
      unit,
    );
  }

  protected async run({
    actor,
    changeSetId,
    moduleId,
  }: GetModuleReferencesInput): Promise<ModuleReferences> {
    await authorsChangeSet(this.changeSets, actor, changeSetId);
    if (!ModuleId.safeParse(moduleId).success) {
      throw new NotFoundError(`No module "${moduleId}".`);
    }
    const { head } = await this.savePoints.open(actor, changeSetId, RENAMED_IN);
    const scope = await renameScope(actor, head, moduleId);
    const references = scope.references.map((r) => r.subject);
    const translations = (await recordRewrites(actor, head, scope)).map(
      (r) => r.subject,
    );
    const keys = new Set(
      [...moduleSubjects(scope, moduleId), ...references, ...translations].map(
        keyOf,
      ),
    );
    const copies = await this.unit.run(
      (tx) => this.workingCopies.sizesOf(tx, changeSetId),
      BOUNDED,
    );
    return {
      moduleId,
      head: head.commit,
      languages: [...scope.files.keys()].sort(),
      references,
      translations,
      workingCopies: copies
        .map((c) => c.subject)
        .filter((s) => keys.has(keyOf(s)))
        .sort(bySubjectKey),
    };
  }
}
