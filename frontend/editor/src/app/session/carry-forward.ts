import { computed, inject, Injectable, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from './change-set-session';
import type { MoveConflict } from './change-set-move';
import { injectFailureText } from './failure-text';
import { MaintenanceLines } from './maintenance-lines';

/** A change set merged into a maintenance line, to carry forward. */
export interface CarrySource {
  readonly id: string;
  readonly title: string;
  /** The line's branch it was merged into (named by the line's product and version only). */
  readonly baseRef: string;
}

/** What a carry-forward left to fix by hand in the new draft on `main`, until the list is closed. */
export interface CarriedConflicts {
  /** The new draft on `main`. */
  readonly id: string;
  readonly title: string;
  /** The change set carried forward. */
  readonly from: string;
  readonly items: readonly MoveConflict[];
  /** How many there are in all (the list holds at most 100). */
  readonly total: number;
}

type Conflict = Schema<'CarryConflict'>;

/**
 * "Carry forward to current" (#250): a fix merged into a maintenance line, applied to `main` as a
 * new draft of the person's (`POST /change-sets/{id}/carry-forward`, never automatic). The new
 * draft is chosen and opened in the review; what `main` changed differently is left as it is
 * there and listed (`CarryForwardConflictsComponent`), each block linking into the editor at it.
 * Carried already: the way to that draft. Trying again is safe: the API carries a change set
 * forward once (`already-carried-forward`).
 */
@Injectable({ providedIn: 'root' })
export class CarryForward {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly session = inject(ChangeSetSession);
  private readonly lines = inject(MaintenanceLines);
  private readonly router = inject(Router);
  private readonly me = inject(MeService);
  private readonly failureText = injectFailureText();

  private readonly running = signal<ReadonlySet<string>>(new Set());
  private readonly pending = signal<CarriedConflicts | null>(null);
  private readonly open = signal(false);

  /** What the last carry-forward left to fix by hand, while its list is kept. */
  readonly conflicts = this.pending.asReadonly();
  /** That list is shown (the dialog). */
  readonly dialogOpen = this.open.asReadonly();
  readonly anyBusy = computed(() => this.running().size > 0);

  /** A carry-forward of the change set is on its way. */
  busy(id: string): boolean {
    return this.running().has(id);
  }

  /** Hides the list; it is shown again by `showConflicts`. */
  closeConflicts(): void {
    this.open.set(false);
  }

  showConflicts(): void {
    if (this.pending()) this.open.set(true);
  }

  /** "Done": the list is put away for good. */
  dismissConflicts(): void {
    this.open.set(false);
    this.pending.set(null);
  }

  /**
   * Carries the change set forward to `main`. Resolves the new draft's ID once it went through
   * (chosen, and opened in the review), or null with a toast saying why.
   */
  async carry(source: CarrySource): Promise<string | null> {
    if (this.running().has(source.id)) return null;
    this.running.update((s) => new Set(s).add(source.id));
    const line = this.lines.label(source.baseRef);
    const person = untracked(this.me.me).id;
    try {
      const doc = await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/carry-forward', {
          path: { changeSetId: source.id },
        }),
      );
      // Someone else acts now (a switch meanwhile): the draft is not theirs to open.
      if (untracked(this.me.me).id !== person) return null;
      const to = doc.data.id;
      const { conflicts, total } = doc.meta.carryForward;
      await this.session.adopt(doc.data);
      this.toast.success(
        translated(
          total > 0
            ? 'editor.carryForward.doneWithConflicts'
            : 'editor.carryForward.done',
          { title: source.title, line, count: total },
        ),
      );
      if (total > 0) {
        this.pending.set({
          id: to,
          title: doc.data.attributes.title,
          from: source.id,
          items: conflicts.map(toConflict),
          total,
        });
        this.open.set(true);
      } else if (this.pending()?.id !== to) {
        this.pending.set(null);
      }
      this.openDraft(to);
      return to;
    } catch (error) {
      this.refused(source, line, toApiError(error));
      return null;
    } finally {
      this.running.update((s) => {
        const next = new Set(s);
        next.delete(source.id);
        return next;
      });
    }
  }

  /** Opens a draft in the review, chosen as the revision edits happen in. */
  openDraft(id: string): void {
    void this.router.navigate(['/review'], {
      queryParams: { state: 'draft', cs: id },
    });
  }

  /** Opens the editor at a block of a module the carry-forward left to fix, in the new draft. */
  openBlock(lang: string, moduleId: string, blockId: string | null): void {
    const id = this.pending()?.id;
    this.open.set(false);
    void this.router.navigate(['/content', lang, moduleId], {
      queryParams: {
        ...(id ? { cs: id } : {}),
        ...(blockId ? { block: blockId } : {}),
      },
    });
  }

  private refused(source: CarrySource, line: string, failure: ApiError): void {
    const other = failure.errors[0]?.meta?.['changeSetId'];
    if (
      failure.code === 'already-carried-forward' &&
      typeof other === 'string'
    ) {
      // Carried already (by someone else, or in another tab): the way to that draft.
      this.toast.show(
        translated('editor.carryForward.already', { title: source.title }),
        {
          kind: 'info',
          actionLabel: translated('editor.carryForward.openDraft'),
          onAction: () => {
            void this.session.refresh().then(() => {
              this.session.choose(other);
              this.openDraft(other);
            });
          },
        },
      );
      return;
    }
    if (failure.code === 'no-changes') {
      this.toast.show(
        translated('editor.carryForward.nothing', { title: source.title }),
        { kind: 'info' },
      );
      return;
    }
    const retry =
      failure.kind === 'unavailable' ||
      failure.kind === 'network' ||
      failure.code === 'database-timeout';
    this.toast.error(
      this.failureText(
        translated('editor.carryForward.failed', { title: source.title, line }),
        failure,
      ),
      retry
        ? {
            actionLabel: translated('editor.session.retry'),
            onAction: () => void this.carry(source),
          }
        : {},
    );
  }
}

const isSubject = (value: unknown): value is MoveConflict['subject'] =>
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
