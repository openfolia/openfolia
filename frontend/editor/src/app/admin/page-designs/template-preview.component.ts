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
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronLeft,
  lucideChevronRight,
  lucideRefreshCw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import { API_BASE_URL } from '../../api';
import {
  templateErrorOf,
  type TemplateProblem,
} from './design-preview.component';

/** Rendered at twice the shown width, for sharp pages on dense screens. */
const RENDER_WIDTH = 2 * 400;
/** After a save, the page waits this long for more saves before rendering again. */
export const TEMPLATE_PREVIEW_DELAY_MS = 500;

/** What the preview renders; a new value renders it again at once. */
export interface TemplatePreviewRequest {
  readonly templateId: string;
  /** The change set's branch; null: the released content. */
  readonly ref: string | null;
  /** The person's own draft: its working copies (`?workingCopy=true`). */
  readonly live: boolean;
  /** The page design whose settings lay it out; null: the built-in design. */
  readonly designId: string | null;
}

/** What the preview found: the problems of a template that does not compile, or none. */
export type TemplatePreviewOutcome =
  | { readonly kind: 'rendering' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'problems'; readonly problems: readonly TemplateProblem[] }
  | { readonly kind: 'failed' };

/**
 * The template screen's live preview (#396): one page of the renderer's small manual that uses
 * every function of the template contract, laid out with the template (its working copies in the
 * person's draft), as PNG, with a pager. After each save (`revision`) it renders again, a short
 * while after the last one; meanwhile the page shown stays, dimmed, in a box of the page's shape,
 * so nothing jumps. A template that does not compile shows no page: its problems go to the
 * screen (`outcome`), which shows them at their lines.
 */
@Component({
  selector: 'of-template-preview',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, ZardSkeletonComponent],
  viewProviders: [
    provideIcons({
      lucideChevronLeft,
      lucideChevronRight,
      lucideRefreshCw,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-2' },
  template: `
    <figure class="m-0 flex min-w-0 flex-col gap-2">
      <div
        class="bg-background ring-border/60 relative mx-auto w-full max-w-md overflow-hidden rounded-sm shadow-md ring-1"
        style="aspect-ratio: 210 / 297"
        data-slot="template-preview-page"
        [attr.aria-busy]="loading()"
      >
        @if (url(); as src) {
          <img
            class="absolute inset-0 block size-full object-contain motion-safe:transition-opacity motion-safe:duration-300"
            [class.opacity-50]="loading() || broken()"
            [class.grayscale]="broken()"
            [src]="src"
            [alt]="
              'editor.admin.pageDesigns.templates.preview.alt'
                | transloco: { page: shownPage() }
            "
          />
        } @else if (!failed() && !broken()) {
          <z-skeleton class="absolute inset-0 size-full rounded-none" />
        }
        @if (broken() && !url()) {
          <div
            class="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-xs"
            data-slot="template-preview-broken"
          >
            <ng-icon
              name="lucideTriangleAlert"
              class="text-destructive"
              size="20"
              aria-hidden="true"
            />
            <span class="max-w-56 break-words">{{
              'editor.admin.pageDesigns.templates.preview.broken' | transloco
            }}</span>
          </div>
        }
        @if (broken() && url()) {
          <span
            class="bg-destructive-muted text-destructive absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium shadow-sm"
            data-slot="template-preview-broken-badge"
          >
            <ng-icon name="lucideTriangleAlert" size="12" aria-hidden="true" />
            {{
              'editor.admin.pageDesigns.templates.preview.brokenBadge'
                | transloco
            }}
          </span>
        }
        @if (loading() && url()) {
          <span
            class="bg-background/85 text-muted-foreground absolute top-2 right-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] shadow-sm"
            aria-hidden="true"
          >
            <ng-icon
              name="lucideRefreshCw"
              class="motion-safe:animate-spin"
              size="12"
            />
            {{
              'editor.admin.pageDesigns.templates.preview.updating' | transloco
            }}
          </span>
        }
      </div>
      <figcaption
        class="text-muted-foreground flex min-h-8 items-center justify-between gap-2 text-xs"
      >
        <span class="tabular-nums" data-slot="template-preview-count">
          @if (pages(); as total) {
            {{
              'editor.admin.pageDesigns.templates.preview.pageOf'
                | transloco: { page: shownPage(), pages: total }
            }}
          } @else {
            {{
              'editor.admin.pageDesigns.templates.preview.page'
                | transloco: { page: wanted() }
            }}
          }
        </span>
        <span class="flex items-center">
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            class="size-8 p-0"
            data-slot="template-preview-back"
            [zDisabled]="wanted() <= 1"
            [attr.aria-label]="
              'editor.admin.pageDesigns.preview.previous' | transloco
            "
            (click)="step(-1)"
          >
            <ng-icon name="lucideChevronLeft" aria-hidden="true" />
          </button>
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            class="size-8 p-0"
            data-slot="template-preview-next"
            [zDisabled]="pages() !== null && wanted() >= pages()!"
            [attr.aria-label]="
              'editor.admin.pageDesigns.preview.next' | transloco
            "
            (click)="step(1)"
          >
            <ng-icon name="lucideChevronRight" aria-hidden="true" />
          </button>
        </span>
      </figcaption>
    </figure>

    <p class="sr-only" role="status">
      @if (loading()) {
        {{ 'editor.admin.pageDesigns.preview.rendering' | transloco }}
      }
    </p>

    @if (failed()) {
      <div
        class="border-destructive/40 text-destructive flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
        role="alert"
        data-slot="template-preview-error"
      >
        <span class="min-w-0 flex-1 break-words">{{
          'editor.admin.pageDesigns.preview.failed' | transloco
        }}</span>
        <button
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          (click)="retry()"
        >
          {{ 'editor.admin.pageDesigns.preview.retry' | transloco }}
        </button>
      </div>
    }
  `,
})
export class TemplatePreviewComponent {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** What to render; null renders nothing. */
  readonly request = input<TemplatePreviewRequest | null>(null);
  /** Changes after each save of a working copy: the page renders again, debounced. */
  readonly revision = input(0);
  readonly delayMs = input(TEMPLATE_PREVIEW_DELAY_MS);
  readonly outcome = output<TemplatePreviewOutcome>();

  protected readonly url = signal<string | null>(null);
  protected readonly shownPage = signal(1);
  protected readonly wanted = signal(1);
  protected readonly pages = signal<number | null>(null);
  protected readonly loading = signal(false);
  /** The page could not be rendered for another reason than the template: retried by hand. */
  protected readonly failed = signal(false);
  /** The template does not compile: its problems are told beside the code. */
  protected readonly broken = signal(false);

  private readonly key = computed(() => {
    const r = this.request();
    return r
      ? [r.templateId, r.ref ?? '', r.live, r.designId ?? ''].join('\n')
      : null;
  });
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey: string | null = null;
  private readonly cancel = new Subject<void>();

  constructor() {
    effect(() => {
      const key = this.key();
      this.revision();
      untracked(() => {
        const changed = key !== this.lastKey;
        this.lastKey = key;
        clearTimeout(this.timer);
        if (key === null) {
          this.stop();
          this.show(null);
          this.loading.set(false);
          return;
        }
        if (changed) {
          this.pages.set(null);
          void this.render();
        } else {
          if (this.loading()) this.stop();
          // The files changed: the page count may have too.
          this.pages.set(null);
          this.loading.set(true);
          this.timer = setTimeout(() => void this.render(), this.delayMs());
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.stop();
      clearTimeout(this.timer);
      this.show(null);
    });
  }

  protected step(by: number): void {
    const next = Math.max(1, this.wanted() + by);
    const last = this.pages();
    if (last !== null && next > last) return;
    this.wanted.set(next);
    clearTimeout(this.timer);
    void this.render();
  }

  protected retry(): void {
    clearTimeout(this.timer);
    void this.render();
  }

  private stop(): void {
    this.runs++;
    this.cancel.next();
  }

  private async render(): Promise<void> {
    const request = this.request();
    if (!request) return;
    this.stop();
    const run = this.runs;
    this.loading.set(true);
    this.failed.set(false);
    this.outcome.emit({ kind: 'rendering' });
    try {
      let number = this.wanted();
      let page = await this.page(request, number);
      if (run !== this.runs) return;
      if (!page.png && page.pages !== null && page.pages >= 1) {
        // Fewer pages than asked for: the last one.
        number = page.pages;
        page = await this.page(request, number);
        if (run !== this.runs) return;
      }
      if (!page.png) throw new Error('no page');
      // How many pages there are is learnt by stepping past the last (its 404 says so): never
      // asked for up front, as every such answer is a failed request in the browser's console.
      if (number < this.wanted()) this.pages.set(number);
      this.wanted.set(number);
      this.shownPage.set(number);
      this.show(
        URL.createObjectURL(new Blob([page.png], { type: 'image/png' })),
      );
      this.broken.set(false);
      this.outcome.emit({ kind: 'ok' });
    } catch (error) {
      if (run !== this.runs) return;
      const problems = await templateErrorOf(error);
      if (run !== this.runs) return;
      if (problems) {
        this.broken.set(true);
        this.outcome.emit({ kind: 'problems', problems: problems.problems });
      } else {
        this.failed.set(true);
        this.outcome.emit({ kind: 'failed' });
      }
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }

  /** One page as PNG; past the last page none, with how many there are. */
  private async page(
    request: TemplatePreviewRequest,
    page: number,
  ): Promise<{ png: Blob | null; pages: number | null }> {
    const params = new HttpParams({
      fromObject: {
        width: RENDER_WIDTH,
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.ref && request.live ? { workingCopy: 'true' } : {}),
        ...(request.designId ? { design: request.designId } : {}),
      },
    });
    try {
      const png = await firstValueFrom(
        this.http
          .get(
            `${this.base}/page-design-templates/${encodeURIComponent(request.templateId)}/preview/pages/${page}.png`,
            { params, headers: { Accept: 'image/png' }, responseType: 'blob' },
          )
          .pipe(takeUntil(this.cancel)),
      );
      return { png, pages: null };
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) {
        const pages = await pagesOf(error);
        if (pages !== null) return { png: null, pages };
      }
      throw error;
    }
  }

  private show(next: string | null): void {
    const before = this.url();
    this.url.set(next);
    if (before) URL.revokeObjectURL(before);
  }
}

/** How many pages a 404 past the last page says there are (`meta.pages`), else null. */
async function pagesOf(error: HttpErrorResponse): Promise<number | null> {
  try {
    const body: unknown =
      error.error instanceof Blob
        ? JSON.parse(await error.error.text())
        : error.error;
    const pages = (body as { errors?: { meta?: { pages?: unknown } }[] })
      ?.errors?.[0]?.meta?.pages;
    return typeof pages === 'number' ? pages : null;
  } catch {
    return null;
  }
}
