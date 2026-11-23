import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  viewChildren,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDownWideNarrow,
  lucideCheck,
  lucideMapPin,
  lucidePlus,
  lucideSplit,
  lucideSpline,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate } from '@openfolia/ui/i18n';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '@openfolia/ui/sortable-list';

import {
  CalloutLegendFieldComponent,
  type LegendJson,
} from './callout-legend-field.component';
import type { EditorCallout } from './callouts';
import { conditionChips, DOC_BLOCKS } from './doc-blocks-context';

/** A callout's row: the sortable list's item, with the callout it shows. */
interface CalloutRow extends SortableItem {
  readonly callout: EditorCallout;
}

/**
 * The image's callouts beside the picture (#547): a header (how many, the variant they are
 * numbered in, "Edit callouts" / "Done", "Add callout") and, while editing, every callout in
 * number order: its number, its legend (edited in place in the selected row:
 * `of-callout-legend-field`), its variant condition (the page's variant picker), its leader
 * line and Delete. A row moved by its grip (or Alt+Arrow) puts the callouts in the author's
 * order; "Number in reading order" goes back. Hovering or focusing a row names its callout
 * (`hoverChange`), and the `highlighted` one's row is outlined (#549). It owns no data: it emits what the person asks
 * for, and the image's node view changes the document.
 */
@Component({
  selector: 'of-callout-panel',
  imports: [
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
    CollapseComponent,
    SortableListComponent,
    SortableRowDirective,
    CalloutLegendFieldComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideArrowDownWideNarrow,
      lucideCheck,
      lucideMapPin,
      lucidePlus,
      lucideSplit,
      lucideSpline,
      lucideTrash2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col gap-1 px-1 text-xs',
    'data-node-view-control': '',
    'data-slot': 'callout-panel',
  },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <ng-icon
        name="lucideMapPin"
        class="text-muted-foreground shrink-0"
        size="12"
        aria-hidden="true"
      />
      <span class="font-medium" data-slot="callout-count">{{
        'editor.docEditor.callouts.count'
          | transloco: { count: callouts().length }
      }}</span>
      @if (callouts().length > 0) {
        <span
          class="text-muted-foreground min-w-0 break-words"
          data-slot="callout-variant"
          >{{ variantText() }}</span
        >
      }
      <span class="ms-auto flex flex-wrap items-center gap-1">
        @if (editing()) {
          <button
            z-button
            type="button"
            zType="ghost"
            zSize="sm"
            data-action="add-callout"
            [disabled]="full()"
            (click)="add.emit()"
          >
            <ng-icon name="lucidePlus" aria-hidden="true" />
            {{ 'editor.docEditor.callouts.add' | transloco }}
          </button>
        }
        <button
          z-button
          type="button"
          zType="outline"
          zSize="sm"
          data-action="edit-callouts"
          [attr.aria-pressed]="editing()"
          (click)="editing.set(!editing())"
        >
          <ng-icon
            [name]="editing() ? 'lucideCheck' : 'lucideMapPin'"
            aria-hidden="true"
          />
          {{
            (editing()
              ? 'editor.docEditor.callouts.done'
              : 'editor.docEditor.callouts.edit'
            ) | transloco
          }}
        </button>
      </span>
    </div>
    <of-collapse [open]="editing()">
      @if (editing()) {
        <p class="text-muted-foreground m-0 py-1 break-words">
          {{ 'editor.docEditor.callouts.hint' | transloco }}
        </p>
        @if (rows().length > 0) {
          <of-sortable-list
            [items]="rows()"
            [label]="'editor.docEditor.callouts.list' | transloco"
            (itemsChange)="reorder.emit(ids($event))"
          >
            <ng-template ofSortableRow let-item>
              @let c = asRow(item).callout;
              <div
                class="flex min-w-0 flex-col gap-1 rounded-md outline-offset-2 motion-safe:transition-[outline-color,background-color] motion-safe:duration-150"
                [attr.data-callout-row]="c.id"
                [attr.data-highlighted]="highlighted() === c.id ? '' : null"
                [class.outline-2]="highlighted() === c.id"
                [class.outline-ring]="highlighted() === c.id"
                [class.outline-solid]="highlighted() === c.id"
                [class.bg-accent]="highlighted() === c.id"
                (pointerenter)="hoverChange.emit(c.id)"
                (pointerleave)="hoverChange.emit(null)"
                (focusin)="hoverChange.emit(c.id)"
                (focusout)="hoverChange.emit(null)"
              >
                <div class="flex min-w-0 items-start gap-2">
                  <span
                    class="mt-1 inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border-2 px-1 text-xs font-semibold tabular-nums"
                    data-slot="callout-number"
                    [class.border-transparent]="c.number !== null"
                    [class.bg-primary]="c.number !== null"
                    [class.text-primary-foreground]="c.number !== null"
                    [class.border-dashed]="c.number === null"
                    [class.text-muted-foreground]="c.number === null"
                    aria-hidden="true"
                    >{{ c.number ?? '–' }}</span
                  >
                  @if (selected() === c.id) {
                    <of-callout-legend-field
                      class="flex-1"
                      [legend]="legendOf(c)"
                      [label]="nameOf(c)"
                      [autofocus]="focusLegend() === c.id"
                      (legendChange)="legend.emit({ id: c.id, legend: $event })"
                      (done)="legendDone.emit(c.id)"
                    />
                  } @else {
                    <button
                      type="button"
                      class="hover:bg-muted focus-visible:ring-ring/50 min-h-8 min-w-0 flex-1 rounded-md px-2 py-1 text-start text-sm outline-none focus-visible:ring-2 [overflow-wrap:anywhere]"
                      data-slot="callout-legend-text"
                      [class.text-muted-foreground]="!c.text"
                      [attr.aria-label]="nameOf(c)"
                      (click)="selected.set(c.id)"
                    >
                      {{
                        c.text ||
                          ('editor.docEditor.callouts.noLegend' | transloco)
                      }}
                    </button>
                  }
                  <button
                    z-button
                    type="button"
                    zType="ghost"
                    zSize="icon-sm"
                    class="shrink-0"
                    data-action="delete-callout"
                    [attr.aria-label]="
                      'editor.docEditor.callouts.delete'
                        | transloco: { number: c.number ?? '–' }
                    "
                    (click)="remove.emit(c.id)"
                  >
                    <ng-icon name="lucideTrash2" aria-hidden="true" />
                  </button>
                </div>
                <of-collapse [open]="selected() === c.id">
                  <div class="flex flex-wrap items-center gap-1.5 ps-8 pb-1">
                    @for (chip of chipsOf(c); track chip.attribute) {
                      <span
                        class="border-border bg-background text-foreground inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 break-all"
                        data-chip
                      >
                        <span class="text-muted-foreground"
                          >{{ chip.attribute }}:</span
                        >
                        {{ chip.values.join(', ') }}
                      </span>
                    } @empty {
                      <span class="text-muted-foreground">{{
                        'editor.docEditor.callouts.everyVariant' | transloco
                      }}</span>
                    }
                    <button
                      z-button
                      type="button"
                      zType="ghost"
                      zSize="sm"
                      data-action="callout-variants"
                      [disabled]="!canPickVariant()"
                      (click)="conditions.emit(c.id)"
                    >
                      <ng-icon name="lucideSplit" aria-hidden="true" />
                      {{ 'editor.docEditor.callouts.variants' | transloco }}
                    </button>
                    <button
                      z-button
                      type="button"
                      zType="ghost"
                      zSize="sm"
                      data-action="callout-leader"
                      [attr.aria-pressed]="c.label !== null"
                      (click)="leader.emit({ id: c.id, on: c.label === null })"
                    >
                      <ng-icon name="lucideSpline" aria-hidden="true" />
                      {{ 'editor.docEditor.callouts.leader' | transloco }}
                    </button>
                  </div>
                </of-collapse>
              </div>
            </ng-template>
          </of-sortable-list>
        }
        @if (manual()) {
          <div class="flex flex-wrap items-center gap-2 py-1">
            <span class="text-muted-foreground">{{
              'editor.docEditor.callouts.manualOrder' | transloco
            }}</span>
            <button
              z-button
              type="button"
              zType="ghost"
              zSize="sm"
              data-action="reading-order"
              (click)="readingOrder.emit()"
            >
              <ng-icon name="lucideArrowDownWideNarrow" aria-hidden="true" />
              {{ 'editor.docEditor.callouts.readingOrder' | transloco }}
            </button>
          </div>
        }
      }
    </of-collapse>
  `,
})
export class CalloutPanelComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly t = injectTranslate();
  private readonly fields = viewChildren(CalloutLegendFieldComponent);

  /** The image's callouts, in number order over every variant. */
  readonly callouts = input.required<readonly EditorCallout[]>();
  /** Whether the image numbers them in the author's order. */
  readonly manual = input(false);
  /** Whether the image holds as many as the model allows. */
  readonly full = input(false);
  /** The callout whose legend takes the focus once it shows (one just added). */
  readonly focusLegend = input<string | null>(null);
  /** Whether the callouts are being edited (the picture takes clicks, the list shows). */
  readonly editing = model(false);
  readonly selected = model<string | null>(null);
  /**
   * The highlighted callout (#549): its marker or a reference to it is hovered or focused. Its
   * row gets an outline and a background, never colour alone (and no change of weight, so
   * nothing moves).
   */
  readonly highlighted = input<string | null>(null);

  readonly add = output<void>();
  readonly remove = output<string>();
  readonly reorder = output<string[]>();
  readonly readingOrder = output<void>();
  readonly legend = output<{ id: string; legend: LegendJson }>();
  readonly legendDone = output<string>();
  readonly conditions = output<string>();
  readonly leader = output<{ id: string; on: boolean }>();
  /** The callout whose row is under the pointer or holds the focus, or null once it leaves. */
  readonly hoverChange = output<string | null>();

  protected readonly rows = computed((): CalloutRow[] =>
    this.callouts().map((callout) => {
      const name = this.t('editor.docEditor.callouts.row', {
        number: callout.number ?? '–',
      });
      return {
        id: callout.id,
        label: callout.text ? `${name}: ${callout.text}` : name,
        callout,
      };
    }),
  );

  protected readonly variantText = computed(() => {
    const variant = this.blocks.settings().variant;
    return variant
      ? this.t('editor.docEditor.callouts.inVariant', {
          variant: variant.label,
        })
      : this.t('editor.docEditor.callouts.allVariants');
  });

  protected readonly canPickVariant = computed(
    () => !!this.blocks.settings().pickVariant,
  );

  protected asRow(item: SortableItem): CalloutRow {
    return item as CalloutRow;
  }

  protected ids(rows: readonly SortableItem[]): string[] {
    return rows.map((r) => r.id);
  }

  protected nameOf(c: EditorCallout): string {
    return this.t('editor.docEditor.callouts.legend', {
      number: c.number ?? '–',
      hidden: c.number === null ? 'yes' : 'no',
    });
  }

  protected legendOf(c: EditorCallout): LegendJson {
    return (c.node.content.toJSON() as LegendJson | null) ?? [];
  }

  protected chipsOf(c: EditorCallout) {
    return (
      conditionChips(
        c.when,
        this.blocks.settings().config,
        this.t('editor.docEditor.variant.rule'),
      ) ?? []
    );
  }

  /** Focuses the selected callout's legend field. */
  focusSelectedLegend(): void {
    this.fields()[0]?.focus();
  }
}
