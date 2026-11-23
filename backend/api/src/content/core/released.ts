import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE } from '../../access/core/allows.js';
import type { RefInfo } from './content.repository.js';
import type { ReadPermission } from './readable-content.js';

/** The branch whose content is released; every other branch is a draft. */
export const RELEASED_BRANCH = 'main';

type Refs = { branches: readonly RefInfo[]; tags: readonly RefInfo[] };

/**
 * Released refs: the branch `main` and every tag (releases are tags of
 * `main`). Reading anything else needs `content.read.draft`.
 */
export function releasedRefs(refs: Refs): {
  branches: RefInfo[];
  tags: RefInfo[];
} {
  return {
    branches: refs.branches.filter((ref) => ref.name === RELEASED_BRANCH),
    tags: [...refs.tags],
  };
}

/**
 * Whether a commit is released content: the commit `main` or a tag points
 * to now. Decided by commit, never by the name asked for, since a name can
 * be a branch and a tag at once (the branch wins). Any other commit, also an
 * earlier one of `main`, is a draft: this fails closed.
 */
export function isReleased(commit: string, refs: Refs): boolean {
  const { branches, tags } = releasedRefs(refs);
  return [...branches, ...tags].some((ref) => ref.commit === commit);
}

/**
 * The permission `actor` reads `commit` with: `content.read` when it is
 * released (`isReleased`), else `content.read.draft` if the actor holds it
 * in any scope. `undefined`: the commit is a draft the actor may not know
 * of, so it must look exactly like one that does not exist. The one rule
 * for every lookup of a ref by name.
 */
export function readPermissionAt(
  actor: Actor,
  commit: string,
  refs: Refs,
): ReadPermission | undefined {
  if (isReleased(commit, refs)) return 'content.read';
  return allows(actor, 'content.read.draft', ANYWHERE)
    ? 'content.read.draft'
    : undefined;
}
