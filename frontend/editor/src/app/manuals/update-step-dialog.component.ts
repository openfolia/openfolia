import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFilter, lucideX } from '@ng-icons/lucide';

import { VERSION_PATTERN } from '@openfolia/content-model/core';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSelectImports } from '@openfolia/ui/select';

import type { ProjectConfig } from '../content/browser-model';
import type { PickCondition } from './manual-settings-panel.component';
import { PHASE_LABELS } from './update-guide-steps.component';
import {
  formOf,
  knownVersion,
  PHASES,
  stepFormProblems,
  stepOf,
  stepVersions,
  type StepForm,
  type UpdateGuide,
  type UpdateStep,
} from './update-guide';

/** The version select's last choice: type a version the guide does not list yet. */
const OTHER_VERSION = '\u0000other';

/** What the dialog edits: a new step for a module (`index` null) or the step at `index`. */
export interface StepRequest {
  readonly index: number | null;
  readonly step: Partial<UpdateStep> & { readonly module: string };
  /** The module's title. */
  readonly title: string;
}

/**
 * A step of an update guide (#908): the version that needs it (one of the guide's, or a new
 * dotted version, which joins the guide's versions), its phase, and optionally the level it is
 * for and a condition on the reader's options, picked in the variant picker. The module is the
 * one chosen before. Saving hands the step over (`save`) and closes; the checks' rules for a
 * step are held here first (`stepFormProblems`), and said at each field once tried.
 */
@Component({
  selector: 'of-update-step-dialog',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    CollapseComponent,
    ZardDialogImports,
    ZardInputComponent,
    ZardRadioGroupImports,
    ZardSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideFilter, lucideX })],
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[32rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          (request()?.index === null
            ? 'editor.manuals.guide.form.addTitle'
            : 'editor.manuals.guide.form.editTitle'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>
          <span class="break-words">{{
            'editor.manuals.guide.form.description'
              | transloco: { title: request()?.title ?? '' }
          }}</span>
        </z-dialog-description>
      </z-dialog-header>
      @if (open() && request(); as req) {
        <form
          id="update-step-form"
          class="flex flex-col gap-5"
          novalidate
          data-testid="update-step-form"
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <span class="text-sm" id="update-step-version-label">{{
              'editor.manuals.guide.form.version' | transloco
            }}</span>
            <z-select
              zPosition="popper"
              data-testid="update-step-version"
              [zAriaLabel]="'editor.manuals.guide.form.version' | transloco"
              [zPlaceholder]="
                'editor.manuals.guide.form.versionPlaceholder' | transloco
              "
              [zInvalid]="!!problems().version && !typing()"
              [zValue]="versionChoice()"
              (zSelectionChange)="chooseVersion(single($event))"
            >
              @for (v of versions(); track v) {
                <z-select-item [zValue]="v">{{
                  'editor.manuals.guide.version' | transloco: { version: v }
                }}</z-select-item>
              }
              <z-select-item [zValue]="otherVersion">{{
                'editor.manuals.guide.form.otherVersion' | transloco
              }}</z-select-item>
            </z-select>
            <of-collapse [open]="typing()">
              <div class="flex flex-col gap-1.5 pt-1">
                <label class="sr-only" for="update-step-new-version">{{
                  'editor.manuals.guide.form.newVersion' | transloco
                }}</label>
                <input
                  id="update-step-new-version"
                  z-input
                  autocomplete="off"
                  inputmode="decimal"
                  maxlength="64"
                  [placeholder]="
                    'editor.manuals.guide.form.newVersionPlaceholder'
                      | transloco
                  "
                  [attr.aria-invalid]="problems().version ? 'true' : null"
                  aria-describedby="update-step-version-hint"
                  [value]="typed()"
                  (input)="typed.set($any($event.target).value)"
                />
              </div>
            </of-collapse>
            <p
              id="update-step-version-hint"
              class="m-0 text-xs break-words text-muted-foreground"
              [class.text-destructive]="!!problems().version"
              aria-live="polite"
            >
              @if (problems().version; as problem) {
                {{ problem | transloco: { first: firstVersion() } }}
              } @else {
                {{
                  'editor.manuals.guide.form.versionHint'
                    | transloco: { first: firstVersion() }
                }}
              }
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm" id="update-step-phase-label">{{
              'editor.manuals.guide.form.phase' | transloco
            }}</span>
            <z-radio-group
              class="flex flex-wrap gap-x-5 gap-y-2"
              data-testid="update-step-phase"
              aria-labelledby="update-step-phase-label"
              [value]="form().phase"
              (valueChange)="patch({ phase: asText($event) })"
            >
              @for (p of phaseOptions(); track p.value) {
                <label
                  class="flex min-w-0 cursor-pointer items-center gap-2 text-sm"
                  [attr.data-phase]="p.value"
                >
                  <z-radio
                    [value]="p.value"
                    [zId]="'update-step-phase-' + p.value"
                  />
                  <span class="min-w-0 break-words">{{ p.label }}</span>
                </label>
              }
            </z-radio-group>
            @if (problems().phase; as problem) {
              <p class="m-0 text-xs text-destructive" aria-live="polite">
                {{ problem | transloco }}
              </p>
            }
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.manuals.guide.form.level' | transloco
            }}</span>
            <z-select
              zPosition="popper"
              data-testid="update-step-level"
              [zAriaLabel]="'editor.manuals.guide.form.level' | transloco"
              [zPlaceholder]="
                'editor.manuals.guide.form.everyLevel' | transloco
              "
              [zValue]="form().level"
              (zSelectionChange)="patch({ level: single($event) })"
            >
              <z-select-item zValue="">{{
                'editor.manuals.guide.form.everyLevel' | transloco
              }}</z-select-item>
              @for (a of levels(); track a.id) {
                <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
              }
            </z-select>
            <p class="m-0 text-xs break-words text-muted-foreground">
              {{ 'editor.manuals.guide.form.levelHint' | transloco }}
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.manuals.guide.form.options' | transloco
            }}</span>
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              @if (form().when; as when) {
                <span
                  class="min-w-0 rounded-md border border-border px-2 py-1 text-sm break-words"
                  data-testid="update-step-condition"
                  >{{ conditionText()(when) }}</span
                >
              } @else {
                <span class="text-sm text-muted-foreground">{{
                  'editor.manuals.guide.form.everySetup' | transloco
                }}</span>
              }
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                data-testid="update-step-pick-condition"
                (click)="pick()"
              >
                <ng-icon
                  name="lucideFilter"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {{
                  (form().when
                    ? 'editor.manuals.guide.form.changeCondition'
                    : 'editor.manuals.guide.form.pickCondition'
                  ) | transloco
                }}
              </button>
              @if (form().when) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  data-testid="update-step-clear-condition"
                  (click)="patch({ when: null })"
                >
                  <ng-icon
                    name="lucideX"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{ 'editor.manuals.guide.form.clearCondition' | transloco }}
                </button>
              }
            </div>
          </div>
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.manuals.guide.form.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="update-step-form"
          data-testid="update-step-save"
        >
          {{
            (request()?.index === null
              ? 'editor.manuals.guide.form.add'
              : 'editor.manuals.guide.form.save'
            ) | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class UpdateStepDialogComponent {
  private readonly t = injectTranslate();

  readonly open = model(false);
  readonly request = input<StepRequest | null>(null);
  readonly guide = input.required<UpdateGuide>();
  /** The configuration, its labels in the interface language. */
  readonly config = input.required<ProjectConfig>();
  /** The levels a step can be for (the guide's audience and those less restricted). */
  readonly levels = input.required<readonly { id: string; label: string }[]>();
  readonly pickCondition = input.required<PickCondition>();
  /** A condition in words, as the outline's chips read. */
  readonly conditionText = input.required<(when: unknown) => string>();
  /** The step as saved, and where (null: added). */
  readonly save = output<{ index: number | null; step: UpdateStep }>();

  protected readonly otherVersion = OTHER_VERSION;
  protected readonly form = signal<StepForm>(formOf({ module: '' }));
  /** A new version is typed rather than picked. */
  protected readonly typing = signal(false);
  protected readonly typed = signal('');
  private readonly submitted = signal(false);

  protected readonly versions = computed(() => stepVersions(this.guide()));
  protected readonly firstVersion = computed(
    () => this.guide().versions[0] ?? '',
  );
  protected readonly versionChoice = computed(() =>
    this.typing() ? OTHER_VERSION : this.form().version,
  );
  protected readonly phaseOptions = computed(() =>
    PHASES.map((phase) => ({
      value: phase,
      label: this.t(PHASE_LABELS[phase] as string),
    })),
  );

  /** The form as it would be saved: a typed version in place of the one picked. */
  private readonly shown = computed((): StepForm =>
    this.typing() ? { ...this.form(), version: this.typed() } : this.form(),
  );

  /** The problems once saving was tried (none said before). */
  protected readonly problems = computed(() =>
    this.submitted() ? stepFormProblems(this.shown(), this.guide()) : {},
  );

  constructor() {
    // Every opening starts with the step asked for.
    effect(() => {
      if (!this.open()) return;
      const request = this.request();
      untracked(() => {
        const asked = formOf(request?.step ?? { module: '' });
        // A version the guide lists in another spelling (2.3.0 for 2.3) is picked in the guide's.
        const form = VERSION_PATTERN.test(asked.version)
          ? { ...asked, version: knownVersion(this.guide(), asked.version) }
          : asked;
        // A version the guide does not list (or none to pick) is typed.
        const listed = this.versions().includes(form.version);
        this.form.set(form);
        this.typing.set(form.version !== '' && !listed);
        this.typed.set(listed ? '' : form.version);
        this.submitted.set(false);
      });
    });
  }

  protected asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected patch(change: Partial<StepForm>): void {
    this.form.update((form) => ({ ...form, ...change }));
  }

  protected chooseVersion(value: string): void {
    if (value === OTHER_VERSION) {
      this.typing.set(true);
      return;
    }
    this.typing.set(false);
    this.patch({ version: value });
  }

  protected async pick(): Promise<void> {
    const request = this.request();
    if (!request) return;
    const pick = await this.pickCondition()(this.form().when ?? null, {
      title: this.t('editor.manuals.guide.form.pickTitle'),
      subtitle: this.t('editor.manuals.guide.form.pickSubtitle', {
        title: request.title,
      }),
    });
    if (!pick || !this.open()) return;
    this.patch({ when: pick === 'remove' ? null : pick });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    const request = this.request();
    const form = this.shown();
    const problems = stepFormProblems(form, this.guide());
    if (!request || Object.keys(problems).length > 0) return;
    this.save.emit({ index: request.index, step: stepOf(form, this.guide()) });
    this.open.set(false);
  }
}
