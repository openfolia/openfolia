import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { injectTranslate } from '../i18n/text.pipe';
import { TipCardComponent } from '../tip/tip-card.component';

import {
  CommentAnchorComponent,
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '../diff-marks/diff-marks.component';
import {
  contentStatuses,
  StatusBadgeComponent,
} from '../badges/status-badge.component';
import {
  LanguageBadgeComponent,
  translationStates,
} from '../badges/language-badge.component';
import {
  AdmonitionComponent,
  admonitionKinds,
} from '../blocks/admonition.component';
import {
  CalloutOverlayComponent,
  type CalloutOverlayMarker,
} from '../blocks/callout-overlay.component';
import { CodeBlockComponent } from '../blocks/code-block.component';
import { ImageBlockComponent } from '../blocks/image-block.component';
import { ModuleReferenceCardComponent } from '../blocks/module-reference-card.component';
import { PageBreakBlockComponent } from '../blocks/page-break-block.component';
import { PassthroughBlockComponent } from '../blocks/passthrough-block.component';
import { FaqEntryComponent } from '../blocks/faq-entry.component';
import { ProcedureBlockComponent } from '../blocks/procedure-block.component';
import {
  SafetyNoticeComponent,
  safetyLevels,
} from '../blocks/safety-notice.component';
import { SafetySymbolComponent } from '../blocks/safety-symbol.component';
import {
  VariantBlockComponent,
  type VariantCondition,
} from '../blocks/variant-block.component';
import {
  ModuleTreeComponent,
  ModuleTreeTrailingDirective,
} from '../module-tree/module-tree.component';
import { type ModuleTreeItem } from '../module-tree/module-tree.logic';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '../sortable-list/sortable-list.component';

const signalWords = {
  danger: 'ui.showcase.components.signal.danger',
  warning: 'ui.showcase.components.signal.warning',
  caution: 'ui.showcase.components.signal.caution',
  notice: 'ui.showcase.components.signal.notice',
} as const;

const admonitionWords = {
  note: 'ui.showcase.components.admonition.note',
  tip: 'ui.showcase.components.admonition.tip',
  important: 'ui.showcase.components.admonition.important',
} as const;

/** The sample outline: titles as keys, so the tree reads in the UI language. */
const TREE: readonly ModuleTreeItem[] = [
  { id: 'intro', title: 'ui.showcase.components.tree.intro', level: 0 },
  { id: 'safety', title: 'ui.showcase.components.tree.safety', level: 0 },
  { id: 'general', title: 'ui.showcase.components.tree.general', level: 1 },
  { id: 'symbols', title: 'ui.showcase.components.tree.symbols', level: 1 },
  { id: 'use', title: 'ui.showcase.components.tree.use', level: 0 },
  { id: 'start', title: 'ui.showcase.components.tree.start', level: 1 },
  { id: 'stop', title: 'ui.showcase.components.tree.stop', level: 1 },
  { id: 'care', title: 'ui.showcase.components.tree.care', level: 0 },
];

/** Badges, safety notice, variant block, module reference card, diff marks and the module tree. */
@Component({
  selector: 'of-components-showcase',
  imports: [
    TranslocoPipe,
    StatusBadgeComponent,
    LanguageBadgeComponent,
    SafetyNoticeComponent,
    SafetySymbolComponent,
    VariantBlockComponent,
    ImageBlockComponent,
    CalloutOverlayComponent,
    ModuleReferenceCardComponent,
    AdmonitionComponent,
    FaqEntryComponent,
    ProcedureBlockComponent,
    CodeBlockComponent,
    PageBreakBlockComponent,
    PassthroughBlockComponent,
    DiffInsertedComponent,
    DiffDeletedComponent,
    CommentAnchorComponent,
    ModuleTreeComponent,
    SortableListComponent,
    SortableRowDirective,
    ModuleTreeTrailingDirective,
    TipCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-8' },
  template: `
    <section class="flex flex-col gap-3" aria-labelledby="showcase-badges">
      <h2 id="showcase-badges" class="text-lg font-medium">
        {{ 'ui.showcase.components.badges' | transloco }}
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        @for (status of statuses; track status) {
          <of-status-badge [status]="status" />
        }
      </div>
      <div class="flex flex-wrap items-center gap-2">
        @for (state of states; track state) {
          <of-language-badge [state]="state" />
        }
      </div>
      <div class="flex flex-wrap items-center gap-2">
        @for (state of states; track state) {
          <of-language-badge [state]="state" language="de" display="chip" />
        }
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-blocks">
      <h2 id="showcase-blocks" class="text-lg font-medium">
        {{ 'ui.showcase.components.blocks' | transloco }}
      </h2>
      @for (level of levels; track level) {
        <of-safety-notice
          [level]="level"
          [signalWord]="words[level] | transloco"
          [hazard]="'ui.showcase.components.hazard' | transloco"
          [consequence]="'ui.showcase.components.consequence' | transloco"
          [measure]="'ui.showcase.components.measure' | transloco"
        />
      }
      <of-safety-notice
        level="notice"
        [signalWord]="words.notice | transloco"
        [hazard]="'ui.showcase.components.hazardOnly' | transloco"
      />
      <of-safety-notice
        level="caution"
        [signalWord]="words.caution | transloco"
        [hazard]="'ui.showcase.components.hazardOnly' | transloco"
      >
        <span header class="flex items-center gap-1.5">
          <of-safety-symbol
            [label]="'ui.showcase.components.symbol' | transloco"
            state="shown"
            src="assets/brand/openfolia-mark-color-light.svg"
          />
          <of-safety-symbol
            [label]="'ui.showcase.components.symbol' | transloco"
            state="loading"
          />
          <of-safety-symbol
            [label]="'ui.showcase.components.symbol' | transloco"
            state="missing"
          />
        </span>
      </of-safety-notice>
      <of-variant-block
        [conditions]="conditions"
        (pick)="picked.set(picked() + 1)"
      >
        <p class="m-0 text-sm">
          {{
            'ui.showcase.components.variantContent'
              | transloco: { count: picked() }
          }}
        </p>
      </of-variant-block>
      <of-variant-block [conditions]="[]" [editable]="false">
        <p class="m-0 text-sm">
          {{ 'ui.showcase.components.noCondition' | transloco }}
        </p>
      </of-variant-block>
      <of-image-block
        class="max-w-md"
        state="shown"
        [src]="picture"
        [alt]="'ui.showcase.components.calloutPicture' | transloco"
        [naturalWidth]="320"
        [naturalHeight]="200"
      >
        <of-callout-overlay
          ofImageOverlay
          [markers]="callouts()"
          [editable]="true"
          [adding]="true"
          [selected]="calloutSelected()"
          (selectedChange)="calloutSelected.set($event)"
          (add)="addCallout($event)"
          (move)="moveCallout($event)"
          (remove)="removeCallout($event)"
        />
      </of-image-block>
      <of-module-reference-card
        [title]="'ui.showcase.components.sharedModule' | transloco"
        [shared]="true"
        href="#showcase-blocks"
      />
      <of-module-reference-card
        [title]="'ui.showcase.components.otherBlock' | transloco"
        mode="block"
      />
      <of-module-reference-card
        [title]="'ui.showcase.components.longTitle' | transloco"
        mode="link"
      />
      @for (kind of admonitions; track kind) {
        <of-admonition
          [kind]="kind"
          [label]="admonitionWords[kind] | transloco"
        >
          <p class="m-0">
            {{ 'ui.showcase.components.admonition.text' | transloco }}
          </p>
        </of-admonition>
      }
      <of-faq-entry [label]="'ui.showcase.components.faq.label' | transloco">
        <p class="m-0 text-base font-semibold">
          {{ 'ui.showcase.components.faq.question' | transloco }}
        </p>
        <p class="m-0 mt-1">
          {{ 'ui.showcase.components.faq.answer' | transloco }}
        </p>
      </of-faq-entry>
      <of-procedure-block
        [label]="'ui.showcase.components.procedure.label' | transloco"
      >
        <ol class="m-0 list-decimal ps-5">
          <li>{{ 'ui.showcase.components.procedure.one' | transloco }}</li>
          <li>{{ 'ui.showcase.components.procedure.two' | transloco }}</li>
        </ol>
      </of-procedure-block>
      <of-code-block
        [label]="'ui.showcase.components.code.label' | transloco"
        language="yaml"
        >{{ code }}</of-code-block
      >
      <of-passthrough-block
        [label]="'ui.showcase.components.passthrough.label' | transloco"
        format="html"
        [source]="raw"
      />
      <of-page-break-block
        [label]="'ui.showcase.components.pageBreak' | transloco"
      />
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-diff">
      <h2 id="showcase-diff" class="text-lg font-medium">
        {{ 'ui.showcase.components.diff' | transloco }}
      </h2>
      <p class="m-0 text-sm">
        {{ 'ui.showcase.components.diffBefore' | transloco }}
        <del of-diff-deleted>{{
          'ui.showcase.components.diffOld' | transloco
        }}</del><ins of-diff-inserted>{{
          'ui.showcase.components.diffNew' | transloco
        }}</ins>
        {{ 'ui.showcase.components.diffMiddle' | transloco }}
        <button of-comment-anchor [count]="2">
          {{ 'ui.showcase.components.diffAnchor' | transloco }}
        </button>
        {{ 'ui.showcase.components.diffAfter' | transloco }}
      </p>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-tree">
      <h2 id="showcase-tree" class="text-lg font-medium">
        {{ 'ui.showcase.components.tree.heading' | transloco }}
      </h2>
      <p class="m-0 text-sm text-muted-foreground">
        {{ 'ui.showcase.components.tree.hint' | transloco }}
      </p>
      <div class="rounded-xl border border-border bg-card p-3">
        <of-module-tree [items]="shownTree()" (itemsChange)="moved($event)">
          <ng-template ofModuleTreeTrailing let-item>
            @if (item.id === 'general') {
              <of-status-badge status="draft" />
            } @else if (item.id === 'stop') {
              <of-status-badge status="in-review" />
            }
          </ng-template>
        </of-module-tree>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-sortable">
      <h2 id="showcase-sortable" class="text-lg font-medium">
        {{ 'ui.showcase.components.sortable.heading' | transloco }}
      </h2>
      <p class="m-0 text-sm text-muted-foreground">
        {{ 'ui.showcase.components.sortable.hint' | transloco }}
      </p>
      <div class="rounded-xl border border-border bg-card p-3">
        <of-sortable-list
          [items]="sortable()"
          [label]="'ui.showcase.components.sortable.heading' | transloco"
          (itemsChange)="sortable.set($event)"
        >
          <ng-template ofSortableRow let-item>
            <span class="text-sm leading-9">{{ item.label }}</span>
          </ng-template>
        </of-sortable-list>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-tips">
      <h2 id="showcase-tips" class="text-lg font-medium">
        {{ 'ui.showcase.components.tips.heading' | transloco }}
      </h2>
      <div class="flex flex-wrap items-start gap-4">
        <of-tip-card [content]="tip" />
        <of-tip-card [content]="tourStep" />
      </div>
    </section>
  `,
})
export class ComponentsShowcaseComponent {
  /** A tip and a tour's step, as `TipOverlay` shows them beside what they explain. */
  protected readonly tip = {
    id: 'showcase.tip',
    title: 'ui.showcase.components.tips.title',
    body: 'ui.showcase.components.tips.body',
    learnMore: { href: 'https://example.org/guide', title: 'Guide' },
  };
  protected readonly tourStep = {
    id: 'showcase.step',
    title: 'ui.showcase.components.tips.stepTitle',
    body: 'ui.showcase.components.tips.stepBody',
    step: { index: 2, total: 5 },
  };
  protected readonly statuses = contentStatuses;
  protected readonly states = translationStates;
  protected readonly levels = safetyLevels;
  protected readonly words = signalWords;
  protected readonly picked = signal(0);
  /** A plain grey picture for the callouts to sit on. */
  protected readonly picture =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill-opacity="0.15"/></svg>',
    );
  protected readonly callouts = signal<CalloutOverlayMarker[]>([
    {
      id: 'a',
      number: 1,
      anchor: { x: 0.25, y: 0.4 },
      label: null,
      legend: '',
    },
    {
      id: 'b',
      number: 2,
      anchor: { x: 0.6, y: 0.6 },
      label: { x: 0.8, y: 0.25 },
      legend: '',
    },
    {
      id: 'c',
      number: null,
      anchor: { x: 0.4, y: 0.8 },
      label: null,
      legend: '',
    },
  ]);
  protected readonly calloutSelected = signal<string | null>(null);
  protected addCallout(point: { x: number; y: number }): void {
    this.callouts.update((list) => [
      ...list,
      {
        id: `n${list.length}`,
        number: list.length + 1,
        anchor: point,
        label: null,
        legend: '',
      },
    ]);
  }
  protected moveCallout(move: {
    id: string;
    which: 'anchor' | 'label';
    point: { x: number; y: number };
  }): void {
    this.callouts.update((list) =>
      list.map((m) =>
        m.id === move.id ? { ...m, [move.which]: move.point } : m,
      ),
    );
  }
  protected removeCallout(id: string): void {
    this.callouts.update((list) => list.filter((m) => m.id !== id));
  }
  protected readonly admonitions = admonitionKinds;
  protected readonly admonitionWords = admonitionWords;
  protected readonly code = 'name: first-project\nmembers:\n  - lead';
  protected readonly raw = '<table class="legacy"><tr><td>1</td></tr></table>';
  protected readonly conditions: VariantCondition[] = [
    { attribute: 'size', values: ['small', 'medium'] },
    { attribute: 'region', values: ['north'] },
  ];
  private readonly t = injectTranslate();
  /** The outline with its title keys; the tree shows them translated. */
  private readonly tree = signal<readonly ModuleTreeItem[]>(TREE);
  protected readonly sortable = signal<readonly SortableItem[]>(
    TREE.slice(0, 4).map(({ id, title }) => ({ id, label: title })),
  );
  protected readonly shownTree = computed(() =>
    this.tree().map((item) => ({ ...item, title: this.t(item.title) })),
  );

  /** Keeps the new order and levels, with the title keys of the original items. */
  protected moved(next: readonly ModuleTreeItem[]): void {
    const keys = new Map(this.tree().map((item) => [item.id, item.title]));
    this.tree.set(
      next.map((item) => ({ ...item, title: keys.get(item.id) ?? item.title })),
    );
  }
}
