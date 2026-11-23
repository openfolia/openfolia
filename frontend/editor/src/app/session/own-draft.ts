import { inject } from '@angular/core';

import { MeService } from '../permissions/me';
import { ChangeSetSession, type ChangeSetOption } from './change-set-session';

/** The person's own open draft to work in: the chosen one, else their newest, else none. */
export function ownDraftOf(
  options: readonly ChangeSetOption[],
  chosenId: string | null,
  me: string,
): ChangeSetOption | null {
  const own = options.filter(
    (o) =>
      o.state === 'draft' &&
      o.authorId === me &&
      !o.pending &&
      !o.branchMissing &&
      o.branch !== null,
  );
  const chosen = own.find((o) => o.id === chosenId);
  if (chosen) return chosen;
  return (
    [...own].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    )[0] ?? null
  );
}

/**
 * "Change in a draft" (#589), the needs-a-draft screens' way out: chooses a draft revision of the
 * person's own to change something in, without them going to the revision picker first. The chosen
 * one when it is theirs and a draft, else their newest open draft, else a new one started with
 * `title` (`ChangeSetSession.start`: chosen at once, a refusal is its toast with a retry). Resolves
 * the change set's ID once it is chosen, or null when none could be (the session said why).
 */
export function injectOwnDraft(): (title: string) => Promise<string | null> {
  const session = inject(ChangeSetSession);
  const me = inject(MeService);
  return async (title: string) => {
    // The list says which drafts are theirs: read it first when it has not been.
    if (session.status() !== 'ready' && !(await session.refresh())) {
      return null;
    }
    const found = ownDraftOf(
      session.options(),
      session.selected()?.id ?? null,
      me.me().id,
    );
    if (found) {
      if (session.selected()?.id !== found.id) session.choose(found.id);
      return session.selected()?.id === found.id ? found.id : null;
    }
    return session.start(title);
  };
}
