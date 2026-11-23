import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import type { ItemSummary } from './review-context';

/** What happened to an item as a whole. */
export type ItemState = 'added' | 'changed' | 'removed' | 'renamed';

const STATE_KEYS: Readonly<Record<ItemState, string>> = {
  added: 'editor.review.state.added',
  changed: 'editor.review.state.changed',
  removed: 'editor.review.state.removed',
  renamed: 'editor.review.state.renamed',
};

const STATE_TONES: Readonly<Record<ItemState, string>> = {
  added: 'border-success/40 bg-success-muted text-success',
  changed: 'border-info/40 bg-info-muted text-info',
  removed: 'border-destructive/40 bg-destructive-muted text-destructive',
  renamed: 'border-info/40 bg-info-muted text-info',
};

/**
 * The head of a changed item: its title (linking to the item in the address), what it is
 * (manual, or a module's language and type), its state in words, and how many changes of each
 * kind it holds. Its content goes at the end of the title's line: what may be done with it.
 */
@Component({
  selector: 'of-diff-item-header',
  imports: [RouterLink, TranslocoPipe, ZardSkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-1.5' },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <h3 class="m-0 min-w-0 text-lg leading-7 font-semibold break-words">
        @if (title()) {
          <a
            class="focus-visible:ring-ring rounded-md outline-none hover:underline focus-visible:ring-2"
            [routerLink]="[]"
            [queryParams]="focusParams()"
            queryParamsHandling="merge"
            [attr.aria-current]="focused() ? 'true' : null"
            >{{ title() }}</a
          >
        } @else {
          <z-skeleton class="inline-block h-5 w-48 align-middle" />
        }
      </h3>
      <span
        class="rounded-full border px-2 py-px text-xs font-medium"
        [class]="stateTone()"
        >{{ stateKey() | transloco }}</span
      >
      <!-- What may be done with the item (taking it out of the change set). -->
      <span class="ms-auto flex shrink-0 items-center empty:hidden"
        ><ng-content
      /></span>
    </div>
    <p
      class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-1.5 text-xs leading-5 break-words"
    >
      <span>{{ kind() }}</span>
      @if (id()) {
        <span aria-hidden="true">·</span>
        <span class="font-mono [overflow-wrap:anywhere]">{{ id() }}</span>
      }
      @if (summary(); as s) {
        @for (c of countsOf(s); track c.key) {
          <span aria-hidden="true">·</span>
          <span [class]="c.tone">{{
            c.key | transloco: { count: c.count }
          }}</span>
        } @empty {
          <span aria-hidden="true">·</span>
          <span>{{ 'editor.review.counts.none' | transloco }}</span>
        }
      }
    </p>
  `,
})
export class DiffItemHeaderComponent {
  readonly title = input('');
  /** Its ID, shown under the title (a module's or manual's file name). */
  readonly id = input('');
  /** "Manual", or "English · Procedure". */
  readonly kind = input('');
  readonly state = input<ItemState>('changed');
  readonly summary = input<ItemSummary | undefined>(undefined);
  readonly focusParams = input<Record<string, string | null>>({});
  readonly focused = input(false);

  protected readonly stateKey = computed(() => STATE_KEYS[this.state()]);
  protected readonly stateTone = computed(() => STATE_TONES[this.state()]);

  protected countsOf(s: ItemSummary) {
    return [
      {
        key: 'editor.review.counts.added',
        count: s.counts.added,
        tone: 'text-success',
      },
      {
        key: 'editor.review.counts.changed',
        count: s.counts.changed,
        tone: 'text-info',
      },
      {
        key: 'editor.review.counts.removed',
        count: s.counts.removed,
        tone: 'text-destructive',
      },
      {
        key: 'editor.review.counts.moved',
        count: s.counts.moved,
        tone: 'text-info',
      },
      { key: 'editor.review.counts.fields', count: s.fields, tone: '' },
    ].filter((c) => c.count > 0);
  }
}
