import {
  CdkDrag,
  CdkDragHandle,
  CdkDragPlaceholder,
  CdkDropList,
  type CdkDragDrop,
} from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  contentChild,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  TemplateRef,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGripVertical } from '@ng-icons/lucide';

import { TranslocoPipe } from '@jsverse/transloco';

import { injectTranslate } from '../i18n/text.pipe';

/** A row of a sortable list: its key, and the name its move button and announcements use. */
export interface SortableItem {
  readonly id: string;
  readonly label: string;
}

/** Marks the `<ng-template>` that renders a row's content; it gets the item and its index. */
@Directive({ selector: 'ng-template[ofSortableRow]' })
export class SortableRowDirective {
  readonly template =
    inject<TemplateRef<{ $implicit: SortableItem; index: number }>>(
      TemplateRef,
    );
}

/** Moves the item at `from` to `to` (both in range), returning a new list. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * A flat list whose rows are put in order by dragging their grip, or with the keyboard: the grip
 * is a button, and Alt+Arrow Up / Alt+Arrow Down on it move the row one place (focus stays on
 * the grip, a polite live region says where the row is now). Rows hold anything (fields,
 * buttons): their content comes from `<ng-template ofSortableRow let-item let-index="index">`
 * and keeps its own keys. It owns no data: it shows `items` and emits the whole new order in
 * `itemsChange`. `readonly` shows the rows without grips. While a row is dragged the others slide
 * out of its way; no motion for people who asked for less.
 */
@Component({
  selector: 'of-sortable-list',
  imports: [
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    NgIcon,
    NgTemplateOutlet,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideGripVertical })],
  host: { class: 'block' },
  styles: `
    @media (prefers-reduced-motion: no-preference) {
      .cdk-drop-list-dragging [cdkDrag]:not(.cdk-drag-placeholder),
      .cdk-drag-animating {
        transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
      }
    }
  `,
  template: `
    <ul
      cdkDropList
      class="m-0 flex list-none flex-col p-0"
      [attr.aria-label]="label() || null"
      [cdkDropListDisabled]="readonly()"
      (cdkDropListDropped)="drop($event)"
    >
      @for (item of items(); track item.id; let i = $index) {
        <li
          cdkDrag
          cdkDragLockAxis="y"
          class="bg-card text-foreground flex min-w-0 items-start gap-2 rounded-md py-1"
          [attr.data-id]="item.id"
        >
          @if (!readonly()) {
            <button
              type="button"
              cdkDragHandle
              data-slot="sortable-grip"
              class="text-muted-foreground hover:bg-muted focus-visible:ring-ring/50 mt-1.5 inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-2"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              [attr.aria-label]="
                'ui.sortableList.move' | transloco: { label: item.label }
              "
              (keydown)="onKeydown($event, i)"
            >
              <ng-icon name="lucideGripVertical" aria-hidden="true" />
            </button>
          }
          <div class="min-w-0 flex-1">
            @if (row(); as r) {
              <ng-container
                [ngTemplateOutlet]="r.template"
                [ngTemplateOutletContext]="{ $implicit: item, index: i }"
              />
            }
          </div>
          <div
            *cdkDragPlaceholder
            class="bg-primary my-1 h-0.5 rounded-full"
          ></div>
        </li>
      }
    </ul>
    <div class="sr-only" role="status" aria-live="polite">{{ message() }}</div>
  `,
})
export class SortableListComponent<T extends SortableItem = SortableItem> {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly t = injectTranslate();

  readonly items = input.required<readonly T[]>();
  /** The list's accessible name. */
  readonly label = input('');
  /** Rows without grips: no order can be changed. */
  readonly readonly = input(false);
  /** The whole list in its new order, after a drop or a keyboard move. */
  readonly itemsChange = output<readonly T[]>();

  protected readonly row = contentChild(SortableRowDirective);
  protected readonly message = signal('');

  protected drop(event: CdkDragDrop<unknown>): void {
    if (this.readonly() || event.previousIndex === event.currentIndex) return;
    this.move(event.previousIndex, event.currentIndex, false);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    if (!event.altKey || this.readonly()) return;
    const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (by === 0) return;
    event.preventDefault();
    const to = index + by;
    if (to < 0 || to >= this.items().length) return;
    this.move(index, to, true);
  }

  private move(from: number, to: number, refocus: boolean): void {
    const items = this.items();
    const moved = items[from];
    if (!moved) return;
    const next = moveItem(items, from, to);
    this.itemsChange.emit(next);
    this.message.set(
      this.t('ui.sortableList.moved', {
        label: moved.label,
        position: to + 1,
        total: next.length,
      }),
    );
    if (!refocus) return;
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(
            `[data-id="${CSS.escape(moved.id)}"] [data-slot="sortable-grip"]`,
          )
          ?.focus(),
      { injector: this.injector },
    );
  }
}
