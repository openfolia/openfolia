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
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronLeft,
  lucideChevronRight,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom, Subject, takeUntil, type Observable } from 'rxjs';

import { PAGE_SIZE_MM, type PageSize } from '@openfolia/content-model/core';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import { API_BASE_URL, ApiClient, ApiError, type Schema } from '../../api';

/** Rendered at twice the shown width, for sharp pages on dense screens. */
const RENDER_WIDTH = 2 * 240;
/** After a save, the pages wait this long for more saves before rendering again. */
export const PREVIEW_DELAY_MS = 600;
/** The inner page shown first: after the title page and the contents. */
export const FIRST_INNER_PAGE = 3;
const WARNINGS_PAGE = 50;

/** What the preview renders; a new value renders it again at once. */
export interface DesignPreviewRequest {
  readonly manualId: string;
  readonly variant: string;
  readonly lang: string;
  readonly designId: string;
  /** The change set's branch; null: the released content. */
  readonly ref: string | null;
  /** The person's own draft: its working copies, the design's included (`?workingCopy=true`). */
  readonly live: boolean;
}

export type LayoutWarning = Schema<'LayoutWarningResource'>;

interface Shown {
  readonly title: string;
  /** The inner page, or null when the PDF has only its title page. */
  readonly inner: string | null;
  readonly innerNumber: number;
}

const AT_LABELS: Readonly<Record<string, string>> = {
  header: 'editor.admin.pageDesigns.preview.places.header',
  footer: 'editor.admin.pageDesigns.preview.places.footer',
  regions: 'editor.admin.pageDesigns.preview.places.region',
};

/**
 * The design screen's live preview (#392): the title page and an inner page of a manual's real
 * PDF laid out with the design (`?design=`, the working copy with `?workingCopy=true`), as PNG,
 * and what the layout could not fit (`…/pdf/layout-warnings`) beside them. After each save
 * (`revision`) they render again, a short while after the last one; meanwhile the old pages stay,
 * dimmed, in boxes of the page's own shape, so nothing jumps. A pager steps through the inner
 * pages, from the first after the contents.
 */
@Component({
  selector: 'of-design-preview',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, ZardSkeletonComponent],
  viewProviders: [
    provideIcons({
      lucideChevronLeft,
      lucideChevronRight,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div
      class="grid min-w-0 grid-cols-2 gap-3"
      data-slot="design-preview-pages"
      [attr.aria-busy]="loading()"
    >
      @for (slot of slots; track slot) {
        <figure class="m-0 flex min-w-0 flex-col gap-1.5">
          <div
            class="bg-background ring-border/60 relative w-full overflow-hidden rounded-sm shadow-md ring-1"
            [style.aspect-ratio]="aspect()"
          >
            @if (urlOf(slot); as url) {
              <img
                class="absolute inset-0 block size-full object-contain motion-safe:transition-opacity motion-safe:duration-300"
                [class.opacity-60]="loading()"
                [attr.data-page]="slot"
                [src]="url"
                [alt]="
                  (slot === 'title'
                    ? 'editor.admin.pageDesigns.preview.titleAlt'
                    : 'editor.admin.pageDesigns.preview.innerAlt'
                  ) | transloco: { page: shown()?.innerNumber ?? 0 }
                "
              />
            } @else if (shown() && slot === 'inner') {
              <p
                class="text-muted-foreground absolute inset-0 m-0 flex items-center justify-center p-3 text-center text-xs"
              >
                {{ 'editor.admin.pageDesigns.preview.noInner' | transloco }}
              </p>
            } @else if (!error()) {
              <z-skeleton class="absolute inset-0 size-full rounded-none" />
            }
          </div>
          <figcaption
            class="text-muted-foreground flex min-h-7 items-center justify-between gap-1 text-xs"
          >
            @if (slot === 'title') {
              {{ 'editor.admin.pageDesigns.preview.titlePage' | transloco }}
            } @else {
              <span>{{
                'editor.admin.pageDesigns.preview.page'
                  | transloco: { page: wanted() }
              }}</span>
              <span class="flex items-center">
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="size-7 p-0"
                  data-slot="preview-page-back"
                  [zDisabled]="wanted() <= 2"
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
                  class="size-7 p-0"
                  data-slot="preview-page-next"
                  [zDisabled]="lastPage() !== null && wanted() >= lastPage()!"
                  [attr.aria-label]="
                    'editor.admin.pageDesigns.preview.next' | transloco
                  "
                  (click)="step(1)"
                >
                  <ng-icon name="lucideChevronRight" aria-hidden="true" />
                </button>
              </span>
            }
          </figcaption>
        </figure>
      }
    </div>

    <p class="sr-only" role="status">
      @if (loading()) {
        {{ 'editor.admin.pageDesigns.preview.rendering' | transloco }}
      }
    </p>

    @if (error()) {
      <div
        class="border-destructive/40 text-destructive flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
        role="alert"
        data-slot="preview-error"
      >
        @if (problems().length) {
          <div
            class="flex min-w-0 flex-1 basis-full flex-col gap-1"
            data-slot="template-problems"
          >
            <span class="min-w-0 break-words font-medium">{{
              'editor.admin.pageDesigns.preview.templateFailed'
                | transloco: { template: problemsOf() }
            }}</span>
            <ul class="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
              @for (p of problems(); track $index) {
                <li class="min-w-0 break-words" data-slot="template-problem">
                  <span class="font-mono break-all">{{
                    'editor.admin.pageDesigns.preview.templateAt'
                      | transloco
                        : { file: p.file, line: p.line, column: p.column }
                  }}</span>
                  {{ p.message }}
                </li>
              }
            </ul>
          </div>
        } @else {
          <span class="min-w-0 flex-1 break-words">{{
            'editor.admin.pageDesigns.preview.failed' | transloco
          }}</span>
        }
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

    <section
      class="flex min-w-0 flex-col gap-1.5"
      aria-labelledby="preview-warnings-heading"
      data-slot="layout-warnings"
    >
      <h3 id="preview-warnings-heading" class="m-0 text-sm font-medium">
        {{ 'editor.admin.pageDesigns.preview.warnings' | transloco }}
      </h3>
      @if (warnings(); as list) {
        @if (list.length === 0) {
          <p class="text-muted-foreground m-0 text-xs" data-slot="no-warnings">
            {{ 'editor.admin.pageDesigns.preview.fits' | transloco }}
          </p>
        } @else {
          <ul
            class="m-0 flex list-none flex-col gap-1.5 p-0 motion-safe:transition-opacity motion-safe:duration-300"
            [class.opacity-60]="loading()"
          >
            @for (w of list; track w.id) {
              <li
                class="bg-muted/60 flex min-w-0 gap-2 rounded-md px-2.5 py-2 text-xs"
                [attr.data-warning]="w.attributes.code"
                [attr.data-at]="w.attributes.at"
              >
                <ng-icon
                  name="lucideTriangleAlert"
                  class="text-warning mt-0.5 shrink-0"
                  size="14"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {{
                    (w.attributes.code === 'running-head-truncated'
                      ? 'editor.admin.pageDesigns.preview.truncated'
                      : 'editor.admin.pageDesigns.preview.overflow'
                    )
                      | transloco
                        : {
                            place: placeOf(w.attributes.at) | transloco,
                            page: w.attributes.page,
                            pages: w.attributes.pages,
                          }
                  }}
                  @if (w.attributes.text) {
                    <span class="text-muted-foreground block">{{
                      w.attributes.text
                    }}</span>
                  }
                </span>
              </li>
            }
          </ul>
        }
      } @else {
        @if (!warningsError()) {
          <z-skeleton class="h-4 w-48" />
        }
      }
      @if (warningsError()) {
        <div
          class="border-destructive/40 text-destructive flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
          role="alert"
          data-slot="warnings-error"
        >
          <span class="min-w-0 flex-1 break-words">{{
            'editor.admin.pageDesigns.preview.warningsFailed' | transloco
          }}</span>
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            (click)="retryWarnings()"
          >
            {{ 'editor.admin.pageDesigns.preview.retry' | transloco }}
          </button>
        </div>
      }
    </section>
  `,
})
export class DesignPreviewComponent {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiClient);
  private readonly base = inject(API_BASE_URL);

  /** What to render; null renders nothing (no manual yet). */
  readonly request = input<DesignPreviewRequest | null>(null);
  /** Changes after each save of the working copy: the pages render again, debounced. */
  readonly revision = input(0);
  readonly delayMs = input(PREVIEW_DELAY_MS);
  /** The page size, for the boxes' shape before the pages are there. */
  readonly pageSize = input<PageSize>('a4');

  protected readonly slots = ['title', 'inner'] as const;
  protected readonly shown = signal<Shown | null>(null);
  protected readonly warnings = signal<readonly LayoutWarning[] | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  /** Why the design's own template does not compile (#396): shown in place of the pages. */
  protected readonly problems = signal<readonly TemplateProblem[]>([]);
  protected readonly problemsOf = signal('');
  /** The pages are in, their warnings could not be read: retried on their own. */
  protected readonly warningsError = signal(false);
  /** The inner page asked for. */
  protected readonly wanted = signal(FIRST_INNER_PAGE);
  /** The PDF's last page, once known (a page past it answered how many there are). */
  protected readonly lastPage = signal<number | null>(null);

  protected readonly aspect = computed(() => {
    const { width, height } = PAGE_SIZE_MM[this.pageSize()] ?? PAGE_SIZE_MM.a4;
    return `${width} / ${height}`;
  });

  private readonly key = computed(() => {
    const r = this.request();
    return r
      ? [r.manualId, r.variant, r.lang, r.designId, r.ref ?? ''].join('\n')
      : null;
  });
  /** Whether the working copy is read: turning on with the first save renders again, debounced, like a save. */
  private readonly live = computed(() => this.request()?.live ?? false);
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey: string | null = null;
  /** Cancels the requests of the render under way: a newer one replaces it (#557). */
  private readonly cancel = new Subject<void>();

  constructor() {
    effect(() => {
      const key = this.key();
      this.revision();
      this.live();
      untracked(() => {
        const changed = key !== this.lastKey;
        this.lastKey = key;
        clearTimeout(this.timer);
        if (key === null) {
          this.stop();
          this.error.set(false);
          this.show(null);
          this.warnings.set(null);
          this.loading.set(false);
          return;
        }
        if (changed) {
          // Another manual, variant or language: the old pages would mislead.
          this.show(null);
          this.warnings.set(null);
          this.lastPage.set(null);
          this.wanted.set(FIRST_INNER_PAGE);
          void this.render();
        } else {
          // A newer save: what is rendering now is already stale. The old pages stay, dimmed.
          if (this.loading()) this.stop();
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

  protected urlOf(slot: 'title' | 'inner'): string | null {
    const s = this.shown();
    if (!s) return null;
    return slot === 'title' ? s.title : s.inner;
  }

  protected placeOf(at: string): string {
    return (
      AT_LABELS[at.split('.')[0] ?? ''] ??
      'editor.admin.pageDesigns.preview.places.page'
    );
  }

  protected step(by: number): void {
    const next = Math.max(2, this.wanted() + by);
    const last = this.lastPage();
    if (last !== null && next > last) return;
    this.wanted.set(next);
    clearTimeout(this.timer);
    void this.render();
  }

  protected retry(): void {
    clearTimeout(this.timer);
    void this.render();
  }

  /** Reads the warnings of the pages shown again, without rendering them again (#557). */
  protected retryWarnings(): void {
    const request = this.request();
    if (!request || this.loading()) return;
    void this.readWarnings(request, this.runs);
  }

  /** Ends the render under way: its answers no longer count and its requests are cancelled. */
  private stop(): void {
    this.runs++;
    this.cancel.next();
  }

  private untilStopped<T>(request: Observable<T>): Promise<T> {
    return firstValueFrom(request.pipe(takeUntil(this.cancel)));
  }

  private async readWarnings(
    request: DesignPreviewRequest,
    run: number,
  ): Promise<void> {
    this.warningsError.set(false);
    try {
      const warnings = await this.layoutWarnings(request);
      if (run === this.runs) this.warnings.set(warnings);
    } catch {
      // The warnings shown were the earlier pages': none rather than wrong ones.
      if (run === this.runs) {
        this.warnings.set(null);
        this.warningsError.set(true);
      }
    }
  }

  private async render(): Promise<void> {
    const request = this.request();
    if (!request) return;
    this.stop();
    const run = this.runs;
    this.loading.set(true);
    this.error.set(false);
    this.problems.set([]);
    this.warningsError.set(false);
    const made: string[] = [];
    try {
      const title = await this.page(request, 1);
      if (run !== this.runs || !title.png) return;
      made.push(this.url(title.png));
      let number = this.wanted();
      let inner = await this.page(request, number);
      if (run !== this.runs) return;
      if (!inner.png && inner.pages !== null && inner.pages >= 2) {
        // Fewer pages than asked for: the last one.
        number = inner.pages;
        this.lastPage.set(inner.pages);
        inner = await this.page(request, number);
        if (run !== this.runs) return;
      }
      if (inner.png) made.push(this.url(inner.png));
      this.wanted.set(number);
      this.show({
        title: made[0] as string,
        inner: made[1] ?? null,
        innerNumber: number,
      });
      made.length = 0;
      await this.readWarnings(request, run);
    } catch (error) {
      if (run === this.runs) {
        const broken = await templateErrorOf(error);
        this.problems.set(broken?.problems ?? []);
        this.problemsOf.set(broken?.template ?? '');
        // The template's pages and their warnings would mislead: none until it compiles again.
        if (broken) {
          this.show(null);
          this.warnings.set(null);
        }
        this.error.set(true);
      }
    } finally {
      made.forEach((u) => URL.revokeObjectURL(u));
      if (run === this.runs) this.loading.set(false);
    }
  }

  private url(png: Blob): string {
    // Always typed as PNG, whatever the answer named: never shown as anything else.
    return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  }

  private query(request: DesignPreviewRequest): Record<string, string> {
    return {
      design: request.designId,
      ...(request.ref ? { ref: request.ref } : {}),
      ...(request.ref && request.live ? { workingCopy: 'true' } : {}),
    };
  }

  /** One page as PNG; past the last page none, with how many there are. */
  private async page(
    request: DesignPreviewRequest,
    page: number,
  ): Promise<{ png: Blob | null; pages: number | null }> {
    const e = encodeURIComponent;
    const params = new HttpParams({
      fromObject: { width: RENDER_WIDTH, ...this.query(request) },
    });
    try {
      const png = await this.untilStopped(
        this.http.get(
          `${this.base}/manuals/${e(request.manualId)}/variants/${e(request.variant)}/${e(request.lang)}/pdf/pages/${page}.png`,
          { params, headers: { Accept: 'image/png' }, responseType: 'blob' },
        ),
      );
      return { png, pages: null };
    } catch (error) {
      if (
        page > 1 &&
        error instanceof HttpErrorResponse &&
        error.status === 404
      ) {
        return { png: null, pages: await pagesOf(error) };
      }
      throw error;
    }
  }

  private async layoutWarnings(
    request: DesignPreviewRequest,
  ): Promise<readonly LayoutWarning[]> {
    const doc = await this.untilStopped(
      this.api.get(
        '/manuals/{id}/variants/{variant}/{lang}/pdf/layout-warnings',
        {
          path: {
            id: request.manualId,
            variant: request.variant,
            lang: request.lang,
          },
          query: {
            ...this.query(request),
            'page[size]': WARNINGS_PAGE,
          } as never,
        },
      ),
    );
    return doc.data;
  }

  /** Shows these pages and releases the URLs of the ones before. */
  private show(next: Shown | null): void {
    const before = this.shown();
    this.shown.set(next);
    if (before) {
      URL.revokeObjectURL(before.title);
      if (before.inner) URL.revokeObjectURL(before.inner);
    }
  }
}

/** How many pages a 404 past the last page says the PDF has (`meta.pages`), else null. */
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

/** Where a design's own template does not compile, as the API answers it (`template-error`). */
export interface TemplateProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/**
 * The template and its problems when `error` is the API's `template-error` (#396), else
 * undefined. Read as data: only strings and numbers are kept, at most `MAX_PROBLEMS`.
 */
export async function templateErrorOf(
  error: unknown,
): Promise<{ template: string; problems: TemplateProblem[] } | undefined> {
  if (error instanceof ApiError) {
    // Through the API's interceptor: the error objects are read already.
    return error.status === 422 ? templateErrorIn(error.errors[0]) : undefined;
  }
  if (!(error instanceof HttpErrorResponse) || error.status !== 422) {
    return undefined;
  }
  try {
    const body: unknown =
      error.error instanceof Blob
        ? JSON.parse(await error.error.text())
        : error.error;
    return templateErrorIn((body as { errors?: unknown[] })?.errors?.[0]);
  } catch {
    return undefined;
  }
}

function templateErrorIn(
  error: unknown,
): { template: string; problems: TemplateProblem[] } | undefined {
  const first = error as
    | { code?: unknown; meta?: { template?: unknown; problems?: unknown } }
    | undefined;
  if (first?.code !== 'template-error') return undefined;
  const raw = Array.isArray(first.meta?.problems) ? first.meta.problems : [];
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  const problems = raw.slice(0, MAX_PROBLEMS).map((p: unknown) => {
    const r = (p ?? {}) as Record<string, unknown>;
    return {
      file: text(r['file']),
      line: count(r['line']),
      column: count(r['column']),
      message: text(r['message']),
    };
  });
  return { template: text(first.meta?.template), problems };
}

const MAX_PROBLEMS = 20;
