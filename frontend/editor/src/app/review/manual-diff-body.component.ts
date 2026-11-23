import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import type { Schema } from '../api';
import type { Block } from './block-diff';
import { DiffFieldsComponent } from './diff-fields.component';
import {
  DiffOutlineComponent,
  type ModuleLink,
} from './diff-outline.component';
import { diffEntries, type EntryDiff } from './manual-diff';
import type { ShownConfig } from '../i18n';
import { manualFields, type FieldDiff } from './meta-diff';
import { DIFF_ITEM, type DiffItemContext } from './review-context';

type ManualAttributes = Schema<'ManualAttributes'>;

/** A manual's two versions: null where it is not there (added, removed, not visible). */
export interface ManualSides {
  readonly before: ManualAttributes | null;
  readonly after: ManualAttributes | null;
}

/** Two versions of a manual, compared: the details that differ and the outline's entries. */
export interface ManualComparison {
  readonly fields: readonly FieldDiff[];
  readonly entries: readonly EntryDiff[];
}

const NO_BLOCKS: readonly Block[] = [];

/** Compares two versions of a manual: what the diff below draws, and what a page counts. */
export function compareManual(
  sides: ManualSides,
  config: ShownConfig | null,
): ManualComparison {
  return {
    fields: manualFields(sides.before, sides.after, config),
    entries: diffEntries(
      sides.before?.entries ?? [],
      sides.after?.entries ?? [],
    ),
  };
}

/**
 * The difference between two versions of a manual, as the review screen draws it and the manual
 * history compares versions (one component for both, never a second diff): its details (title,
 * audience, variants, text attributes) as a table of before and after, and its outline as a tree
 * with the entries added, removed, moved and renamed marked. It provides what the outline reads
 * (`DIFF_ITEM`): the commits module titles are read at, in the source language, and the runs of
 * unchanged entries opened.
 */
@Component({
  selector: 'of-manual-diff-body',
  imports: [TranslocoPipe, DiffFieldsComponent, DiffOutlineComponent],
  providers: [
    {
      provide: DIFF_ITEM,
      useExisting: forwardRef(() => ManualDiffBodyComponent),
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @if (comparison().fields.length > 0) {
      <of-diff-fields [fields]="comparison().fields" />
    }
    @if (comparison().entries.length > 0) {
      <section class="flex min-w-0 flex-col gap-2">
        <h4 class="text-muted-foreground m-0 text-xs font-medium">
          {{ 'editor.review.outline.title' | transloco }}
        </h4>
        @if (anyEntryChange()) {
          <of-diff-outline
            [nodes]="comparison().entries"
            [all]="comparison().entries"
            [link]="link()"
          />
        } @else {
          <p class="text-muted-foreground m-0 text-sm">
            {{ 'editor.review.outline.unchanged' | transloco }}
          </p>
        }
      </section>
    }
  `,
})
export class ManualDiffBodyComponent implements DiffItemContext {
  /** Names the item (`manual/<id>`): the anchors of its entries. */
  readonly key = input.required<string>();
  /** The language module titles are read in (the source language). */
  readonly lang = input.required<string>();
  /** `compareManual(sides, config)`: the caller counts it too. */
  readonly comparison = input.required<ManualComparison>();
  /** The commits compared: module titles are read there. */
  readonly base = input.required<string>();
  readonly head = input.required<string>();
  /** The runs of unchanged entries opened, by their first entry's ID. */
  readonly open = input<ReadonlySet<string>>(new Set());
  /** Where a module's own diff is on this page. */
  readonly link = input<ModuleLink>(() => null);
  /** A run of unchanged entries was opened or closed. */
  readonly toggled = output<string>();

  readonly before = signal(NO_BLOCKS).asReadonly();
  readonly after = signal(NO_BLOCKS).asReadonly();
  /** A manual's outline takes no review threads (they are on a module's blocks). */
  readonly commentModule = signal<string | null>(null).asReadonly();

  toggle(run: string): void {
    this.toggled.emit(run);
  }

  protected readonly anyEntryChange = computed(() =>
    this.comparison().entries.some((n) => n.touched),
  );
}
