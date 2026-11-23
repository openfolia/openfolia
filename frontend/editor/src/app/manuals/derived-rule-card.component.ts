import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucidePlus,
  lucideRotateCw,
  lucideTriangleAlert,
  lucideUndo2,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardCommandImports } from '@openfolia/ui/command';
import { ZardPopoverImports } from '@openfolia/ui/popover';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSelectImports } from '@openfolia/ui/select';
import { RefreshingDirective } from '@openfolia/ui/smooth';
import {
  SortableListComponent,
  SortableRowDirective,
} from '@openfolia/ui/sortable-list';
import { SkeletonRowsComponent } from '@openfolia/ui/states';

import {
  DEFAULT_NOTICE_RULE,
  NOTICE_GROUPINGS,
  type NoticeGrouping,
  type SafetySeverity,
} from '@openfolia/content-model/core';
import { injectTranslate } from '@openfolia/ui/i18n';

import type { ProjectConfig } from '../content/browser-model';
import { CHECK_TITLES, type CheckCode } from '../checks/checks-model';
import {
  addMatter,
  gatheredLevels,
  gatheredTypeIds,
  gatheringOf,
  include,
  levelRows,
  mayGatherFrom,
  removeMatter,
  ruleIssues,
  setGathering,
  setGrouping,
  setLevels,
  setSource,
  setTypes,
  type Gathering,
  type LevelRow,
  type Matter,
  type SourceCandidate,
} from './derived-rule';
import type { DerivedRule, Issue } from './manual-draft';
import { ModuleChoices } from './module-choices';

/** What a rule gathers, as the card names it (#676). */
const GATHERING_LABELS: Readonly<Record<Gathering, string>> = {
  modules: 'editor.manuals.rule.gatherModules',
  notices: 'editor.manuals.rule.gatherNotices',
};

/** How a notice gathering groups its notices, as the card names it. */
const GROUPING_LABELS: Readonly<Record<NoticeGrouping, string>> = {
  module: 'editor.manuals.rule.groupByModule',
  level: 'editor.manuals.rule.groupByLevel',
};

/** The hazard levels' names in the editor's language (the printed words are the output labels). */
const LEVEL_LABELS: Readonly<Record<SafetySeverity, string>> = {
  danger: 'editor.manuals.rule.levels.danger',
  warning: 'editor.manuals.rule.levels.warning',
  caution: 'editor.manuals.rule.levels.caution',
  notice: 'editor.manuals.rule.levels.notice',
};

/** A row of the levels list: the level, its name and whether the rule gathers it. */
interface LevelItem extends LevelRow {
  readonly label: string;
}

/** A manual the source picker may offer. */
export interface SourceOption extends SourceCandidate {
  readonly title: string;
}

/**
 * A derived manual's rule (#451, #669), in its place in the manual builder: the manual it
 * gathers from (only assembled manuals for its audience or a wider one are offered; the API
 * refuses the rest), what it gathers (whole modules, or their safety notices grouped by source
 * module or hazard level, #676), the module types it gathers (none chosen: the configured safety
 * types; for notices, the types it searches, none chosen: every type), its
 * own front and back matter and the modules it leaves out, with the issues gathering found (as
 * the checks name them). Every change is the whole new rule in `ruleChange`; read-only, it shows
 * the rule as it is. Front and back matter are searched on the server, as the outline's add list.
 */
@Component({
  selector: 'of-derived-rule-card',
  imports: [
    TranslocoPipe,
    NgIcon,
    FormsModule,
    ZardButtonComponent,
    ZardCheckboxComponent,
    CollapseComponent,
    ZardCommandImports,
    ZardPopoverImports,
    ZardRadioGroupImports,
    ZardSelectImports,
    RefreshingDirective,
    SkeletonRowsComponent,
    SortableListComponent,
    SortableRowDirective,
  ],
  providers: [ModuleChoices],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleAlert,
      lucidePlus,
      lucideRotateCw,
      lucideTriangleAlert,
      lucideUndo2,
      lucideX,
    }),
  ],
  host: {
    class:
      'flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-xl border border-border bg-card p-3.5',
    'data-testid': 'derived-rule',
    role: 'region',
    'aria-labelledby': 'derived-rule-heading',
    tabindex: '-1',
  },
  template: `
    <div class="flex min-w-0 flex-col gap-1">
      <h2 class="m-0 text-sm font-medium" id="derived-rule-heading">
        {{ 'editor.manuals.rule.heading' | transloco }}
      </h2>
      <p class="m-0 text-xs break-words text-muted-foreground">
        {{ 'editor.manuals.rule.hint' | transloco }}
      </p>
    </div>

    @if (shownIssues().length > 0) {
      <ul
        class="m-0 flex list-none flex-col gap-1.5 p-0"
        data-testid="rule-issues"
        aria-live="polite"
      >
        @for (issue of shownIssues(); track $index) {
          <li
            class="flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-xs"
            [class]="
              issue.severity === 'error'
                ? 'border-destructive/30 bg-destructive-muted text-destructive'
                : 'border-warning/40 bg-warning-muted text-warning'
            "
            [attr.data-code]="issue.code"
            [attr.data-severity]="issue.severity"
          >
            <ng-icon
              [name]="
                issue.severity === 'error'
                  ? 'lucideCircleAlert'
                  : 'lucideTriangleAlert'
              "
              class="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0 break-words">
              <span class="sr-only">{{
                (issue.severity === 'error'
                  ? 'editor.manuals.rule.blocking'
                  : 'editor.manuals.rule.warning'
                ) | transloco
              }}</span>
              <span class="font-medium">{{
                issueTitle(issue.code) | transloco
              }}</span>
              @if (issue.at) {
                {{
                  'editor.manuals.rule.issueAt'
                    | transloco: { module: titleOf()(issue.at) }
                }}
              }
            </span>
          </li>
        }
      </ul>
    }

    <div class="flex min-w-0 flex-col gap-1.5">
      <span class="text-xs text-muted-foreground" id="rule-source-label">{{
        'editor.manuals.rule.source' | transloco
      }}</span>
      <z-select
        zSearchable
        zPosition="popper"
        data-testid="rule-source"
        [zAriaLabel]="'editor.manuals.rule.source' | transloco"
        [zPlaceholder]="'editor.manuals.rule.sourceNone' | transloco"
        [zDisabled]="!editable()"
        [zInvalid]="sourceInvalid()"
        [zValue]="rule().source"
        (zSelectionChange)="chooseSource($event)"
      >
        @for (m of sourceOptions(); track m.id) {
          <z-select-item [zValue]="m.id">{{ m.title }}</z-select-item>
        }
      </z-select>
      @if (sourceOptions().length === 0 && editable()) {
        <p
          class="m-0 text-xs text-muted-foreground"
          data-testid="rule-no-sources"
        >
          {{ 'editor.manuals.rule.noSources' | transloco }}
        </p>
      }
    </div>

    <fieldset
      class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      data-testid="rule-gathering"
    >
      <legend class="mb-1.5 p-0 text-xs text-muted-foreground">
        {{ 'editor.manuals.rule.gathering' | transloco }}
      </legend>
      <z-radio-group
        class="flex flex-col gap-2"
        [attr.aria-label]="'editor.manuals.rule.gathering' | transloco"
        [zDisabled]="!editable()"
        [value]="gathering()"
        (valueChange)="chooseGathering($event)"
      >
        @for (g of gatherings; track g) {
          <label
            class="flex min-w-0 cursor-pointer items-center gap-2 text-[0.8125rem]"
            [attr.data-gathering]="g"
          >
            <z-radio [value]="g" [zId]="'rule-gathering-' + g" />
            <span class="min-w-0 break-words">{{
              gatheringLabels[g] | transloco
            }}</span>
          </label>
        }
      </z-radio-group>
    </fieldset>

    <!-- The notice options open under the choice (issue 676); closed, they keep their last look. -->
    <of-collapse [open]="gathering() === 'notices'">
      <div
        class="flex min-w-0 flex-col gap-3 border-s-2 border-border ps-3 pb-1"
        data-testid="rule-notices"
      >
        <fieldset
          class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
          data-testid="rule-grouping"
        >
          <legend class="mb-1.5 p-0 text-xs text-muted-foreground">
            {{ 'editor.manuals.rule.grouping' | transloco }}
          </legend>
          <z-radio-group
            class="flex flex-col gap-2"
            [attr.aria-label]="'editor.manuals.rule.grouping' | transloco"
            [zDisabled]="!editable()"
            [value]="notices().groupBy"
            (valueChange)="chooseGrouping($event)"
          >
            @for (g of groupings; track g) {
              <label
                class="flex min-w-0 cursor-pointer items-center gap-2 text-[0.8125rem]"
                [attr.data-grouping]="g"
              >
                <z-radio [value]="g" [zId]="'rule-grouping-' + g" />
                <span class="min-w-0 break-words">{{
                  groupingLabels[g] | transloco
                }}</span>
              </label>
            }
          </z-radio-group>
        </fieldset>

        <div class="flex min-w-0 flex-col gap-1" data-testid="rule-levels">
          <span class="text-xs text-muted-foreground" id="rule-levels-label">{{
            'editor.manuals.rule.levelsLabel' | transloco
          }}</span>
          <of-sortable-list
            [items]="levels()"
            [label]="'editor.manuals.rule.levelsLabel' | transloco"
            [readonly]="!editable()"
            (itemsChange)="reorderLevels($event)"
          >
            <ng-template ofSortableRow let-item>
              <!-- As tall as the row's grip, so both sit on one line. -->
              <div class="mt-1.5 flex min-h-6 items-center text-[0.8125rem]">
                <z-checkbox
                  [attr.data-level]="item.id"
                  [zId]="'rule-level-' + item.id"
                  [zDisabled]="!editable() || lastLevel(item)"
                  [ngModel]="item.gathered"
                  [ngModelOptions]="{ standalone: true }"
                  (checkChange)="toggleLevel(item.id, $event)"
                  >{{ item.label }}</z-checkbox
                >
              </div>
            </ng-template>
          </of-sortable-list>
          <p
            class="m-0 text-xs break-words text-muted-foreground"
            data-testid="rule-levels-hint"
          >
            {{
              (notices().groupBy === 'level'
                ? 'editor.manuals.rule.levelsByLevel'
                : 'editor.manuals.rule.levelsByModule'
              ) | transloco
            }}
          </p>
        </div>
      </div>
    </of-collapse>

    <div class="flex min-w-0 flex-col gap-1.5">
      <span class="text-xs text-muted-foreground">{{
        (gathering() === 'notices'
          ? 'editor.manuals.rule.typesSearched'
          : 'editor.manuals.rule.types'
        ) | transloco
      }}</span>
      <z-select
        zMultiple
        zPosition="popper"
        data-testid="rule-types"
        [zMaxLabelCount]="3"
        [zAriaLabel]="
          (gathering() === 'notices'
            ? 'editor.manuals.rule.typesSearched'
            : 'editor.manuals.rule.types'
          ) | transloco
        "
        [zPlaceholder]="
          gathering() === 'notices'
            ? ('editor.manuals.rule.typesEvery' | transloco)
            : safetyLabels() || ('editor.manuals.rule.typesNone' | transloco)
        "
        [zDisabled]="!editable()"
        [zValue]="ownTypes()"
        (zSelectionChange)="chooseTypes($event)"
      >
        @for (t of config().moduleTypes; track t.id) {
          <z-select-item [zValue]="t.id">{{ t.label }}</z-select-item>
        }
      </z-select>
      <p
        class="m-0 text-xs break-words text-muted-foreground"
        data-testid="rule-types-hint"
      >
        {{ typesHint().key | transloco: typesHint().params }}
      </p>
    </div>

    @for (where of matters; track where) {
      <div
        class="flex min-w-0 flex-col gap-1.5"
        [attr.data-testid]="'rule-' + where"
      >
        <div class="flex min-w-0 items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">{{
            (where === 'front'
              ? 'editor.manuals.rule.front'
              : 'editor.manuals.rule.back'
            ) | transloco
          }}</span>
          @if (editable()) {
            <button
              z-button
              zType="ghost"
              zSize="sm"
              type="button"
              [attr.data-testid]="'rule-add-' + where"
              zPopover
              [zContent]="addPanel"
              zPlacement="bottom"
              zAlign="end"
              [zVisible]="adding() === where"
              (zVisibleChange)="toggleAdd(where, $event)"
            >
              <ng-icon
                name="lucidePlus"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.manuals.rule.add' | transloco }}
            </button>
          }
        </div>
        @if (rule()[where]; as ids) {
          @if (ids.length === 0) {
            <p class="m-0 text-xs text-muted-foreground">
              {{ 'editor.manuals.rule.none' | transloco }}
            </p>
          } @else {
            <ul class="m-0 flex list-none flex-col gap-1 p-0">
              @for (id of ids; track id) {
                <li class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
                  <span class="min-w-0 flex-1 break-words">{{
                    titleOf()(id)
                  }}</span>
                  @if (editable()) {
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon-xs"
                      type="button"
                      class="shrink-0 text-muted-foreground"
                      [attr.aria-label]="
                        'editor.manuals.rule.remove'
                          | transloco: { title: titleOf()(id) }
                      "
                      (click)="removeMatter(where, id)"
                    >
                      <ng-icon name="lucideX" aria-hidden="true" />
                    </button>
                  }
                </li>
              }
            </ul>
          }
        }
      </div>
    }

    <div class="flex min-w-0 flex-col gap-1.5" data-testid="rule-excluded">
      <span class="text-xs text-muted-foreground">{{
        'editor.manuals.rule.excluded' | transloco
      }}</span>
      @if (rule().exclude.length === 0) {
        <p class="m-0 text-xs text-muted-foreground">
          {{ 'editor.manuals.rule.noneExcluded' | transloco }}
        </p>
      } @else {
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          @for (id of rule().exclude; track id) {
            <li class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
              <span class="min-w-0 flex-1 break-words">{{
                titleOf()(id)
              }}</span>
              @if (editable()) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="shrink-0"
                  data-action="rule-include"
                  [attr.aria-label]="
                    'editor.manuals.rule.includeOf'
                      | transloco: { title: titleOf()(id) }
                  "
                  (click)="includeAgain(id)"
                >
                  <ng-icon
                    name="lucideUndo2"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{ 'editor.manuals.rule.include' | transloco }}
                </button>
              }
            </li>
          }
        </ul>
      }
    </div>

    <ng-template #addPanel>
      <z-popover class="w-80 max-w-[calc(100vw-2rem)] p-0">
        <z-command
          class="rounded-md"
          zShouldFilter="false"
          (zCommandSelected)="addChosen($any($event).value)"
        >
          <z-command-input
            [label]="'editor.manuals.add.search' | transloco"
            [placeholder]="'editor.manuals.add.search' | transloco"
            (valueChange)="choices.query.set($event)"
          />
          @let found = choices.state();
          <z-command-list
            class="max-h-72"
            data-testid="rule-add-list"
            [attr.aria-busy]="found.status === 'loading' || null"
          >
            @if (found.status === 'loading' && found.items.length === 0) {
              <of-skeleton-rows
                class="px-2 py-1"
                [count]="3"
                [label]="'editor.manuals.add.searching' | transloco"
              />
            } @else if (found.status === 'error') {
              <p class="px-2 py-1.5 text-sm text-destructive" role="alert">
                {{ 'editor.manuals.add.failed' | transloco }}
              </p>
              <z-command-option
                [zValue]="retryValue"
                [zLabel]="'editor.manuals.add.retry' | transloco"
                zIcon="lucideRotateCw"
              />
            }
            <div [ofRefreshing]="found.status === 'loading'">
              @for (s of addable(); track s.id) {
                <z-command-option
                  [zValue]="s.id"
                  [zLabel]="s.attributes.title"
                />
              }
            </div>
          </z-command-list>
        </z-command>
      </z-popover>
    </ng-template>
  `,
})
export class DerivedRuleCardComponent {
  readonly rule = input.required<DerivedRule>();
  readonly config = input.required<ProjectConfig>();
  /** The derived manual itself: its ID and audience decide which sources it may gather from. */
  readonly manual = input.required<{
    readonly id: string;
    readonly audience?: string | undefined;
  }>();
  /** The manuals on the branch (the picker offers those it may gather from). */
  readonly manuals = input<readonly SourceOption[]>([]);
  readonly issues = input<readonly Issue[]>([]);
  readonly editable = input(false);
  /** A module's title by its ID (its ID until known). */
  readonly titleOf = input<(id: string) => string>((id) => id);
  /** Modules the outline holds already: the front and back matter search leaves them out. */
  readonly inOutline = input<ReadonlySet<string>>(new Set());
  readonly ruleChange = output<DerivedRule>();

  protected readonly choices = inject(ModuleChoices);
  private readonly t = injectTranslate();
  protected readonly gatherings: readonly Gathering[] = ['modules', 'notices'];
  protected readonly gatheringLabels = GATHERING_LABELS;
  protected readonly groupings = NOTICE_GROUPINGS;
  protected readonly groupingLabels = GROUPING_LABELS;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly matters: readonly Matter[] = ['front', 'back'];
  protected readonly adding = signal<Matter | null>(null);
  protected readonly retryValue = ':retry';

  protected readonly shownIssues = computed(() => ruleIssues(this.issues()));

  /** What the picker offers: the manuals it may gather from, and the current source whatever it is. */
  protected readonly sourceOptions = computed((): readonly SourceOption[] => {
    const manual = this.manual();
    const config = this.config();
    const current = this.rule().source;
    return this.manuals().filter(
      (m) => m.id === current || mayGatherFrom(m, manual, config),
    );
  });

  protected readonly sourceInvalid = computed(() =>
    this.shownIssues().some(
      (i) =>
        i.code === 'unknown-source-manual' ||
        i.code === 'derived-source' ||
        i.code === 'derived-audience-wider',
    ),
  );

  /** The types the rule names itself; none: the configured safety types. */
  protected readonly ownTypes = computed(() => [
    ...(this.rule().moduleTypes ?? []),
  ]);

  protected readonly safetyLabels = computed(() => {
    const config = this.config();
    return gatheredTypeIds({ ...this.rule(), moduleTypes: undefined }, config)
      .map((id) => config.moduleTypes.find((t) => t.id === id)?.label ?? id)
      .join(', ');
  });

  /** What the rule gathers: whole modules or safety notices. */
  protected readonly gathering = computed(() => gatheringOf(this.rule()));

  /** The notice gathering as the options show it (closed for whole modules: the default's look). */
  protected readonly notices = computed(
    () => this.rule().notices ?? DEFAULT_NOTICE_RULE,
  );

  /** Every hazard level, those gathered first in their groups' order. */
  protected readonly levels = computed((): readonly LevelItem[] =>
    levelRows(this.notices()).map((row) => ({
      ...row,
      label: this.t(LEVEL_LABELS[row.id]),
    })),
  );

  /**
   * What the type field means now: for notices, the types searched, else every type; for whole
   * modules, the types chosen, else the configured safety types.
   */
  protected readonly typesHint = computed(
    (): { key: string; params: Record<string, string> } => {
      if (this.gathering() === 'notices') {
        return {
          key: this.rule().moduleTypes
            ? 'editor.manuals.rule.typesSearchedOwn'
            : 'editor.manuals.rule.typesSearchedEvery',
          params: {},
        };
      }
      if (this.rule().moduleTypes) {
        return { key: 'editor.manuals.rule.typesOwn', params: {} };
      }
      const types = this.safetyLabels();
      return types
        ? { key: 'editor.manuals.rule.typesSafety', params: { types } }
        : { key: 'editor.manuals.rule.typesNoSafety', params: {} };
    },
  );

  constructor() {
    effect(() => {
      const open = this.adding() !== null;
      untracked(() => (open ? this.choices.open() : this.choices.close()));
    });
  }

  /** The modules found that are in neither the outline nor the rule's own lists. */
  protected readonly addable = computed(() => {
    const rule = this.rule();
    const taken = new Set([...this.inOutline(), ...rule.front, ...rule.back]);
    return this.choices.state().items.filter((s) => !taken.has(s.id));
  });

  protected issueTitle(code: string): string {
    return CHECK_TITLES[code as CheckCode] ?? code;
  }

  /** Scrolls the card into view and moves the focus to it (a check's link). */
  reveal(): void {
    const el = this.host.nativeElement;
    el.scrollIntoView?.({ block: 'start' });
    el.focus({ preventScroll: true });
  }

  protected chooseSource(value: string | string[]): void {
    const id = Array.isArray(value) ? value[0] : value;
    if (!id || id === this.rule().source || !this.editable()) return;
    this.ruleChange.emit(setSource(this.rule(), id));
  }

  protected chooseTypes(value: string | string[]): void {
    if (!this.editable()) return;
    const types = Array.isArray(value) ? value : value ? [value] : [];
    const before = this.rule().moduleTypes ?? [];
    if (JSON.stringify(types) === JSON.stringify(before)) return;
    this.ruleChange.emit(setTypes(this.rule(), types));
  }

  protected chooseGathering(value: unknown): void {
    if (!this.editable() || (value !== 'modules' && value !== 'notices')) {
      return;
    }
    const next = setGathering(this.rule(), value);
    if (next !== this.rule()) this.ruleChange.emit(next);
  }

  protected chooseGrouping(value: unknown): void {
    const groupBy = NOTICE_GROUPINGS.find((g) => g === value);
    if (!this.editable() || !groupBy) return;
    const next = setGrouping(this.rule(), groupBy);
    if (next !== this.rule()) this.ruleChange.emit(next);
  }

  /** The only level gathered: it stays (a notice gathering takes one at least). */
  protected lastLevel(item: LevelRow): boolean {
    return item.gathered && gatheredLevels(this.levels()).length === 1;
  }

  protected toggleLevel(level: SafetySeverity, gathered: boolean): void {
    if (!this.editable()) return;
    this.changeLevels(
      this.levels().map((row) =>
        row.id === level ? { ...row, gathered } : row,
      ),
    );
  }

  protected reorderLevels(rows: readonly LevelItem[]): void {
    if (!this.editable()) return;
    this.changeLevels(rows);
  }

  private changeLevels(rows: readonly LevelRow[]): void {
    const next = setLevels(this.rule(), gatheredLevels(rows));
    if (JSON.stringify(next) !== JSON.stringify(this.rule())) {
      this.ruleChange.emit(next);
    }
  }

  protected toggleAdd(where: Matter, open: boolean): void {
    this.adding.set(
      open ? where : this.adding() === where ? null : this.adding(),
    );
  }

  protected addChosen(id: string | undefined): void {
    if (id === this.retryValue) {
      this.choices.reload();
      return;
    }
    const where = this.adding();
    this.adding.set(null);
    if (!id || !where || !this.editable()) return;
    this.ruleChange.emit(addMatter(this.rule(), where, id));
  }

  protected removeMatter(where: Matter, id: string): void {
    if (!this.editable()) return;
    this.ruleChange.emit(removeMatter(this.rule(), where, id));
  }

  protected includeAgain(id: string): void {
    if (!this.editable()) return;
    this.ruleChange.emit(include(this.rule(), id));
  }
}
