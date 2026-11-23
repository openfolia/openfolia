import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import type { Schema } from '../api';
import { diffBlocks, type Block, type BlockDiff } from './block-diff';
import { DiffFieldsComponent } from './diff-fields.component';
import { DiffNodesComponent, type ListMode } from './diff-nodes.component';
import { DiffRenderedComponent } from './diff-rendered.component';
import { ModuleCommentsComponent } from './module-comments.component';
import type { ShownConfig } from '../i18n';
import { moduleFields, type FieldDiff } from './meta-diff';
import { DIFF_ITEM, type DiffItemContext } from './review-context';

/** How the difference is shown. */
export type DiffView = 'inline' | 'side' | 'rendered';

type ModuleAttributes = Schema<'ModuleAttributes'>;

/** A module's two versions: null where it is not there (added, removed, not visible). */
export interface ModuleSides {
  readonly before: ModuleAttributes | null;
  readonly after: ModuleAttributes | null;
}

/** Two versions of a module, compared: the details that differ and the blocks matched by ID. */
export interface ModuleComparison {
  readonly fields: readonly FieldDiff[];
  readonly nodes: readonly BlockDiff[];
}

const NO_BLOCKS: readonly Block[] = [];

/** Compares two versions of a module: what the diff below draws, and what a page counts. */
export function compareModule(
  sides: ModuleSides,
  config: ShownConfig | null,
): ModuleComparison {
  return {
    fields: moduleFields(sides.before, sides.after, config),
    nodes: diffBlocks(
      sides.before?.blocks ?? NO_BLOCKS,
      sides.after?.blocks ?? NO_BLOCKS,
    ),
  };
}

/**
 * The difference between two versions of a module, as the review screen draws it and the
 * history compares versions (one component for both, never a second diff): the details as a
 * table of before and after, then the blocks with the real block components (`of-diff-nodes`),
 * inline, side by side, or rendered (the newer version as a reader sees it, each change marked
 * at its edge). It provides what the drawn blocks read (`DIFF_ITEM`): the two sides, the commits
 * images and the rendered page are read at, the runs of unchanged blocks opened, and the module
 * whose review threads show (none: no comments, as in the history).
 */
@Component({
  selector: 'of-module-diff-body',
  imports: [
    TranslocoPipe,
    DiffFieldsComponent,
    DiffNodesComponent,
    DiffRenderedComponent,
    ModuleCommentsComponent,
  ],
  providers: [
    {
      provide: DIFF_ITEM,
      useExisting: forwardRef(() => ModuleDiffBodyComponent),
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @if (comparison().fields.length > 0) {
      <of-diff-fields [fields]="comparison().fields" />
    }
    @if (!anyBlockChange()) {
      <p class="text-muted-foreground m-0 text-sm">
        {{
          (comparison().fields.length > 0
            ? 'editor.review.diff.onlyDetails'
            : 'editor.review.diff.noBlocks'
          ) | transloco
        }}
      </p>
    } @else {
      @if (mode() === 'side') {
        <div
          class="text-muted-foreground grid grid-cols-2 gap-x-4 text-xs font-medium"
        >
          <span class="ps-4 break-words">{{
            beforeLabel() ?? ('editor.review.diff.before' | transloco)
          }}</span>
          <span class="ps-4 break-words">{{
            afterLabel() ?? ('editor.review.diff.after' | transloco)
          }}</span>
        </div>
      }
      @if (mode() === 'rendered') {
        <of-diff-rendered
          [moduleId]="moduleId()"
          [nodes]="comparison().nodes"
        />
      } @else {
        <of-diff-nodes [nodes]="comparison().nodes" [mode]="mode()" />
      }
    }
    @if (commentModule(); as module) {
      <of-module-comments [module]="module" [nodes]="comparison().nodes" />
    }
  `,
})
export class ModuleDiffBodyComponent implements DiffItemContext {
  /** Names the item (`module/<lang>/<id>`): the anchors of its blocks. */
  readonly key = input.required<string>();
  readonly lang = input.required<string>();
  readonly moduleId = input.required<string>();
  readonly sides = input.required<ModuleSides>();
  /** `compareModule(sides, config)`: the caller counts it too. */
  readonly comparison = input.required<ModuleComparison>();
  /** The commits compared: images, references and the rendered page are read there. */
  readonly base = input.required<string>();
  readonly head = input.required<string>();
  readonly view = input<DiffView>('inline');
  /** The runs of unchanged blocks opened, by their first block's ID. */
  readonly open = input<ReadonlySet<string>>(new Set());
  /** The module whose review threads show (`<lang>/<moduleId>`); null: none. */
  readonly commentModule = input<string | null>(null);
  /** The columns' names side by side; Before and After when not given. */
  readonly beforeLabel = input<string | null>(null);
  readonly afterLabel = input<string | null>(null);
  /** A run of unchanged blocks was opened or closed. */
  readonly toggled = output<string>();

  readonly before = computed(() => this.sides().before?.blocks ?? NO_BLOCKS);
  readonly after = computed(() => this.sides().after?.blocks ?? NO_BLOCKS);

  toggle(run: string): void {
    this.toggled.emit(run);
  }

  protected readonly anyBlockChange = computed(
    () =>
      this.comparison().nodes.length > 0 &&
      this.comparison().nodes.some((n) => n.touched),
  );

  /** A module with no newer version (deleted) has nothing to render: shown inline instead. */
  protected readonly mode = computed((): ListMode =>
    this.view() === 'rendered' && !this.sides().after ? 'inline' : this.view(),
  );
}
