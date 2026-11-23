import {
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';

/**
 * What a list item tells the list it sits in: a list (`of-list-frame`) provides this and moves
 * its items smoothly when a filter adds or removes some.
 */
export abstract class ListMotion {
  abstract register(item: ListItemDirective): void;
  abstract unregister(item: ListItemDirective): void;
}

/**
 * One item of a list in a `of-list-frame` (a table row, a tile), bound to its item of the
 * frame's `items`. The frame tells the items apart by its `trackBy` (by default the item's `id`;
 * the `@for` around the rows tracks by the same key), so it knows the items that stay from those
 * a filter adds or removes: a removed item fades out, then the others close the gap; the others
 * make room for an added one, which then fades in. A page change switches at once. Reduced
 * motion: no motion.
 *
 * The frame's own rows (`ofListRow`) carry it already; a table or grid template puts it on
 * its rows or tiles:
 *
 * ```html
 * @for (row of rows; track row.id) {
 *   <tr z-table-row [ofListItem]="row">…</tr>
 * }
 * ```
 *
 * Outside a list frame it does nothing.
 */
@Directive({ selector: '[ofListItem]' })
export class ListItemDirective {
  /** The item, one of the frame's `items`. */
  readonly item = input.required<unknown>({ alias: 'ofListItem' });
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const motion = inject(ListMotion, { optional: true });
    if (!motion) return;
    motion.register(this);
    inject(DestroyRef).onDestroy(() => motion.unregister(this));
  }
}
