import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { FADE_IN_DELAYED } from '../smooth/fade-in.directive';

/**
 * Placeholder rows while a list loads (a list never shows a spinner). They appear only after
 * 150 ms and fade in (as `ofFadeIn="delayed"`), so a quick answer never flashes them. For the
 * first load only: a reload keeps the content, dimmed (`ofRefreshing`).
 */
@Component({
  selector: 'of-skeleton-rows',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block ' + FADE_IN_DELAYED,
    role: 'status',
    'aria-busy': 'true',
    'data-state': 'loading',
  },
  template: `
    <span class="sr-only">{{
      label() || ('ui.states.loading' | transloco)
    }}</span>
    <div aria-hidden="true">
      @if (header()) {
        <div class="bg-muted h-10" [class.rounded-lg]="tall()"></div>
      }
      <ul class="m-0 flex list-none flex-col p-0">
        @for (row of rows(); track $index) {
          <li
            class="border-border flex items-center gap-4 border-b px-4"
            [class.py-2.5]="!tall()"
            [class.h-14]="tall()"
          >
            <span
              class="bg-muted h-3 animate-pulse rounded-sm motion-reduce:animate-none"
              [style.width.%]="row[0]"
            ></span>
            <span
              class="bg-muted h-3 animate-pulse rounded-sm motion-reduce:animate-none"
              [style.width.%]="row[1]"
            ></span>
          </li>
        }
      </ul>
    </div>
  `,
})
export class SkeletonRowsComponent {
  readonly count = input(8);
  /** Default: "Loading". */
  readonly label = input('');
  /** A bar in place of the table's header row. */
  readonly header = input(false);
  /** Rows as tall as a table's (two lines of text), so the table replaces them without a jump. */
  readonly tall = input(false);
  /** Two bars per row, their widths varied so the rows read as text. */
  protected readonly rows = computed(() =>
    Array.from(
      { length: Math.max(1, this.count()) },
      (_, i) => WIDTHS[i % WIDTHS.length] ?? [40, 20],
    ),
  );
}

const WIDTHS: readonly (readonly [number, number])[] = [
  [40, 20],
  [35, 25],
  [45, 15],
  [30, 22],
  [38, 18],
];
