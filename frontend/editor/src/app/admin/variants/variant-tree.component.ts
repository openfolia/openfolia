import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '@openfolia/ui/sortable-list';

import {
  usageKey,
  type UsageCount,
  type ShownVariantAttribute as VariantAttribute,
} from '../settings/config-model';
import type { VariantSelection } from './variant-edits';

/**
 * The left side of the Variants tab (screen 21): the variant attributes in their configured order,
 * each with its values (an enum attribute's), as one list to choose from. Archived values stay
 * listed, muted and marked. Where the person may edit, attributes and values are put in order by
 * dragging their grip or with Alt+Arrow keys on it (`SortableListComponent`). The list scrolls
 * inside its own card, so a long configuration never makes the page scroll. It owns no data:
 * choosing emits `choose`, a new order `reorderAttributes` or `reorderValues`.
 */
@Component({
  selector: 'of-variant-tree',
  imports: [
    TranslocoPipe,
    NgIcon,
    SortableListComponent,
    SortableRowDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
  ],
  viewProviders: [provideIcons({ lucidePlus })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border bg-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border',
  },
  template: `
    <div
      class="min-h-0 flex-1 overflow-y-auto p-2"
      data-slot="variant-tree-scroller"
      [style.max-height]="maxHeight()"
    >
      @if (rows().length === 0) {
        <p class="text-muted-foreground m-0 p-3 text-sm">
          {{ 'editor.admin.settings.variants.none' | transloco }}
        </p>
      } @else {
        <of-sortable-list
          [items]="rows()"
          [label]="'editor.admin.variants.tree.label' | transloco"
          [readonly]="!editable()"
          (itemsChange)="reorderAttributes.emit(ids($event))"
        >
          <ng-template ofSortableRow let-item>
            @let a = attributeOf(item.id);
            @if (a) {
              <div class="flex min-w-0 flex-col" [attr.data-attribute]="a.id">
                <button
                  type="button"
                  class="hover:bg-muted focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-start text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
                  [class.bg-muted]="isSelected(a.id)"
                  [attr.aria-current]="isSelected(a.id) ? 'true' : null"
                  (click)="choose.emit({ attribute: a.id })"
                >
                  <span class="min-w-0 flex-1 break-words">{{ a.label }}</span>
                  @if (a.kind === 'version') {
                    <z-badge zType="outline" class="shrink-0">{{
                      'editor.admin.settings.variants.kindVersion' | transloco
                    }}</z-badge>
                  }
                </button>
                @if (a.kind === 'enum') {
                  <of-sortable-list
                    class="ps-3"
                    [items]="valueRows(a)"
                    [label]="a.label"
                    [readonly]="!editable()"
                    (itemsChange)="
                      reorderValues.emit({
                        attribute: a.id,
                        ids: ids($event),
                      })
                    "
                  >
                    <ng-template ofSortableRow let-v>
                      @let value = valueOf(a, v.id);
                      @if (value) {
                        <button
                          type="button"
                          class="hover:bg-muted focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-start text-sm transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
                          [class.bg-muted]="isSelected(a.id, value.id)"
                          [class.font-medium]="isSelected(a.id, value.id)"
                          [attr.aria-current]="
                            isSelected(a.id, value.id) ? 'true' : null
                          "
                          [attr.data-value]="value.id"
                          (click)="
                            choose.emit({ attribute: a.id, value: value.id })
                          "
                        >
                          <span
                            class="min-w-0 flex-1 break-words"
                            [class.text-muted-foreground]="value.archived"
                            >{{ value.label }}</span
                          >
                          @if (value.archived) {
                            <z-badge zType="secondary" class="shrink-0">{{
                              'editor.admin.settings.option.archived'
                                | transloco
                            }}</z-badge>
                          }
                          @if (countOf(a.id, value.id); as c) {
                            <span
                              class="text-muted-foreground shrink-0 text-xs tabular-nums"
                              [attr.aria-label]="
                                'editor.admin.settings.usage.short'
                                  | transloco: c
                              "
                              >{{ c.modules + c.manuals }}</span
                            >
                          }
                        </button>
                      }
                    </ng-template>
                  </of-sortable-list>
                }
              </div>
            }
          </ng-template>
        </of-sortable-list>
      }
    </div>
    @if (editable()) {
      <div class="border-border border-t p-2">
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="w-full justify-start"
          data-slot="new-attribute"
          (click)="newAttribute.emit()"
        >
          <ng-icon
            name="lucidePlus"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.admin.variants.newAttribute' | transloco }}
        </button>
      </div>
    }
  `,
})
export class VariantTreeComponent {
  /** The attributes with their labels in the source language (the editor edits those). */
  readonly attributes = input.required<readonly VariantAttribute[]>();
  readonly selection = input<VariantSelection | null>(null);
  readonly editable = input(false);
  readonly counts = input<ReadonlyMap<string, UsageCount>>(new Map());
  /** The tallest the list may be, as a CSS length (the rest of the viewport). */
  readonly maxHeight = input('calc(100dvh - 16rem - var(--of-sandbox-h, 0px))');

  readonly choose = output<VariantSelection>();
  readonly reorderAttributes = output<readonly string[]>();
  readonly reorderValues = output<{
    readonly attribute: string;
    readonly ids: readonly string[];
  }>();
  readonly newAttribute = output<void>();

  protected readonly rows = computed(() =>
    this.attributes().map((a) => ({ id: a.id, label: a.label })),
  );

  protected ids(items: readonly SortableItem[]): string[] {
    return items.map((i) => i.id);
  }

  protected attributeOf(id: string): VariantAttribute | undefined {
    return this.attributes().find((a) => a.id === id);
  }

  protected valueRows(a: VariantAttribute): SortableItem[] {
    return a.kind === 'enum'
      ? a.values.map((v) => ({ id: v.id, label: v.label }))
      : [];
  }

  protected valueOf(a: VariantAttribute, id: string) {
    return a.kind === 'enum' ? a.values.find((v) => v.id === id) : undefined;
  }

  protected isSelected(attribute: string, value?: string): boolean {
    const s = this.selection();
    return s?.attribute === attribute && s.value === value;
  }

  protected countOf(attribute: string, value: string): UsageCount | undefined {
    const c = this.counts().get(
      usageKey({ kind: 'variantValue', valueId: value, parentId: attribute }),
    );
    return c && c.modules + c.manuals > 0 ? c : undefined;
  }
}
