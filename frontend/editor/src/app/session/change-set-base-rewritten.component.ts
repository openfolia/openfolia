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
  lucideArrowUpRight,
  lucideGitBranchPlus,
  lucideLoaderCircle,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { HelpService } from '../help/help.service';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetMove } from './change-set-move';
import type { ChangeSetState } from './change-set-session';
import { MaintenanceLines } from './maintenance-lines';
import { ChangeSetUpdate } from './change-set-update';

const OPEN: readonly ChangeSetState[] = ['draft', 'in-review', 'approved'];

/**
 * Says up front, in plain words, that the change set's base was rewritten (#471: its history no
 * longer holds the commit the change set started from, after a force-push or a restore), so it
 * can be neither updated nor merged, and offers the way out: "Move my changes onto the current
 * main" (`ChangeSetMove`, for its author only: it closes the change set), with "Learn more" opening the user guide's page in the interface
 * language (`HelpService`, by its article ID; left out when the operator turned the links off). Shown as
 * soon as the screen opens, for an open change set; the screen says what it read
 * (`rewritten`), or the notice reads it itself.
 */
@Component({
  selector: 'of-change-set-base-rewritten',
  imports: [
    FadeInDirective,
    GuardDirective,
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideGitBranchPlus,
      lucideLoaderCircle,
      lucideTriangleAlert,
    }),
  ],
  host: { class: 'contents' },
  template: `
    @if (shown()) {
      <section
        ofFadeIn
        data-testid="change-set-base-rewritten"
        class="border-warning/40 bg-warning-muted flex min-w-0 flex-col gap-3 rounded-xl border p-4"
        [attr.aria-labelledby]="headingId()"
      >
        <h2
          [id]="headingId()"
          class="text-foreground m-0 flex items-start gap-2 text-sm leading-5 font-medium break-words"
        >
          <ng-icon
            name="lucideTriangleAlert"
            class="text-warning mt-0.5 size-4 shrink-0"
            strokeWidth="1.5"
            aria-hidden="true"
          />
          {{
            'editor.changeSet.rewritten.title' | transloco: { ref: refLabel() }
          }}
        </h2>
        <p class="text-foreground m-0 text-sm leading-5 break-words">
          {{
            (mine()
              ? 'editor.changeSet.rewritten.message'
              : 'editor.changeSet.rewritten.messageOther'
            ) | transloco: { ref: refLabel() }
          }}
        </p>
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          @if (mine()) {
            <button
              z-button
              zSize="sm"
              type="button"
              data-testid="change-set-move"
              class="max-w-full"
              [ofGuard]="{
                permission: 'content.edit',
                blockedReason: blocked(),
              }"
              [attr.aria-busy]="busy() ? 'true' : null"
              (click)="move()"
            >
              <ng-icon
                [name]="busy() ? 'lucideLoaderCircle' : 'lucideGitBranchPlus'"
                data-icon="inline-start"
                strokeWidth="1.5"
                aria-hidden="true"
                [class.animate-spin]="busy()"
                class="motion-reduce:animate-none"
              />
              <span class="truncate">{{
                (busy()
                  ? 'editor.changeSet.rewritten.moving'
                  : 'editor.changeSet.rewritten.moveLong'
                ) | transloco: { ref: refLabel() }
              }}</span>
            </button>
          }
          @if (learnMore(); as href) {
            <a
              class="text-foreground hover:text-foreground/80 focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-2"
              [href]="href"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="change-set-rewritten-learn-more"
            >
              {{ 'editor.changeSet.rewritten.learnMore' | transloco }}
              <ng-icon
                name="lucideArrowUpRight"
                class="size-3.5"
                aria-hidden="true"
              />
              <span class="sr-only">{{
                'editor.changeSet.rewritten.newTab' | transloco
              }}</span>
            </a>
          }
        </div>
      </section>
    }
  `,
})
export class ChangeSetBaseRewrittenComponent {
  private readonly updates = inject(ChangeSetUpdate);
  private readonly lines = inject(MaintenanceLines);
  private readonly moves = inject(ChangeSetMove);
  private readonly help = inject(HelpService);
  private readonly me = inject(MeService);

  /** The change set; null: none chosen. */
  readonly changeSetId = input<string | null>(null);
  readonly title = input('');
  /** The branch it started from; '': as last read (`ChangeSetUpdate.baseRef`), else `main`. */
  readonly baseRef = input('');
  readonly state = input<ChangeSetState | null>(null);
  /** Its author's ID: only they move it (it closes the change set); others are told so. */
  readonly authorId = input('');
  /**
   * Whether its base was rewritten, when the screen read the change set itself
   * (`meta.base.state`); null: the notice reads it.
   */
  readonly rewritten = input<boolean | null>(null);

  protected readonly mine = computed(
    () => this.authorId() !== '' && this.authorId() === this.me.me().id,
  );
  protected readonly ref = computed(() => {
    const id = this.changeSetId();
    return (
      this.baseRef() || (id === null ? '' : this.updates.baseRef(id)) || 'main'
    );
  });
  /** The base as people read it: a maintenance line by its product version (#250). */
  protected readonly refLabel = computed(() => this.lines.label(this.ref()));
  protected readonly headingId = computed(
    () => `base-rewritten-${this.changeSetId() ?? 'none'}`,
  );
  protected readonly busy = computed(() => {
    const id = this.changeSetId();
    return id !== null && this.moves.busy(id);
  });
  protected readonly blocked = computed(() =>
    this.busy() ? 'editor.changeSet.rewritten.movingReason' : null,
  );
  protected readonly learnMore = computed(() =>
    this.help.href('guide.change-sets.base-rewritten'),
  );

  protected readonly shown = computed(() => {
    const id = this.changeSetId();
    const state = this.state();
    if (id === null || state === null || !OPEN.includes(state)) return false;
    return this.rewritten() ?? this.updates.rewritten(id);
  });

  constructor() {
    this.help.load();
    effect(() => {
      const id = this.changeSetId();
      const state = this.state();
      const told = this.rewritten();
      if (id === null || state === null || !OPEN.includes(state)) return;
      untracked(() => {
        if (told === null) {
          if (!this.updates.known(id)) void this.updates.check(id);
        }
      });
    });
  }

  protected move(): void {
    const id = this.changeSetId();
    if (id === null || this.busy() || !this.mine()) return;
    void this.moves.move({ id, title: this.title(), baseRef: this.ref() });
  }
}
