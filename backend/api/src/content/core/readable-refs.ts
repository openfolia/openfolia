import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { ContentRepository, type RefInfo } from './content.repository.js';
import { isReleased, readPermissionAt } from './released.js';
import {
  NoWithdrawnReleases,
  type TagWithdrawal,
  WithdrawnReleases,
} from './withdrawn-releases.js';

/** A full commit ID: read as such, never as a tag's name. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Refs looked up by name, as the actor may know of them: for code that
 * needs a ref but reads no content (`OpenSnapshotAction` is for content).
 * A ref whose commit is not released needs `content.read.draft`
 * (`readPermissionAt`); without it, it is `undefined`, exactly like a ref
 * that does not exist. It checks no policy of its own: its caller's action
 * has (a released branch's existence is not hidden from that caller).
 */
@Injectable()
export class ReadableRefs {
  constructor(
    private readonly content: ContentRepository,
    private readonly withdrawn: WithdrawnReleases = new NoWithdrawnReleases(),
  ) {}

  /**
   * The branch named `name` (exactly), if there is one the actor may know
   * of, and whether its commit is released content (`isReleased`).
   */
  async branch(
    actor: Actor,
    name: string,
  ): Promise<(RefInfo & { released: boolean }) | undefined> {
    const refs = await this.content.refs();
    const branch = refs.branches.find((ref) => ref.name === name);
    const permission = branch && readPermissionAt(actor, branch.commit, refs);
    if (!branch || !permission) return undefined;
    return { ...branch, released: isReleased(branch.commit, refs) };
  }

  /**
   * Whether `commit` is released content now (`isReleased`: `main` or a
   * tag points to it, a withdrawn release's tag included, as it stays
   * readable).
   */
  async isReleased(commit: string): Promise<boolean> {
    return isReleased(commit, await this.content.refs());
  }

  /**
   * The release tags, newest first, but those of withdrawn releases
   * (#138): they stay readable, yet no longer count as a release where the
   * newest one holding something is looked for (a module's status, its
   * history). Released content, so every reader of `content.read` may know
   * them (as `GET /refs` lists them).
   */
  async releases(): Promise<RefInfo[]> {
    const [tags, withdrawn] = await Promise.all([
      this.content.releases(),
      this.withdrawn.withdrawals(),
    ]);
    return withdrawn.size === 0
      ? tags
      : tags.filter((tag) => !withdrawn.has(tag.name));
  }

  /**
   * Every withdrawn release's withdrawal, by its tag's name (#330): who,
   * when and why. Released content, as `releases` is.
   */
  withdrawals(): Promise<ReadonlyMap<string, TagWithdrawal>> {
    return this.withdrawn.withdrawals();
  }

  /**
   * The withdrawal of the release whose tag a read at `ref` reads (#330),
   * resolved as a read resolves it (`ContentRepo.at`): `refs/tags/<tag>`,
   * or `<tag>` when no branch has that name (a branch wins); never a
   * commit ID or a branch. Undefined for anything else, a standing
   * release's tag included. The refs are only listed when a withdrawn
   * release's tag has that name, so a read of `main` costs one query.
   */
  async withdrawalAt(ref: string): Promise<TagWithdrawal | undefined> {
    if (ref.startsWith('refs/heads/') || COMMIT_ID.test(ref)) return undefined;
    const name = ref.startsWith('refs/tags/')
      ? ref.slice('refs/tags/'.length)
      : ref;
    const withdrawal = (await this.withdrawn.withdrawals()).get(name);
    if (!withdrawal) return undefined;
    const refs = await this.content.refs();
    if (!refs.tags.some((tag) => tag.name === name)) return undefined;
    if (name === ref && refs.branches.some((branch) => branch.name === name)) {
      return undefined;
    }
    return withdrawal;
  }
}
