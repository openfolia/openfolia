import type { Actor } from '../../src/access/core/actor.js';
import { AuthoredBranches } from '../../src/content/core/authored-branches.js';

/**
 * `AuthoredBranches` naming `authored` (actor ID → branch names); none by
 * default. `visible` (actor ID → branch names) are the change sets' branches
 * each may see; an authored branch is visible too.
 */
export class FakeAuthoredBranches extends AuthoredBranches {
  constructor(
    readonly authored = new Map<string, string[]>(),
    readonly visible = new Map<string, string[]>(),
  ) {
    super();
  }

  visibleChangeSet(actor: Actor, branch: string): Promise<boolean> {
    const key = `${actor.kind}/${actor.id}`;
    return Promise.resolve(
      (this.visible.get(key)?.includes(branch) ?? false) ||
        (this.authored.get(key)?.includes(branch) ?? false),
    );
  }

  authoredBy(actor: Actor, branch: string): Promise<boolean> {
    return Promise.resolve(
      this.authored.get(`${actor.kind}/${actor.id}`)?.includes(branch) ?? false,
    );
  }
}
