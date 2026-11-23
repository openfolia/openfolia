import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideImageOff,
  lucidePencil,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { injectTranslate } from '../i18n/text.pipe';
import { ZardSkeletonComponent } from '../skeleton/skeleton.component';
import { ZardTooltipImports } from '../tooltip/tooltip.imports';

/**
 * Where an image block's picture stands: being read (`loading`), there (`shown`), not found or
 * not visible (`missing`), failed to load (`error`, with Retry) or not chosen yet (`empty`).
 */
export type ImageBlockState =
  'loading' | 'shown' | 'missing' | 'error' | 'empty';

/**
 * An image in a document: the picture at its width (a percentage of the text column), its
 * caption, and its alt text under it, so an author sees what a screen reader will say. Without
 * alt text that line says so as a problem, in words. While the picture is read a skeleton holds
 * its place; one that can't be shown says why in words, in a muted box at most 20rem wide (and
 * offers Retry after a failure): never an empty or broken `<img>`. A `shown` picture whose
 * address is empty or does not load counts as failed. `actionLabel` adds a button (Edit) that
 * emits `action`, on one line with the caption and alt text, centred on them;
 * `actionDisabledReason` keeps it in view, disabled, and says why. An element with the
 * `ofImageOverlay` attribute is laid over the shown picture at its size (the callouts:
 * `of-callout-overlay`); other content goes under the caption.
 */
@Component({
  selector: 'of-image-block',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardSkeletonComponent,
    ...ZardTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideImageOff, lucidePencil, lucideTriangleAlert }),
  ],
  host: {
    class:
      'flex flex-col gap-1.5 rounded-xl border border-border bg-card p-2 text-card-foreground',
    '[attr.data-state]': 'shownState()',
  },
  template: `
    <div
      class="max-w-full min-w-16"
      data-slot="image-frame"
      [class.w-fit]="frameWidth() === null && shownState() === 'shown'"
      [class.max-w-xs]="frameWidth() === null && shownState() !== 'shown'"
      [style.width.%]="frameWidth()"
    >
      @switch (shownState()) {
        @case ('loading') {
          <z-skeleton
            class="block w-full rounded-lg"
            [style.aspect-ratio]="aspect()"
          />
        }
        @case ('shown') {
          <div class="relative" data-slot="image-picture">
            <img
              class="block h-auto max-w-full rounded-lg"
              [class.w-full]="frameWidth() !== null"
              [src]="src()"
              [alt]="alt()"
              [attr.width]="naturalWidth()"
              [attr.height]="naturalHeight()"
              (error)="broken.set(true)"
            />
            <ng-content select="[ofImageOverlay]" />
          </div>
        }
        @default {
          <div
            class="bg-muted text-muted-foreground flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg p-4 text-center text-xs [overflow-wrap:anywhere]"
            data-slot="image-problem"
            [style.aspect-ratio]="aspect()"
          >
            <ng-icon name="lucideImageOff" size="20" aria-hidden="true" />
            <span>{{ problemText() }}</span>
            @if (shownState() === 'error') {
              <button
                type="button"
                class="text-foreground rounded-md px-1 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                (click)="tryAgain()"
              >
                {{ 'ui.blocks.image.retry' | transloco }}
              </button>
            }
          </div>
        }
      }
    </div>
    <div
      class="flex min-w-0 items-center gap-3 px-1 text-xs"
      data-slot="image-meta"
    >
      <div class="min-w-0 flex-1 [overflow-wrap:anywhere]">
        @if (caption()) {
          <p class="text-foreground m-0 font-medium" data-slot="image-caption">
            {{ caption() }}
          </p>
        }
        @if (alt()) {
          <p class="text-muted-foreground m-0" data-slot="image-alt">
            {{ 'ui.blocks.image.alt' | transloco: { alt: alt() } }}
          </p>
        } @else {
          <p
            class="text-destructive m-0 flex items-center gap-1"
            data-slot="image-alt"
          >
            <ng-icon
              class="shrink-0"
              name="lucideTriangleAlert"
              size="12"
              aria-hidden="true"
            />
            {{ 'ui.blocks.image.noAlt' | transloco }}
          </p>
        }
      </div>
      @if (actionLabel()) {
        <button
          type="button"
          class="text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
          [attr.aria-disabled]="actionDisabledReason() ? 'true' : null"
          [zTooltip]="actionDisabledReason()"
          (click)="actionDisabledReason() || action.emit()"
        >
          <ng-icon name="lucidePencil" size="12" aria-hidden="true" />
          {{ actionLabel() }}
        </button>
      }
    </div>
    <ng-content />
  `,
})
export class ImageBlockComponent {
  readonly state = input<ImageBlockState>('loading');
  /** The picture's address (an object URL, say); used while `state` is `shown`. */
  readonly src = input('');
  /** The alt text; empty shows "No alt text" as a problem. */
  readonly alt = input('');
  readonly caption = input('');
  /** The width as a percentage of the text column; null: the picture's own size (at most the column's). */
  readonly width = input<number | null>(null);
  /** The picture's size in pixels, when known: its place keeps that shape while it loads. */
  readonly naturalWidth = input<number | null>(null);
  readonly naturalHeight = input<number | null>(null);
  /** Replaces the default words for `missing`, `error` and `empty`. */
  readonly problem = input('');
  /** The action's label (Edit); empty: no action. */
  readonly actionLabel = input('');
  /** Why the action can't be used now; non-empty disables it and shows the reason as its tooltip. */
  readonly actionDisabledReason = input('');
  readonly action = output<void>();
  readonly retry = output<void>();

  /** The width set, as a percentage; null: the picture's own size, at most the column's. */
  protected readonly frameWidth = computed(() => {
    const width = this.width();
    return typeof width === 'number' && width > 0 && width <= 100
      ? width
      : null;
  });

  protected readonly aspect = computed(() => {
    const w = this.naturalWidth();
    const h = this.naturalHeight();
    return w && h ? `${w} / ${h}` : '8 / 5';
  });

  private readonly t = injectTranslate();

  /** The picture at `src` did not load (reset when the address changes). */
  protected readonly broken = linkedSignal({
    source: this.src,
    computation: () => false,
  });

  /** The state as shown: a picture without an address, or one that did not load, failed. */
  protected readonly shownState = computed((): ImageBlockState => {
    const state = this.state();
    return state === 'shown' && (!this.src() || this.broken())
      ? 'error'
      : state;
  });

  protected readonly problemText = computed(() => {
    const state = this.shownState();
    // The words given are for the state given: a picture that failed to load says so.
    if (this.problem() && state === this.state()) return this.problem();
    return this.t(
      state === 'missing'
        ? 'ui.blocks.image.missing'
        : state === 'empty'
          ? 'ui.blocks.image.empty'
          : 'ui.blocks.image.failed',
    );
  });

  protected tryAgain(): void {
    this.broken.set(false);
    this.retry.emit();
  }
}
