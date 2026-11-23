import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ImageBlockComponent,
  type ImageBlockState,
} from '@openfolia/ui/blocks';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';

import { ImageSources } from '../images/image-sources';
import { MeService } from '../permissions/me';
import type { BlockDiff } from './block-diff';
import { DIFF_ITEM, type NodesMode } from './review-context';
import type { Segment } from './review-diff';

type ImageBlock = { type: 'image'; asset: string; width?: number };

/** One side's picture, read at its commit. */
function picture(
  sources: ImageSources,
  asset: () => string | null,
  ref: () => string,
  who: () => string,
) {
  const read = resource({
    params: () => {
      const a = asset();
      // Read again for another person: what was shown was the one before's (#716).
      return a ? { asset: a, ref: ref(), who: who() } : undefined;
    },
    loader: ({ params }) => sources.source(params.asset, null, params.ref),
  });
  return {
    state: computed((): ImageBlockState => {
      if (!asset()) return 'empty';
      if (read.isLoading()) return 'loading';
      if (read.status() === 'error') return 'error';
      return read.hasValue() && read.value() ? 'shown' : 'missing';
    }),
    src: computed(() => (read.hasValue() ? (read.value() ?? '') : '')),
    reload: () => read.reload(),
  };
}

/**
 * An image block compared: the picture before and after, side by side, when it was replaced
 * (with a swipe to compare the two in one frame), else the picture once; and the alt text and
 * caption with their words marked. Each side is read at its own commit.
 */
@Component({
  selector: 'of-diff-image',
  imports: [
    TranslocoPipe,
    ImageBlockComponent,
    DiffInsertedComponent,
    DiffDeletedComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex max-w-2xl min-w-0 flex-col gap-2' },
  template: `
    @if (replaced()) {
      @if (swipe()) {
        <div
          class="border-border bg-card relative overflow-hidden rounded-xl border"
          data-slot="image-swipe"
        >
          <img
            class="block h-auto w-full"
            [src]="was.src()"
            [alt]="'editor.review.image.before' | transloco"
          />
          <img
            class="absolute inset-0 block h-full w-full object-cover"
            [style.clip-path]="'inset(0 0 0 ' + split() + '%)'"
            [src]="now.src()"
            [alt]="'editor.review.image.after' | transloco"
          />
          <span
            class="bg-foreground pointer-events-none absolute inset-y-0 w-0.5"
            [style.inset-inline-start.%]="split()"
            aria-hidden="true"
          ></span>
          <span
            class="bg-background/90 absolute start-2 top-2 rounded-md px-1.5 text-xs font-medium"
            >{{ 'editor.review.image.before' | transloco }}</span
          >
          <span
            class="bg-background/90 absolute end-2 top-2 rounded-md px-1.5 text-xs font-medium"
            >{{ 'editor.review.image.after' | transloco }}</span
          >
        </div>
        <label class="flex items-center gap-3 text-xs">
          <span class="text-muted-foreground shrink-0">{{
            'editor.review.image.swipeLabel' | transloco
          }}</span>
          <input
            type="range"
            min="0"
            max="100"
            class="accent-foreground min-w-0 flex-1"
            [value]="split()"
            (input)="split.set(+$any($event.target).value)"
          />
        </label>
      } @else {
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <figure class="m-0 flex min-w-0 flex-col gap-1.5">
            <figcaption
              class="text-destructive flex items-center gap-1.5 text-xs font-medium"
            >
              <span aria-hidden="true">−</span>
              {{ 'editor.review.image.before' | transloco }}
            </figcaption>
            <of-image-block
              class="ring-destructive/40 ring-2"
              [state]="was.state()"
              [src]="was.src()"
              [alt]="beforeAlt()"
              (retry)="was.reload()"
            />
          </figure>
          <figure class="m-0 flex min-w-0 flex-col gap-1.5">
            <figcaption
              class="text-success flex items-center gap-1.5 text-xs font-medium"
            >
              <span aria-hidden="true">+</span>
              {{ 'editor.review.image.after' | transloco }}
            </figcaption>
            <of-image-block
              class="ring-success/40 ring-2"
              [state]="now.state()"
              [src]="now.src()"
              [alt]="afterAlt()"
              (retry)="now.reload()"
            />
          </figure>
        </div>
      }
      @if (bothShown()) {
        <button
          type="button"
          class="text-foreground focus-visible:ring-ring self-start rounded-md px-1 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
          [attr.aria-pressed]="swipe()"
          (click)="swipe.set(!swipe())"
        >
          {{
            (swipe()
              ? 'editor.review.image.sideBySide'
              : 'editor.review.image.swipe'
            ) | transloco
          }}
        </button>
      }
    } @else {
      @let side = mode() === 'before' ? was : now;
      <of-image-block
        [state]="side.state()"
        [src]="side.src()"
        [alt]="mode() === 'before' ? beforeAlt() : afterAlt()"
        [caption]="plainCaption()"
        [width]="width()"
        (retry)="side.reload()"
      />
    }
    @if (showTextChanges()) {
      @for (line of textChanges(); track line.key) {
        <p class="m-0 text-[0.8125rem] leading-5 break-words">
          <span class="text-muted-foreground me-1.5 text-xs">{{
            line.key | transloco
          }}</span>
          @for (s of line.segments; track $index) {
            @if (s.op === 'ins') {
              <ins of-diff-inserted>{{ s.text }}</ins>
            } @else if (s.op === 'del') {
              <del of-diff-deleted>{{ s.text }}</del>
            } @else {
              <span>{{ s.text }}</span>
            }
          }
        </p>
      }
    }
  `,
})
export class DiffImageComponent {
  private readonly item = inject(DIFF_ITEM);
  private readonly sources = inject(ImageSources);
  private readonly me = inject(MeService).me;

  readonly node = input.required<BlockDiff>();
  readonly mode = input<NodesMode>('inline');

  private readonly block = (side: 'before' | 'after'): ImageBlock | null => {
    const n = this.node()[side];
    return n?.kind === 'block' && n.block.type === 'image'
      ? (n.block as ImageBlock)
      : null;
  };

  protected readonly was = picture(
    this.sources,
    () => this.block('before')?.asset ?? null,
    () => this.item.base(),
    () => this.me().id,
  );
  protected readonly now = picture(
    this.sources,
    () => this.block('after')?.asset ?? null,
    () => this.item.head(),
    () => this.me().id,
  );

  /** The picture itself was replaced: inline shows both (side by side shows each on its side). */
  protected readonly replaced = computed(() => {
    const b = this.block('before');
    const a = this.block('after');
    return !!b && !!a && b.asset !== a.asset && this.mode() === 'inline';
  });

  protected readonly bothShown = computed(
    () => this.was.state() === 'shown' && this.now.state() === 'shown',
  );
  protected readonly swipe = signal(false);
  protected readonly split = signal(50);

  protected readonly beforeAlt = computed(
    () =>
      this.node()
        .texts['text']?.filter((s) => s.op !== 'ins')
        .map((s) => s.text)
        .join('') ?? '',
  );
  protected readonly afterAlt = computed(
    () =>
      this.node()
        .texts['text']?.filter((s) => s.op !== 'del')
        .map((s) => s.text)
        .join('') ?? '',
  );
  protected readonly plainCaption = computed(() => {
    const drop = this.mode() === 'before' ? 'ins' : 'del';
    return (
      this.node()
        .texts['caption']?.filter((s) => s.op !== drop)
        .map((s) => s.text)
        .join('') ?? ''
    );
  });
  protected readonly width = computed(
    () =>
      (this.mode() === 'before' ? this.block('before') : this.block('after'))
        ?.width ?? null,
  );

  /** The alt text and caption, marked, where their words changed. */
  protected readonly textChanges = computed(() => {
    const out: { key: string; segments: readonly Segment[] }[] = [];
    const add = (name: string, key: string) => {
      const segments = this.node().texts[name] ?? [];
      if (segments.some((s) => s.op !== 'same')) out.push({ key, segments });
    };
    add('text', 'editor.review.image.altChanged');
    add('caption', 'editor.review.image.captionChanged');
    return out;
  });
  protected readonly showTextChanges = computed(
    () => this.node().change === 'changed' && this.mode() === 'inline',
  );
}
