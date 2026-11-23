import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideGitMerge,
  lucideLoaderCircle,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetMove } from './change-set-move';
import type { ChangeSetState } from './change-set-session';
import { MaintenanceLines } from './maintenance-lines';
import { ChangeSetUpdate } from './change-set-update';

/**
 * "Update from main" (#22): shown to a draft's author while its base branch has commits its
 * branch lacks, with how many. It updates at once (nothing is lost by it, so nothing is asked
 * first). While the last update left conflicts, it reads "Resolve conflicts" and opens their
 * list (`ChangeSetConflictsComponent`), where "Update again" is. Once its base was rewritten
 * (#471) it stays, disabled with the reason: the notice (`ChangeSetBaseRewrittenComponent`) holds
 * the way out.
 */
@Component({
  selector: 'of-change-set-update',
  imports: [
    FadeInDirective,
    GuardDirective,
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideGitMerge, lucideLoaderCircle, lucideTriangleAlert }),
  ],
  host: { class: 'contents' },
  template: `
    @if (shown()) {
      <button
        ofFadeIn
        z-button
        zType="outline"
        zSize="sm"
        type="button"
        data-testid="change-set-update"
        class="max-w-full"
        [ofGuard]="{
          permission: 'content.edit',
          blockedReason:
            rewritten() && !moved()
              ? 'editor.changeSet.rewritten.updateBlocked'
              : null,
        }"
        [attr.aria-busy]="busy() ? 'true' : null"
        (click)="act()"
      >
        <ng-icon
          [name]="
            busy()
              ? 'lucideLoaderCircle'
              : pending() || moved()
                ? 'lucideTriangleAlert'
                : 'lucideGitMerge'
          "
          data-icon="inline-start"
          strokeWidth="1.5"
          aria-hidden="true"
          [class.animate-spin]="busy()"
          class="motion-reduce:animate-none"
          [class.text-destructive]="(pending() || moved()) && !busy()"
        />
        <span class="truncate">
          @if (moved(); as m) {
            {{
              'editor.changeSet.move.resolve' | transloco: { count: m.total }
            }}
          } @else if (pending(); as p) {
            {{
              'editor.changeSet.update.resolve' | transloco: { count: p.total }
            }}
          } @else if (rewritten()) {
            {{
              'editor.changeSet.rewritten.updateLabel'
                | transloco: { ref: refLabel() }
            }}
          } @else {
            {{
              'editor.changeSet.update.action'
                | transloco: { ref: refLabel(), count: behind() ?? 0 }
            }}
          }
        </span>
      </button>
    }
  `,
})
export class ChangeSetUpdateComponent {
  private readonly updates = inject(ChangeSetUpdate);
  private readonly lines = inject(MaintenanceLines);
  private readonly moves = inject(ChangeSetMove);
  private readonly me = inject(MeService);

  /** The change set; null: none chosen. */
  readonly changeSetId = input<string | null>(null);
  readonly title = input('');
  readonly state = input<ChangeSetState | null>(null);
  readonly authorId = input('');
  /** Changes whenever the screen read the change set again: how far behind is read again too. */
  readonly version = input<unknown>(null);
  /**
   * How far behind it is, when the screen read the change set itself (`meta.behind`, its
   * `baseRef`): taken as it is, with no read of its own.
   */
  readonly known = input<{
    readonly behind: number | null | undefined;
    readonly baseRef: string;
    /** Its base was rewritten (`meta.base.state`, #471). */
    readonly rewritten?: boolean;
  } | null>(null);

  /** Its author's draft: the only one that is updated. */
  private readonly mine = computed(
    () =>
      this.changeSetId() !== null &&
      this.state() === 'draft' &&
      this.authorId() !== '' &&
      this.authorId() === this.me.me().id,
  );

  protected readonly behind = computed(() => {
    const id = this.changeSetId();
    return id === null ? undefined : this.updates.behind(id);
  });
  protected readonly baseRef = computed(() => {
    const id = this.changeSetId();
    return (id === null ? undefined : this.updates.baseRef(id)) ?? 'main';
  });
  /** The base as people read it: a maintenance line by its product version (#250). */
  protected readonly refLabel = computed(() =>
    this.lines.label(this.baseRef()),
  );
  protected readonly pending = computed(() => {
    const id = this.changeSetId();
    return id === null ? null : this.updates.conflictsOf(id);
  });
  protected readonly busy = computed(() => {
    const id = this.changeSetId();
    return id !== null && this.updates.busy(id);
  });
  /** What moving its changes here left to apply by hand (#471), while that list is kept. */
  protected readonly moved = computed(() => {
    const id = this.changeSetId();
    const left = this.moves.conflicts();
    return id !== null && left?.id === id ? left : null;
  });
  /** Its base was rewritten (#471): shown, but blocked with the reason; the notice has the way out. */
  protected readonly rewritten = computed(() => {
    const id = this.changeSetId();
    return id !== null && this.updates.rewritten(id);
  });

  protected readonly shown = computed(
    () =>
      this.mine() &&
      (this.pending() !== null ||
        this.moved() !== null ||
        (this.behind() ?? 0) > 0 ||
        this.busy() ||
        this.rewritten()),
  );

  constructor() {
    effect(() => {
      const id = this.changeSetId();
      const known = this.known();
      this.version();
      if (id === null || !this.mine()) return;
      untracked(() =>
        known
          ? this.updates.know(
              id,
              known.behind,
              known.baseRef,
              known.rewritten ?? false,
            )
          : void this.updates.check(id),
      );
    });
  }

  protected act(): void {
    const id = this.changeSetId();
    if (id === null || this.busy()) return;
    if (this.moved()) {
      this.moves.showConflicts();
      return;
    }
    if (this.rewritten()) return;
    if (this.pending()) {
      this.updates.showConflicts();
      return;
    }
    void this.updates.update({
      id,
      title: this.title(),
      baseRef: this.baseRef(),
    });
  }
}
