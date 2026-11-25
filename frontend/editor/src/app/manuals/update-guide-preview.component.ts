import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { compareVersions } from '@openfolia/content-model/core';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardSelectImports } from '@openfolia/ui/select';

import type { ProjectConfig } from '../content/browser-model';
import { PHASE_LABELS } from './update-guide-steps.component';
import {
  defaultChoice,
  optionIds,
  previewOf,
  type UpdateGuide,
} from './update-guide';

/**
 * "Preview for" (#908): a reader's choice (the version they are on, the one they go to, their
 * level and options) and the steps they get, resolved exactly as the portal resolves them
 * (`resolveUpdateGuide`) from the guide as it is being written, before it is released. From and
 * to start at the guide's first and last version; a version no longer listed falls back to them.
 * The options are the enum attributes the guide's conditions name, each unset at first.
 */
@Component({
  selector: 'of-update-guide-preview',
  imports: [TranslocoPipe, ZardBadgeComponent, ZardSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3.5',
    'data-testid': 'guide-preview',
    role: 'region',
    'aria-labelledby': 'guide-preview-heading',
  },
  template: `
    <div class="flex min-w-0 flex-col gap-1">
      <h2 class="m-0 text-sm font-medium" id="guide-preview-heading">
        {{ 'editor.manuals.guide.preview.heading' | transloco }}
      </h2>
      <p class="m-0 text-xs break-words text-muted-foreground">
        {{ 'editor.manuals.guide.preview.hint' | transloco }}
      </p>
    </div>

    <div class="grid min-w-0 grid-cols-2 gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-xs text-muted-foreground">{{
          'editor.manuals.guide.preview.from' | transloco
        }}</span>
        <z-select
          zPosition="popper"
          data-testid="guide-preview-from"
          [zAriaLabel]="'editor.manuals.guide.preview.from' | transloco"
          [zValue]="choice().from"
          (zSelectionChange)="from.set(single($event))"
        >
          @for (v of guide().versions; track v) {
            <z-select-item [zValue]="v">{{ v }}</z-select-item>
          }
        </z-select>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-xs text-muted-foreground">{{
          'editor.manuals.guide.preview.to' | transloco
        }}</span>
        <z-select
          zPosition="popper"
          data-testid="guide-preview-to"
          [zAriaLabel]="'editor.manuals.guide.preview.to' | transloco"
          [zValue]="choice().to"
          (zSelectionChange)="to.set(single($event))"
        >
          @for (v of guide().versions; track v) {
            <z-select-item [zValue]="v">{{ v }}</z-select-item>
          }
        </z-select>
      </div>
      <div class="col-span-2 flex min-w-0 flex-col gap-1">
        <span class="text-xs text-muted-foreground">{{
          'editor.manuals.guide.preview.level' | transloco
        }}</span>
        <z-select
          zPosition="popper"
          data-testid="guide-preview-level"
          [zAriaLabel]="'editor.manuals.guide.preview.level' | transloco"
          [zPlaceholder]="'editor.manuals.guide.preview.everyLevel' | transloco"
          [zValue]="choice().level ?? ''"
          (zSelectionChange)="level.set(single($event))"
        >
          <z-select-item zValue="">{{
            'editor.manuals.guide.preview.everyLevel' | transloco
          }}</z-select-item>
          @for (a of levels(); track a.id) {
            <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
          }
        </z-select>
      </div>
      @for (o of options(); track o.id) {
        <div class="col-span-2 flex min-w-0 flex-col gap-1">
          <span class="text-xs break-words text-muted-foreground">{{
            o.label
          }}</span>
          <z-select
            zPosition="popper"
            [attr.data-option]="o.id"
            [zAriaLabel]="o.label"
            [zPlaceholder]="'editor.manuals.guide.preview.notSet' | transloco"
            [zValue]="picked()[o.id] ?? ''"
            (zSelectionChange)="setOption(o.id, single($event))"
          >
            <z-select-item zValue="">{{
              'editor.manuals.guide.preview.notSet' | transloco
            }}</z-select-item>
            @for (v of o.values; track v.id) {
              <z-select-item [zValue]="v.id">{{ v.label }}</z-select-item>
            }
          </z-select>
        </div>
      }
    </div>

    @let result = preview();
    <div
      class="flex min-w-0 flex-col gap-3 border-t border-border pt-3"
      data-testid="guide-preview-result"
      aria-live="polite"
    >
      @if (result.status === 'refused') {
        <p class="m-0 text-sm break-words text-muted-foreground">
          {{ 'editor.manuals.guide.preview.refused' | transloco }}
        </p>
      } @else if (result.reason === 'not-forward') {
        <p
          class="m-0 text-sm break-words text-muted-foreground"
          data-testid="guide-preview-not-forward"
        >
          {{ 'editor.manuals.guide.preview.notForward' | transloco }}
        </p>
      } @else if (result.count === 0) {
        <p
          class="m-0 text-sm break-words text-muted-foreground"
          data-testid="guide-preview-empty"
        >
          {{
            'editor.manuals.guide.preview.none'
              | transloco: { from: choice().from, to: choice().to }
          }}
        </p>
      } @else {
        <p
          class="m-0 text-xs text-muted-foreground"
          data-testid="guide-preview-count"
        >
          {{
            'editor.manuals.guide.preview.count'
              | transloco
                : { count: result.count, from: choice().from, to: choice().to }
          }}
        </p>
        @for (p of result.phases; track p.phase) {
          @if (p.steps.length > 0) {
            <section
              class="flex min-w-0 flex-col gap-1.5"
              [attr.data-phase]="p.phase"
            >
              <h3 class="m-0 text-xs font-medium">
                {{ phaseLabel(p.phase) | transloco }}
              </h3>
              <ol class="m-0 flex list-none flex-col gap-1 p-0">
                @for (s of p.steps; track s.index; let i = $index) {
                  <li
                    class="flex min-w-0 items-start gap-2 text-sm"
                    data-testid="guide-preview-step"
                    [attr.data-module]="s.step.module"
                  >
                    <span
                      class="mt-px w-5 shrink-0 text-end text-xs text-muted-foreground tabular-nums"
                      aria-hidden="true"
                      >{{ i + 1 }}.</span
                    >
                    <span class="min-w-0 flex-1 break-words">{{
                      titleOf()(s.step.module)
                    }}</span>
                    <z-badge
                      zType="outline"
                      class="shrink-0 font-normal tabular-nums"
                      >{{ s.version }}</z-badge
                    >
                  </li>
                }
              </ol>
            </section>
          }
        }
      }
    </div>
  `,
})
export class UpdateGuidePreviewComponent {
  readonly guide = input.required<UpdateGuide>();
  /** The configuration, its labels in the interface language. */
  readonly config = input.required<ProjectConfig>();
  /** The levels a reader picks from (the guide's audience and those less restricted). */
  readonly levels = input.required<readonly { id: string; label: string }[]>();
  /** A module's title (its ID until known). */
  readonly titleOf = input.required<(id: string) => string>();

  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly level = signal('');
  protected readonly picked = signal<Readonly<Record<string, string>>>({});

  /** The reader's choice: a version no longer in the guide falls back to the first or last. */
  protected readonly choice = computed(() => {
    const guide = this.guide();
    const fallback = defaultChoice(guide);
    const listed = (v: string) =>
      guide.versions.some((g) => compareVersions(g, v) === 0);
    const level = this.levels().some((l) => l.id === this.level())
      ? this.level()
      : undefined;
    return {
      from: this.from() && listed(this.from()) ? this.from() : fallback.from,
      to: this.to() && listed(this.to()) ? this.to() : fallback.to,
      level,
    };
  });

  /** The options a reader picks: the enum attributes the guide's conditions name. */
  protected readonly options = computed(() => {
    const ids = optionIds(this.guide().steps);
    return this.config().variantAttributes.flatMap((a) =>
      a.kind === 'enum' && ids.has(a.id) ? [a] : [],
    );
  });

  protected readonly preview = computed(() => {
    const options = Object.fromEntries(
      Object.entries(this.picked()).filter(([, v]) => v !== ''),
    );
    // The levels as the portal has them (up to the guide's audience): a step for one the
    // guide's audience leaves out is for no reader.
    return previewOf(
      this.guide(),
      { ...this.choice(), options },
      this.levels().map((l) => l.id),
    );
  });

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected setOption(id: string, value: string): void {
    this.picked.update((picked) => ({ ...picked, [id]: value }));
  }

  protected phaseLabel(phase: string): string {
    return PHASE_LABELS[phase] ?? phase;
  }
}
