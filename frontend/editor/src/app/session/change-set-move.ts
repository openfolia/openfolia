import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { ChangeSetSession } from './change-set-session';
import { MaintenanceLines } from './maintenance-lines';
import type { UpdateConflict, UpdateTarget } from './change-set-update';
import { injectFailureText } from './failure-text';

/** A file the move could not carry over: left as the current base has it. */
export interface MoveConflict extends UpdateConflict {
  /** For a module, the blocks the change set changed in it: what to apply again by hand. */
  readonly blockIds?: readonly string[];
}

/** What a move left to apply by hand, in the new change set, until the list is closed. */
export interface MovedConflicts extends UpdateTarget {
  readonly items: readonly MoveConflict[];
  /** How many there are in all (the list holds at most 100). */
  readonly total: number;
}

/** A move that went through: the old change set and the new one holding its changes. */
export interface Moved {
  readonly from: string;
  readonly to: string;
}

type Conflict = Schema<'CarryConflict'>;

/**
 * "Move my changes onto the current main" (#471): for a change set whose base was rewritten (its
 * base commit is no longer in the base's history, `meta.base.state: rewritten`), which can then
 * be neither updated nor merged. `POST /change-sets/{id}/rebase` applies its own changes onto the
 * base's current head as a new draft change set and closes the old one as superseded. The
 * session follows to the new one when it had the old one chosen; screens showing the old one
 * follow `moved`. What could not be carried over (`meta.rebase.conflicts`) is listed for the
 * author to apply by hand (`ChangeSetConflictsComponent`). Nothing is lost by it (the old
 * change set's branch stays readable), so it asks nothing first.
 */
@Injectable({ providedIn: 'root' })
export class ChangeSetMove {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly session = inject(ChangeSetSession);
  private readonly lines = inject(MaintenanceLines);
  private readonly failureText = injectFailureText();

  private readonly running = signal<ReadonlySet<string>>(new Set());
  private readonly pending = signal<MovedConflicts | null>(null);
  private readonly open = signal(false);
  private readonly last = signal<Moved | null>(null);

  /** What the last move left to apply by hand, while its list is kept. */
  readonly conflicts = this.pending.asReadonly();
  /** That list is shown (the dialog). */
  readonly dialogOpen = this.open.asReadonly();
  /** The last move that went through (a new value each time). */
  readonly moved = this.last.asReadonly();
  /** Whether a move of any change set is on its way. */
  readonly anyBusy = computed(() => this.running().size > 0);

  /** A move of the change set is on its way. */
  busy(id: string): boolean {
    return this.running().has(id);
  }

  /** Shows what the last move left to apply by hand again. */
  showConflicts(): void {
    if (this.pending()) this.open.set(true);
  }

  /** Hides the list; the header's button opens it again. */
  closeConflicts(): void {
    this.open.set(false);
  }

  /** "Done": the list is put away for good. */
  dismissConflicts(): void {
    this.open.set(false);
    this.pending.set(null);
  }

  /**
   * Moves the change set's changes onto its base's current head. Resolves the new change set's
   * ID once it went through, or null with a toast saying why (a retry where trying again may
   * help; for one moved already, the way to it).
   */
  async move(target: UpdateTarget): Promise<string | null> {
    if (this.running().has(target.id)) return null;
    this.running.update((s) => new Set(s).add(target.id));
    try {
      // A save on its way (the editor flushes on leaving it) is made before the move, so it is
      // committed with the rest, never left behind in the old change set.
      await this.api.putsSettled();
      const doc = await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/rebase', {
          path: { changeSetId: target.id },
        }),
      );
      const to = doc.data.id;
      // The session follows to the new one when it had the old one chosen.
      void this.session.supersede(target.id, doc.data);
      const { conflicts, total } = doc.meta.rebase;
      this.toast.success(
        translated(
          total > 0
            ? 'editor.changeSet.move.doneWithConflicts'
            : 'editor.changeSet.move.done',
          {
            title: target.title,
            ref: this.lines.label(target.baseRef),
            count: total,
          },
        ),
      );
      if (total > 0) {
        this.pending.set({
          id: to,
          title: doc.data.attributes.title,
          baseRef: doc.data.attributes.baseRef,
          items: conflicts.map(toConflict),
          total,
        });
        this.open.set(true);
      } else if (this.pending()?.id !== to) {
        this.pending.set(null);
      }
      this.last.set({ from: target.id, to });
      return to;
    } catch (error) {
      this.refused(target, toApiError(error));
      return null;
    } finally {
      this.running.update((s) => {
        const next = new Set(s);
        next.delete(target.id);
        return next;
      });
    }
  }

  private refused(target: UpdateTarget, failure: ApiError): void {
    const other = failure.errors[0]?.meta?.['changeSetId'];
    if (failure.code === 'already-superseded' && typeof other === 'string') {
      // Moved already (in another tab, say): the way to where its changes are now.
      this.toast.show(
        translated('editor.changeSet.move.already', { title: target.title }),
        {
          kind: 'info',
          actionLabel: translated('editor.changeSet.move.openNew'),
          onAction: () => {
            void this.session.refresh().then(() => {
              this.session.choose(other);
              this.last.set({ from: target.id, to: other });
            });
          },
        },
      );
      return;
    }
    const retry =
      failure.kind === 'unavailable' ||
      failure.kind === 'network' ||
      failure.code === 'database-timeout';
    this.toast.error(
      this.failureText(
        translated('editor.changeSet.move.failed', {
          title: target.title,
          ref: this.lines.label(target.baseRef),
        }),
        failure,
      ),
      retry
        ? {
            actionLabel: translated('editor.session.retry'),
            onAction: () => void this.move(target),
          }
        : {},
    );
  }
}

const isSubject = (value: unknown): value is UpdateConflict['subject'] =>
  typeof value === 'object' &&
  value !== null &&
  ['module', 'manual', 'config', 'term', 'design'].includes(
    (value as { type?: unknown }).type as string,
  );

function toConflict(c: Conflict): MoveConflict {
  return {
    path: c.path,
    ...(isSubject(c.subject) ? { subject: c.subject } : {}),
    kinds: [...c.kinds],
    ...(c.blockIds ? { blockIds: [...c.blockIds] } : {}),
  };
}
