import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideCircleAlert,
  lucidePencil,
  lucideTrash2,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '@openfolia/ui/sortable-list';

import { CHECK_TITLES, type CheckCode } from '../checks/checks-model';
import type { ProjectConfig } from '../content/browser-model';
import type { Issue } from './manual-draft';
import {
  removeVersion,
  reorderSteps,
  stepGroups,
  stepIssues,
  versionRemovable,
  type PlacedStep,
  type UpdateGuide,
  type UpdateStep,
} from './update-guide';

/** A step as its row shows it. */
interface StepItem extends SortableItem {
  readonly index: number;
  readonly step: UpdateStep;
  readonly issues: readonly Issue[];
}

/** The phases' headings in the editor's language (the printed words are the output labels). */
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  before: 'editor.manuals.guide.phases.before',
  during: 'editor.manuals.guide.phases.during',
  after: 'editor.manuals.guide.phases.after',
};

/**
 * An update guide's steps (#908), in the manual builder in place of the outline: by version
 * (each a section that opens and closes), then by phase, and first the steps no version or phase
 * places yet. A step shows its module's title, its level, its condition and its checks' issues;
 * within a version and phase the steps are put in order by their grips (or Alt+Arrow keys). Every
 * change is the whole new guide in `guideChange`; editing and removing a step are the page's
 * (`edit`, `remove`: the step's index). Read-only, it shows the steps as they are. The guide's
 * versions are listed above, one no step needs taken out with its ×.
 */
@Component({
  selector: 'of-update-guide-steps',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    ZardBadgeComponent,
    ZardButtonComponent,
    CollapseComponent,
    SortableListComponent,
    SortableRowDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronDown,
      lucideCircleAlert,
      lucidePencil,
      lucideTrash2,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-3', 'data-testid': 'guide-steps' },
  template: `
    <div
      class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-2 text-xs text-muted-foreground"
      data-testid="guide-versions"
    >
      <span class="break-words">{{
        'editor.manuals.guide.follows'
          | transloco: { attribute: attributeLabel() }
      }}</span>
      <ul
        class="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0"
        [attr.aria-label]="'editor.manuals.guide.versions' | transloco"
      >
        @for (v of guide().versions; track v) {
          <li>
            <z-badge
              zType="outline"
              class="gap-0.5 font-normal tabular-nums"
              [attr.data-version]="v"
            >
              {{ v }}
              @if (editable() && removable(v)) {
                <button
                  type="button"
                  class="-me-1 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  [attr.aria-label]="
                    'editor.manuals.guide.removeVersion'
                      | transloco: { version: v }
                  "
                  [attr.title]="
                    'editor.manuals.guide.removeVersion'
                      | transloco: { version: v }
                  "
                  (click)="dropVersion(v)"
                >
                  <ng-icon name="lucideX" class="size-3" aria-hidden="true" />
                </button>
              }
            </z-badge>
          </li>
        }
      </ul>
    </div>

    @if (groups().unplaced.length > 0) {
      <section
        class="flex min-w-0 flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive-muted/40 p-2"
        data-testid="guide-unplaced"
        aria-labelledby="guide-unplaced-heading"
      >
        <h3
          id="guide-unplaced-heading"
          class="m-0 flex items-center gap-1.5 px-1 text-sm font-medium text-destructive"
        >
          <ng-icon name="lucideCircleAlert" class="size-4" aria-hidden="true" />
          {{ 'editor.manuals.guide.unplaced' | transloco }}
        </h3>
        <of-sortable-list
          [items]="items(groups().unplaced)"
          [readonly]="true"
          [label]="'editor.manuals.guide.unplaced' | transloco"
        >
          <ng-template ofSortableRow let-item>
            <ng-container
              *ngTemplateOutlet="stepRow; context: { $implicit: item }"
            />
          </ng-template>
        </of-sortable-list>
      </section>
    }

    @for (v of groups().versions; track v.version) {
      @let open = !closed().has(v.version);
      <section
        class="min-w-0 rounded-lg border border-border bg-card"
        [attr.data-version]="v.version"
        [attr.aria-labelledby]="'guide-version-' + v.version"
      >
        <h3 class="m-0">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            [id]="'guide-version-' + v.version"
            [attr.aria-expanded]="open"
            [attr.aria-controls]="'guide-version-body-' + v.version"
            (click)="toggle(v.version)"
          >
            <ng-icon
              name="lucideChevronDown"
              class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none"
              [class.-rotate-90]="!open"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 text-sm font-medium break-words">{{
              'editor.manuals.guide.version' | transloco: { version: v.version }
            }}</span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{
              'editor.manuals.guide.stepCount' | transloco: { count: v.count }
            }}</span>
          </button>
        </h3>
        <of-collapse [open]="open">
          <div
            class="flex min-w-0 flex-col gap-2 px-2 pb-2"
            [id]="'guide-version-body-' + v.version"
          >
            @for (p of v.phases; track p.phase) {
              <div class="flex min-w-0 flex-col" [attr.data-phase]="p.phase">
                <h4
                  class="m-0 px-1 pt-1 text-xs font-medium text-muted-foreground"
                >
                  {{ phaseLabel(p.phase) | transloco }}
                </h4>
                <of-sortable-list
                  [items]="items(p.steps)"
                  [readonly]="!editable()"
                  [label]="
                    'editor.manuals.guide.phaseList'
                      | transloco
                        : {
                            version: v.version,
                            phase: (phaseLabel(p.phase) | transloco),
                          }
                  "
                  (itemsChange)="reorder($event)"
                >
                  <ng-template ofSortableRow let-item>
                    <ng-container
                      *ngTemplateOutlet="stepRow; context: { $implicit: item }"
                    />
                  </ng-template>
                </of-sortable-list>
              </div>
            }
          </div>
        </of-collapse>
      </section>
    }

    <ng-template #stepRow let-item>
      @let s = asItem(item);
      <div
        class="group/step flex min-w-0 items-start gap-2 py-0.5"
        data-testid="guide-step"
        [attr.data-index]="s.index"
        [attr.data-module]="s.step.module"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            class="min-w-0 rounded-sm text-start text-sm break-words outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:no-underline"
            data-slot="step-title"
            [disabled]="!editable()"
            (click)="edit.emit(s.index)"
          >
            {{ s.label }}
          </button>
          @if (s.step.level || s.step.when || s.issues.length > 0) {
            <div class="flex min-w-0 flex-wrap gap-1">
              @if (s.step.level; as level) {
                <z-badge
                  zType="secondary"
                  class="max-w-full min-w-0 truncate font-normal"
                  data-slot="step-level"
                  >{{ levelLabel(level) }}</z-badge
                >
              }
              @if (s.step.when; as when) {
                <z-badge
                  zType="outline"
                  class="max-w-full min-w-0 truncate font-normal"
                  data-slot="step-condition"
                  [attr.title]="conditionText()(when)"
                  >{{ conditionText()(when) }}</z-badge
                >
              }
              @for (issue of s.issues; track $index) {
                <z-badge
                  [zType]="
                    issue.severity === 'error' ? 'destructive' : 'warning'
                  "
                  class="max-w-full min-w-0 truncate font-normal"
                  [attr.data-code]="issue.code"
                  [attr.data-severity]="issue.severity"
                  [attr.title]="issueTitle(issue.code) | transloco"
                >
                  <ng-icon
                    [name]="
                      issue.severity === 'error'
                        ? 'lucideCircleAlert'
                        : 'lucideTriangleAlert'
                    "
                    aria-hidden="true"
                  />
                  {{ issueTitle(issue.code) | transloco }}</z-badge
                >
              }
            </div>
          }
        </div>
        @if (editable()) {
          <div
            class="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/step:opacity-100 [@media(hover:hover)]:group-hover/step:opacity-100"
          >
            <button
              z-button
              zType="ghost"
              zSize="icon-xs"
              type="button"
              class="text-muted-foreground"
              data-action="step-edit"
              [attr.aria-label]="
                'editor.manuals.guide.editStep' | transloco: { title: s.label }
              "
              [attr.title]="
                'editor.manuals.guide.editStep' | transloco: { title: s.label }
              "
              (click)="edit.emit(s.index)"
            >
              <ng-icon name="lucidePencil" aria-hidden="true" />
            </button>
            <button
              z-button
              zType="ghost"
              zSize="icon-xs"
              type="button"
              class="text-muted-foreground hover:text-destructive"
              data-action="step-remove"
              [attr.aria-label]="
                'editor.manuals.guide.removeStep'
                  | transloco: { title: s.label }
              "
              [attr.title]="
                'editor.manuals.guide.removeStep'
                  | transloco: { title: s.label }
              "
              (click)="remove.emit(s.index)"
            >
              <ng-icon name="lucideTrash2" aria-hidden="true" />
            </button>
          </div>
        }
      </div>
    </ng-template>
  `,
})
export class UpdateGuideStepsComponent {
  readonly guide = input.required<UpdateGuide>();
  /** The configuration, its labels in the interface language. */
  readonly config = input.required<ProjectConfig>();
  readonly issues = input<readonly Issue[]>([]);
  readonly editable = input(false);
  /** A module's title (its ID until known). */
  readonly titleOf = input.required<(id: string) => string>();
  /** A condition in words, as the outline's chips read. */
  readonly conditionText = input.required<(when: unknown) => string>();
  readonly guideChange = output<UpdateGuide>();
  /** Edit the step at this index. */
  readonly edit = output<number>();
  /** Remove the step at this index. */
  readonly remove = output<number>();

  /** The versions whose section is closed (all open at first). */
  protected readonly closed = signal<ReadonlySet<string>>(new Set());

  protected readonly groups = computed(() => stepGroups(this.guide().steps));

  protected readonly attributeLabel = computed(() => {
    const id = this.guide().attribute;
    return (
      this.config().variantAttributes.find((a) => a.id === id)?.label ?? id
    );
  });

  /**
   * A key per step that follows it when steps move: the sortable list puts focus back, and the
   * rows are tracked, by this key. Steps keep their objects when reordered (`reorderSteps`).
   */
  private readonly keys = new WeakMap<UpdateStep, string>();
  private nextKey = 0;

  private keyOf(step: UpdateStep): string {
    let key = this.keys.get(step);
    if (key === undefined) {
      key = `step-${this.nextKey++}`;
      this.keys.set(step, key);
    }
    return key;
  }

  protected items(steps: readonly PlacedStep[]): StepItem[] {
    const issues = this.issues();
    const titleOf = this.titleOf();
    return steps.map(({ step, index }) => ({
      id: this.keyOf(step),
      label: titleOf(step.module),
      index,
      step,
      issues: stepIssues(issues, index),
    }));
  }

  protected asItem(item: unknown): StepItem {
    return item as StepItem;
  }

  protected removable(version: string): boolean {
    return versionRemovable(this.guide(), version);
  }

  protected phaseLabel(phase: string): string {
    return PHASE_LABELS[phase] ?? phase;
  }

  protected levelLabel(level: string): string {
    return this.config().audiences.find((a) => a.id === level)?.label ?? level;
  }

  protected issueTitle(code: string): string {
    return CHECK_TITLES[code as CheckCode] ?? code;
  }

  protected toggle(version: string): void {
    this.closed.update((closed) => {
      const next = new Set(closed);
      if (!next.delete(version)) next.add(version);
      return next;
    });
  }

  protected reorder(items: readonly SortableItem[]): void {
    if (!this.editable()) return;
    this.guideChange.emit(
      reorderSteps(
        this.guide(),
        items.map((i) => (i as StepItem).index),
      ),
    );
  }

  protected dropVersion(version: string): void {
    if (!this.editable() || !this.removable(version)) return;
    this.guideChange.emit(removeVersion(this.guide(), version));
  }
}
