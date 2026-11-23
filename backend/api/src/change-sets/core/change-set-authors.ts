import { Injectable } from '@nestjs/common';
import { CarryForwards } from './carry-forwards.js';
import type { ChangeSet, ChangeSetAuthor } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { ChangeSetStore } from './change-set-store.js';
import { ChangeSetSupersessions } from './supersessions.js';

/** The most change sets followed back through carry-forwards and moves (#597). */
export const MAX_AUTHOR_LINKS = 50;

/**
 * Whoever wrote a commit of `changeSet`'s own line from its base commit to `head`, its recorded
 * author first, each once (`ChangeSetBranches.writers`: read from Git, only commits the API
 * wrote, the writers its `Carried-author` trailers name included; a push from outside, an import
 * or an update from the base names nobody). What a carry-forward or a move writes into its commit
 * (`CarryChange`), so a carried change set's writers stay named in Git.
 */
export async function writersOf(
  branches: ChangeSetBranches,
  changeSet: Pick<ChangeSet, 'author' | 'branch' | 'baseCommit'>,
  head: string,
): Promise<ChangeSetAuthor[]> {
  const writers = await branches.writers(
    changeSet.branch,
    head,
    changeSet.baseCommit,
  );
  const { author } = changeSet;
  return [
    { kind: author.kind, id: author.id },
    ...writers.filter((w) => w.kind !== author.kind || w.id !== author.id),
  ];
}

/**
 * Everyone who counts as a change set's author (#597): everyone who wrote content in it, not only
 * its recorded author. That is `writersOf` at the head being approved or returned, and, followed
 * back through the links Postgres keeps (never through Git, which a push could rewrite), everyone
 * who counts as an author of the change set it carries forward (`CarryForwards`, #60) or moved
 * onto a rewritten base (`ChangeSetSupersessions`, #471), at its branch's head (else its review
 * head): so a fix carried forward by someone else stays its writer's, even when nothing applied
 * and the carrier typed it again by hand.
 *
 * Four eyes and the self-approval rule apply to every one of them (`Workflow.ownApproval`,
 * `Workflow.notTheAuthor`). Worked out when needed, never taken from a client. Being named only
 * ever restricts: every right an author has (reading their own work, abandoning, moving it) still
 * goes by the recorded author alone.
 */
@Injectable()
export class ChangeSetAuthors {
  constructor(
    private readonly branches: ChangeSetBranches,
    private readonly store: ChangeSetStore,
    private readonly carries: CarryForwards,
    private readonly supersessions: ChangeSetSupersessions,
  ) {}

  async of(changeSet: ChangeSet, head: string): Promise<ChangeSetAuthor[]> {
    const found = new Map<string, ChangeSetAuthor>();
    const add = (a: ChangeSetAuthor) => {
      const key = `${a.kind}/${a.id}`;
      if (!found.has(key)) found.set(key, a);
    };
    const seen = new Set<string>([changeSet.id]);
    const todo: { changeSet: ChangeSet; head: string | undefined }[] = [
      { changeSet, head },
    ];
    for (let next = todo.shift(); next; next = todo.shift()) {
      add(next.changeSet.author);
      if (next.head !== undefined) {
        for (const a of await writersOf(
          this.branches,
          next.changeSet,
          next.head,
        )) {
          add(a);
        }
      }
      const [carried, links] = await Promise.all([
        this.carries.sourceOf(next.changeSet.id),
        this.supersessions.linksOf(next.changeSet.id),
      ]);
      for (const id of [carried, links.supersedes]) {
        if (id === undefined || seen.has(id)) continue;
        if (seen.size > MAX_AUTHOR_LINKS) {
          // A chain this long is no carry history: refuse rather than guess (fail closed).
          throw new Error(
            `Change set ${changeSet.id} links back past ${MAX_AUTHOR_LINKS} change sets.`,
          );
        }
        seen.add(id);
        const source = await this.store.find(id);
        if (!source) continue;
        todo.push({
          changeSet: source,
          // What its branch holds, as a carry or a move takes it; its review head once it is gone.
          head: (await this.branches.head(source.branch)) ?? source.reviewHead,
        });
      }
    }
    return [...found.values()];
  }
}
