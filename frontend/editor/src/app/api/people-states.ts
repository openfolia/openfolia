import { Injectable, signal } from '@angular/core';

/** Someone an answer names: an author, approver, commenter, … */
export interface Named {
  readonly kind: string;
  readonly id: string;
}

/**
 * Which of the people the API's answers named are deactivated (#928): each answer that names
 * people says so (`meta.people`), and the last one read counts. Filled by `peopleInterceptor`, so
 * no screen passes it on; a state of its own, as `ReadRef` is, so the client depends on nothing.
 */
@Injectable({ providedIn: 'root' })
export class PeopleStates {
  private readonly ids = signal<ReadonlySet<string>>(new Set());

  /** The IDs of the users known to be deactivated. */
  readonly deactivated = this.ids.asReadonly();

  /** A user known to be deactivated; never a service account, or someone no answer named. */
  isDeactivated(who: Named): boolean {
    return who.kind === 'user' && this.ids().has(who.id);
  }

  /** What an answer says of the people it names. */
  read(people: readonly { id: string; deactivated: boolean }[]): void {
    this.ids.update((ids) => {
      const changed = people.filter((p) => ids.has(p.id) !== p.deactivated);
      if (changed.length === 0) return ids;
      const next = new Set(ids);
      for (const { id, deactivated } of changed) {
        if (deactivated) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
}
