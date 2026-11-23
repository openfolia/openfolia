import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ContentRepository } from '../content.repository.js';
import { ReadableContent } from '../readable-content.js';
import { isReleased } from '../released.js';

/**
 * The released content at each of several refs (#764: a product's release tags, for a
 * download's versions), as `OpenSnapshotAction` opens released content: read through the
 * actor's `content.read` scope. In the order given; undefined where the ref names nothing, or a
 * commit that is not released content (`isReleased`: `main` or a tag points to it), which this
 * never opens, whatever the actor's `content.read.draft`; open a draft with
 * `OpenSnapshotAction`. The refs are resolved from one ref listing, and whether each commit is
 * released from another taken beside it (shared while both run), however many refs there are;
 * each opened alone asks for a listing of its own (shared only while one is under way).
 */
@Injectable()
export class OpenReleasedSnapshotsAction extends ActorAction<
  { actor: Actor; refs: readonly string[] },
  (ReadableContent | undefined)[]
> {
  readonly policy = 'content.read';

  constructor(private readonly content: ContentRepository) {
    super();
  }

  protected async run({
    actor,
    refs,
  }: {
    actor: Actor;
    refs: readonly string[];
  }): Promise<(ReadableContent | undefined)[]> {
    if (refs.length === 0) return [];
    const [snapshots, listed] = await Promise.all([
      this.content.atEach(refs),
      this.content.refs(),
    ]);
    return snapshots.map((snapshot) =>
      snapshot && isReleased(snapshot.commit, listed)
        ? new ReadableContent(snapshot, actor, 'content.read')
        : undefined,
    );
  }
}
