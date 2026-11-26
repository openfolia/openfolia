import {
  HttpClient,
  HttpErrorResponse,
  HttpParams,
} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import { API_BASE_URL } from '../api';
import type { VariantSummary } from './manual-draft';

/** The pages shown: the cover and the first page after it (the contents, or the first chapter). */
const PAGES = [1, 2] as const;
/** Rendered at twice the shown width, for sharp thumbnails on dense screens. */
const RENDER_WIDTH = 2 * 136;
/** After a save, the thumbnails wait this long for more saves before rendering again. */
export const THUMBNAIL_DELAY_MS = 1500;

/** What the thumbnails show; a new value renders them again. */
export interface ThumbnailRequest {
  readonly manualId: string;
  readonly variant: string;
  readonly lang: string;
  readonly ref: string | null;
  /** The person's own draft: its working copies, unsaved edits included (`?workingCopy=true`). */
  readonly live: boolean;
}

interface Shown {
  /** `blob:` URLs of PNGs, one per page the PDF has (of `PAGES`). */
  readonly urls: readonly string[];
}

/**
 * The PDF preview card (screen 3): the cover and the first content page of the manual's real PDF,
 * rendered by the API as PNG, for the chosen variant and language. They render again after a save
 * (`revision`), a short while after the last one; meanwhile the old ones stay, dimmed. A click
 * opens the full preview. With more than one variant a select picks the one shown.
 */
@Component({
  selector: 'of-cover-preview',
  imports: [
    TranslocoPipe,
    RouterLink,
    ZardSelectImports,
    ZardSkeletonComponent,
    ZardButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col items-center gap-2.5 rounded-xl bg-muted p-4',
  },
  template: `
    <div class="flex min-w-0 items-center justify-between gap-2 self-stretch">
      <h2 class="m-0 text-sm font-medium">
        {{ 'editor.manuals.preview.heading' | transloco }}
      </h2>
      @if (variants().length > 1) {
        <z-select
          class="w-44 max-w-[60%]"
          zPosition="popper"
          [zAriaLabel]="'editor.manuals.preview.variant' | transloco"
          [zValue]="variant()?.slug ?? ''"
          (zSelectionChange)="pick($event)"
        >
          @for (v of variants(); track v.slug) {
            <z-select-item [zValue]="v.slug">{{ v.label }}</z-select-item>
          }
        </z-select>
      } @else {
        <span class="text-xs text-muted-foreground">{{
          'editor.manuals.preview.pages' | transloco
        }}</span>
      }
    </div>
    @if (error() && !shown()) {
      <div
        class="flex aspect-[420/297] w-full max-w-[288px] flex-col items-center justify-center gap-2 rounded-sm bg-background p-4 text-center text-xs text-muted-foreground ring-1 ring-border/60 [overflow-wrap:anywhere]"
        role="alert"
        data-slot="thumbnails-error"
      >
        <span>{{ 'editor.manuals.preview.renderFailed' | transloco }}</span>
        <button z-button zType="outline" zSize="sm" (click)="retry()">
          {{ 'editor.manuals.preview.retry' | transloco }}
        </button>
      </div>
    } @else if (shown(); as s) {
      <a
        class="flex max-w-full gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-opacity motion-safe:duration-300"
        data-slot="thumbnails"
        [class.opacity-50]="loading()"
        [attr.aria-busy]="loading()"
        routerLink="/preview"
        [queryParams]="previewParams()"
        [attr.aria-label]="
          'editor.manuals.preview.open'
            | transloco: { title: title(), variant: variant()?.label ?? '' }
        "
      >
        @for (url of s.urls; track $index) {
          <img
            class="block aspect-[210/297] w-[136px] min-w-0 shrink rounded-sm object-contain shadow-md ring-1 ring-border/60"
            [src]="url"
            [alt]="
              ($index === 0
                ? 'editor.manuals.preview.coverAlt'
                : 'editor.manuals.preview.pageAlt'
              ) | transloco: { title: title(), variant: variant()?.label ?? '' }
            "
          />
        }
      </a>
      @if (error()) {
        <p class="m-0 text-xs text-destructive" role="alert">
          {{ 'editor.manuals.preview.renderFailed' | transloco }}
          <button
            z-button
            zType="link"
            zSize="sm"
            class="h-auto p-0"
            (click)="retry()"
          >
            {{ 'editor.manuals.preview.retry' | transloco }}
          </button>
        </p>
      }
    } @else if (request()) {
      <div
        class="flex max-w-full gap-2"
        data-slot="thumbnails-loading"
        role="status"
        aria-busy="true"
        [attr.aria-label]="'editor.manuals.preview.rendering' | transloco"
      >
        @for (page of pages; track page) {
          <z-skeleton class="aspect-[210/297] w-[136px] min-w-0 shrink" />
        }
      </div>
    }
  `,
})
export class CoverPreviewComponent {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly destroyRef = inject(DestroyRef);

  readonly title = input.required<string>();
  readonly variants = input<readonly VariantSummary[]>([]);
  readonly variant = input<VariantSummary | null>(null);
  /** What to render; null renders nothing (no variant or language yet). */
  readonly request = input<ThumbnailRequest | null>(null);
  /** Changes after each save of the working copy: the thumbnails render again, debounced. */
  readonly revision = input(0);
  /** How long after a save the pages wait for more saves before rendering again. */
  readonly delayMs = input(THUMBNAIL_DELAY_MS);
  /** The query of the full preview a click opens. */
  readonly previewParams = input<Record<string, string>>({});
  readonly variantChange = output<string>();

  protected readonly pages = PAGES;
  protected readonly shown = signal<Shown | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);

  /** The request's identity; a new one renders at once, a new revision after the delay. */
  private readonly key = computed(() => {
    const r = this.request();
    return r
      ? [r.manualId, r.variant, r.lang, r.ref ?? '', r.live].join('\n')
      : null;
  });
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey: string | null = null;

  constructor() {
    effect(() => {
      const key = this.key();
      this.revision();
      untracked(() => {
        const changed = key !== this.lastKey;
        this.lastKey = key;
        clearTimeout(this.timer);
        if (key === null) {
          this.runs++;
          this.error.set(false);
          this.show(null);
          this.loading.set(false);
          return;
        }
        if (changed) {
          // Another manual, variant or language: the old pages would mislead.
          this.show(null);
          void this.render();
        } else {
          this.timer = setTimeout(() => void this.render(), this.delayMs());
        }
      });
    });
    this.destroyRef.onDestroy(() => {
      this.runs++;
      clearTimeout(this.timer);
      this.show(null);
    });
  }

  protected retry(): void {
    clearTimeout(this.timer);
    void this.render();
  }

  protected pick(value: string | string[]): void {
    const slug = Array.isArray(value) ? value[0] : value;
    if (slug) this.variantChange.emit(slug);
  }

  private async render(): Promise<void> {
    const request = this.request();
    if (!request) return;
    const run = ++this.runs;
    this.loading.set(true);
    this.error.set(false);
    const urls: string[] = [];
    try {
      for (const page of PAGES) {
        // Superseded (another request or a newer save): no need to render more.
        if (run !== this.runs) break;
        const png = await this.page(request, page);
        if (!png) break;
        // Always typed as PNG, whatever the answer named: never shown as anything else.
        urls.push(URL.createObjectURL(new Blob([png], { type: 'image/png' })));
      }
      if (run !== this.runs) {
        urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      this.show({ urls });
    } catch {
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (run === this.runs) this.error.set(true);
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }

  /** One page as PNG; null when the PDF has no such page (past the cover only). */
  private async page(
    request: ThumbnailRequest,
    page: number,
  ): Promise<Blob | null> {
    const e = encodeURIComponent;
    let params = new HttpParams().set('width', RENDER_WIDTH);
    if (request.ref) {
      params = params.set('ref', request.ref);
      if (request.live) params = params.set('workingCopy', 'true');
    }
    try {
      return await firstValueFrom(
        this.http
          .get(
            `${this.base}/manuals/${e(request.manualId)}/variants/${e(request.variant)}/${e(request.lang)}/pdf/pages/${page}.png`,
            { params, headers: { Accept: 'image/png' }, responseType: 'blob' },
          )
          // Closed: nobody waits for the page any more (#935).
          .pipe(takeUntilDestroyed(this.destroyRef)),
      );
    } catch (error) {
      if (
        page > 1 &&
        error instanceof HttpErrorResponse &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  /** Shows these pages and releases the URLs of the ones before. */
  private show(next: Shown | null): void {
    const before = this.shown();
    this.shown.set(next);
    before?.urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
