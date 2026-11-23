import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBookOpen, lucideFileText } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import type { Schema } from '../api';
import { languageName } from '../content/browser-model';
import { MODULE_ID, MODULE_ID_MAX, moduleIdOf } from '../content/module-id';
import { ModuleRename, type RenamePlan } from './module-rename';

type LockSubject = Schema<'LockSubject'>;

/**
 * "Change ID" in the module editor's Details card (#265): the new ID, prefilled from the
 * title's slug, and what the rename touches, read from the change set's head (the module's
 * languages, and every manual and module naming it, which it rewrites). "Change ID" hands the
 * new ID on (`rename`); the page saves, renames and opens the new address. Undo is the toast's.
 * The references are read while `active` (the panel open), kept on screen while read again.
 */
@Component({
  selector: 'of-module-rename-panel',
  imports: [
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSkeletonComponent,
  ],
  viewProviders: [provideIcons({ lucideBookOpen, lucideFileText })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    <div class="flex flex-col gap-1">
      <label for="module-new-id" class="text-muted-foreground text-xs">{{
        'editor.moduleEditor.rename.newId' | transloco
      }}</label>
      <input
        id="module-new-id"
        z-input
        class="font-mono"
        autocomplete="off"
        spellcheck="false"
        [attr.maxlength]="idMax"
        [attr.aria-invalid]="shownProblem() ? 'true' : null"
        [attr.aria-describedby]="
          shownProblem() ? 'module-new-id-problem' : null
        "
        [value]="next()"
        (input)="typed.set($any($event.target).value)"
        (keydown.enter)="submit()"
      />
      <of-collapse class="-mt-1" [open]="!!shownProblem()">
        <p id="module-new-id-problem" class="text-destructive m-0 pt-1 text-xs">
          @if (shownProblem(); as key) {
            {{ key | transloco }}
          }
        </p>
      </of-collapse>
    </div>

    <div class="flex flex-col gap-1.5" aria-live="polite">
      <of-collapse [open]="plan() === null && !failed()">
        <div role="status" aria-busy="true" class="flex flex-col gap-2">
          <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
          <z-skeleton class="h-4 w-2/3" />
          <z-skeleton class="h-4 w-1/2" />
        </div>
      </of-collapse>
      <of-collapse [open]="plan() !== null || failed()">
        @if (plan(); as p) {
          <p class="m-0 text-sm break-words" data-rename-summary>
            {{
              'editor.moduleEditor.rename.summary'
                | transloco
                  : {
                      languages: languages(p),
                      count: p.references.length,
                    }
            }}
          </p>
          @if (p.references.length) {
            <ul
              class="border-border m-0 mt-1.5 flex max-h-48 list-none flex-col gap-1 overflow-y-auto rounded-lg border p-2"
              [attr.aria-label]="
                'editor.moduleEditor.rename.references' | transloco
              "
            >
              @for (r of p.references; track key(r)) {
                <li class="flex items-start gap-2 text-sm" data-reference>
                  <ng-icon
                    [name]="
                      r.type === 'manual' ? 'lucideBookOpen' : 'lucideFileText'
                    "
                    class="text-muted-foreground mt-0.5 shrink-0"
                    size="16"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 font-mono text-xs break-all">{{
                    label(r)
                  }}</span>
                </li>
              }
            </ul>
          }
          @if (p.workingCopies.length) {
            <p class="text-muted-foreground m-0 mt-1.5 text-xs">
              {{
                'editor.moduleEditor.rename.workingCopies'
                  | transloco: { count: p.workingCopies.length }
              }}
            </p>
          }
        } @else if (failed()) {
          <p class="text-muted-foreground m-0 text-sm">
            {{ 'editor.moduleEditor.rename.referencesFailed' | transloco }}
          </p>
        }
      </of-collapse>
    </div>

    <div class="flex flex-wrap justify-end gap-2">
      <button
        z-button
        zType="ghost"
        zSize="sm"
        type="button"
        [zDisabled]="busy()"
        (click)="closed.emit()"
      >
        {{ 'editor.moduleEditor.rename.cancel' | transloco }}
      </button>
      <button
        z-button
        zSize="sm"
        type="button"
        data-rename-submit
        [zLoading]="busy()"
        [zDisabled]="!ready() || busy()"
        (click)="submit()"
      >
        {{ 'editor.moduleEditor.rename.submit' | transloco }}
      </button>
    </div>
  `,
})
export class ModuleRenamePanelComponent {
  private readonly renames = inject(ModuleRename);
  private readonly language = inject(LanguageService);

  readonly moduleId = input.required<string>();
  readonly title = input('');
  readonly changeSetId = input.required<string>();
  /** The panel is open: what the rename touches is read. */
  readonly active = input(true);
  /** A rename is under way. */
  readonly busy = input(false);
  /** "Change ID": the new ID. */
  readonly rename = output<string>();
  readonly closed = output<void>();

  protected readonly idMax = MODULE_ID_MAX;
  /** What the person typed; null: the title's slug. */
  protected readonly typed = signal<string | null>(null);
  protected readonly next = computed(
    () => this.typed() ?? (moduleIdOf(this.title()) || this.moduleId()),
  );
  protected readonly plan = signal<RenamePlan | null>(null);
  protected readonly failed = signal(false);

  /** Why the new ID cannot be taken (a translation key), or null. */
  protected readonly problem = computed((): string | null => {
    const id = this.next().trim();
    if (!id) return 'editor.moduleEditor.rename.idMissing';
    if (!MODULE_ID.test(id) || id.length > MODULE_ID_MAX) {
      return 'editor.moduleEditor.rename.idInvalid';
    }
    if (id === this.moduleId()) return 'editor.moduleEditor.rename.idSame';
    return null;
  });
  /**
   * The problem said under the field: the ID being the module's own only once the person typed,
   * so a title whose slug is the ID already opens the panel without an error.
   */
  protected readonly shownProblem = computed(() => {
    const problem = this.problem();
    return problem === 'editor.moduleEditor.rename.idSame' &&
      this.typed() === null
      ? null
      : problem;
  });
  protected readonly ready = computed(
    () => this.problem() === null && this.plan() !== null,
  );

  private reads = 0;

  constructor() {
    effect(() => {
      const active = this.active();
      const changeSetId = this.changeSetId();
      const moduleId = this.moduleId();
      if (!active) return;
      untracked(() => void this.read(changeSetId, moduleId));
    });
    // Another module: what was typed for the last one is not this one's.
    effect(() => {
      this.moduleId();
      untracked(() => this.typed.set(null));
    });
  }

  protected submit(): void {
    if (this.ready() && !this.busy()) this.rename.emit(this.next().trim());
  }

  protected languages(plan: RenamePlan): string {
    return plan.languages
      .map((l) => languageName(this.language.locale(), l))
      .join(', ');
  }

  protected key(subject: LockSubject): string {
    return subject.type === 'module'
      ? `module/${subject.lang}/${subject.moduleId}`
      : subject.type === 'manual'
        ? `manual/${subject.manualId}`
        : subject.type;
  }

  protected label(subject: LockSubject): string {
    return subject.type === 'module'
      ? `${subject.moduleId} (${subject.lang})`
      : subject.type === 'manual'
        ? subject.manualId
        : subject.type;
  }

  private async read(changeSetId: string, moduleId: string): Promise<void> {
    const run = ++this.reads;
    // A plan read before stays on screen while this one is read.
    try {
      const plan = await this.renames.references(changeSetId, moduleId);
      if (run !== this.reads) return;
      this.plan.set(plan);
      this.failed.set(false);
    } catch {
      if (run !== this.reads) return;
      this.plan.set(null);
      this.failed.set(true);
    }
  }
}
