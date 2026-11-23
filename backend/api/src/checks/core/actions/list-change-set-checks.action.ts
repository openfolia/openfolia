import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest } from '../../../base/core/paging.js';
import { ListChangeSetChangesAction } from '../../../change-sets/core/actions/list-change-set-changes.action.js';
import { GetChangeSetAction } from '../../../change-sets/core/actions/get-change-set.action.js';
import { ChangeSetBranches } from '../../../change-sets/core/change-set-branches.js';
import { openSides } from '../../../change-sets/core/change-set-sides.js';
import { changedPathsWithin } from '../../../change-sets/core/review-scope.js';
import { ListChunksAction } from '../../../chunks/core/actions/list-chunks.action.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  pageOfChecks,
  type CheckFilter,
  type CheckPage,
} from '../check-page.js';
import { ContentChecks, type Checked } from '../content-checks.js';
import { CHECKS_KEPT, CHECKS_TTL_MS, Fresh, keyOf } from '../fresh.js';

interface Input {
  readonly actor: Actor;
  readonly id: string;
  readonly filter: CheckFilter;
  readonly page: PageRequest;
}

/**
 * The checks of what a change set changes, at its head
 * (`ContentChecks.changes`): the modules and manuals its changes list
 * names (`ListChangeSetChangesAction`), read there as the actor may read
 * that commit. The change set is found as `GetChangeSetAction` finds it
 * (another author's is 404 for an actor without `content.read.draft`,
 * exactly like a missing one) and its sides are opened as `openSides`
 * opens them; nothing about a module the actor may not see is listed or
 * counted. Filtered, counted and paged.
 *
 * A page design it changes, or one naming an own template whose folder it changes (#396), has
 * that template compiled (`ContentChecks.changes`): a template that does not compile is a
 * blocking `page-design-template-error` at the design, so it is held before it is merged.
 *
 * Before it is approved, the head's retrieval chunks as a whole too (#710): a head whose chunks,
 * as the actor sees them, are too large together (`ListChunksAction.tooLarge`, the budget of
 * `GET /chunks`) has a blocking `chunk-set-too-large` at each module that expanded the most.
 */
@Injectable()
export class ListChangeSetChecksAction extends ActorAction<Input, CheckPage> {
  readonly policy = 'content.read';
  /** Kept briefly, so paging and filtering read a change set's checks once. */
  readonly #checks = new Fresh<Checked>(CHECKS_KEPT, CHECKS_TTL_MS);

  constructor(
    private readonly getChangeSet: GetChangeSetAction,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly changes: ListChangeSetChangesAction,
    private readonly checks: ContentChecks,
    private readonly chunks: ListChunksAction,
  ) {
    super();
  }

  protected async run({ actor, id, filter, page }: Input): Promise<CheckPage> {
    const changeSet = await this.getChangeSet.handle({ actor, id });
    const sides = await openSides(
      this.branches,
      this.openSnapshot,
      actor,
      changeSet,
    );
    const { base, head } = sides;
    const checks = await this.#checks.get(
      keyOf(base.commit, base.readingKey, head.commit, head.readingKey),
      async () => {
        const [changed, paths] = await Promise.all([
          this.changes.between(sides),
          changedPathsWithin(this.branches, base.commit, head.commit),
        ]);
        // Alongside the other checks, not after them (#710).
        const chunkSet =
          changed.length === 0 ? undefined : this.chunks.tooLarge(head);
        // Awaited by `changes`; a refusal meanwhile is not left unhandled.
        chunkSet?.catch(() => undefined);
        return this.checks.changes(
          head,
          changed.map((change) => change.subject),
          chunkSet,
          changedTemplates(paths),
        );
      },
    );
    return { ...pageOfChecks(checks, filter, page), commit: sides.head.commit };
  }
}

/** The own templates (#396) whose folder (`templates/<id>/`) a change set's paths change. */
export function changedTemplates(
  paths: readonly { readonly path: string }[],
): string[] {
  const ids = new Set<string>();
  for (const { path } of paths) {
    const m = /^templates\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(path);
    if (m) ids.add(m[1] as string);
  }
  return [...ids].sort();
}
