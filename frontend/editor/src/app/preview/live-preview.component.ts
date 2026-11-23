import { HttpParams } from '@angular/common/http';
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
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  NoAccessStateComponent,
} from '@openfolia/ui/states';
import { ThemeService } from '@openfolia/ui/theme';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText, type ShownConfig, UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import { ChangeSetUrl } from '../session/change-set-url';
import { HiddenContentBarComponent } from './hidden-content-bar.component';
import {
  PreviewFrameComponent,
  type ScrollAnchor,
} from './preview-frame.component';
import {
  chooseLanguage,
  chooseVariant,
  HIDDEN_PAGE_SIZE,
  manualsFor,
  previewPath,
  type HiddenDoc,
  type ManualItem,
  type VariantSummary,
} from './preview-model';
import { PreviewPages } from './preview-pages';

/** The configuration with its labels in the interface language (#731). */
type Config = ShownConfig;

/** How long the page waits after an autosave landed before it renders again. */
export const LIVE_DEBOUNCE_MS = 400;
const MANUAL_PAGES = 10;
const MANUAL_PAGE_SIZE = 100;

type Slot = 'a' | 'b';

/** A page in one of the two frames, with the images it shows. */
interface Shown {
  readonly key: string;
  readonly document: string;
  readonly images: readonly string[];
}

/**
 * The live preview beside the module editor (#237): the module rendered as a reader sees it, in
 * a language and variant, from the person's own working copy (`?workingCopy=true`) while they
 * edit their draft, else as the branch or the released content holds it. It renders again a
 * moment after each autosave lands (`revision`). Two frames take turns: the next page loads in the
 * hidden one while the last stays in view, dimmed, and takes the reader's place by block before
 * it is shown, so the page never flashes or jumps. Above it, what the variant hides. A click on a
 * block names it (`blockClick`), for the editor to go there.
 */
@Component({
  selector: 'of-live-preview',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    FadeInDirective,
    HiddenContentBarComponent,
    PreviewFrameComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideExternalLink, lucideX })],
  host: { class: 'flex min-h-0 min-w-0 flex-col gap-2' },
  styles: `
    .of-live-frame {
      transition: opacity 150ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .of-live-frame {
        transition: none;
      }
    }
  `,
  template: `
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="m-0 me-auto text-sm font-medium">
        {{ heading() || ('editor.livePreview.title' | transloco) }}
        @if (withUnsaved()) {
          <span class="text-muted-foreground font-normal">
            · {{ 'editor.livePreview.unsaved' | transloco }}</span
          >
        }
      </h2>
      @if (languages().length > 1) {
        <z-select
          class="w-auto min-w-28"
          zPosition="popper"
          [zAriaLabel]="'editor.preview.language' | transloco"
          [zValue]="chosenLang() ?? ''"
          (zSelectionChange)="pickLang($event)"
        >
          @for (l of languages(); track l) {
            <z-select-item [zValue]="l">{{ languageLabel(l) }}</z-select-item>
          }
        </z-select>
      }
      @if (variants().length > 0) {
        <z-select
          class="w-auto max-w-56 min-w-28"
          zPosition="popper"
          [zAriaLabel]="'editor.preview.variant' | transloco"
          [zValue]="chosenVariant()?.slug ?? ''"
          (zSelectionChange)="pickVariant($event)"
        >
          @for (v of variants(); track v.slug) {
            <z-select-item [zValue]="v.slug">{{ v.label }}</z-select-item>
          }
        </z-select>
      }
      <a
        z-button
        zType="ghost"
        zSize="icon-sm"
        routerLink="/preview"
        [queryParams]="fullPreview()"
        [attr.aria-label]="'editor.livePreview.open' | transloco"
        [attr.title]="'editor.livePreview.open' | transloco"
      >
        <ng-icon name="lucideExternalLink" aria-hidden="true" />
      </a>
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        type="button"
        [attr.aria-label]="'editor.livePreview.close' | transloco"
        [attr.title]="'editor.livePreview.close' | transloco"
        (click)="closed.emit()"
      >
        <ng-icon name="lucideX" aria-hidden="true" />
      </button>
    </div>

    <of-hidden-content-bar
      [hidden]="hidden()"
      [loading]="hiddenLoading()"
      [failed]="hiddenFailed()"
      [open]="listOpen()"
      [config]="config()"
      [source]="
        withUnsaved()
          ? 'editor.preview.hidden.unsaved'
          : readRef.ref()
            ? 'editor.preview.hidden.draft'
            : 'editor.preview.hidden.released'
      "
      listOffset="60dvh"
      (toggled)="listShown.set(!listShown())"
      (retry)="hiddenReloads.set(hiddenReloads() + 1)"
      (pageChange)="hiddenPage.set($event)"
    />

    <div
      class="bg-muted relative min-h-80 flex-1 overflow-hidden rounded-xl p-2"
    >
      @if (failure(); as e) {
        <div
          ofFadeIn
          class="bg-background flex h-full flex-col justify-center rounded-lg p-6"
        >
          @if (e.kind === 'unauthorized') {
            <of-no-access [heading]="'editor.preview.noAccess' | transloco" />
          } @else {
            <of-error-state
              [kind]="e.kind"
              [heading]="
                (e.kind === 'not-found'
                  ? 'editor.livePreview.notFound'
                  : 'editor.preview.loadFailed'
                ) | transloco
              "
              [message]="errorText(e)"
              (retry)="reload()"
            />
          }
        </div>
      } @else if (!a() && !b()) {
        <div
          ofFadeIn="delayed"
          class="bg-background flex h-full flex-col gap-3 rounded-lg p-6 shadow-sm"
          role="status"
          aria-busy="true"
        >
          <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
          <z-skeleton class="h-7 w-48" aria-hidden="true" />
          <z-skeleton class="h-4 w-full" aria-hidden="true" />
          <z-skeleton class="h-4 w-5/6" aria-hidden="true" />
          <z-skeleton class="mt-3 h-20 w-full" aria-hidden="true" />
        </div>
      }
      @if (a(); as s) {
        <of-preview-frame
          #frameA
          class="of-live-frame bg-background absolute inset-2 overflow-hidden rounded-lg shadow-sm"
          [class.opacity-0]="front() !== 'a' || !!failure()"
          [attr.inert]="front() !== 'a' || !!failure() ? '' : null"
          [class.opacity-60]="loading() && front() === 'a' && !failure()"
          [attr.aria-busy]="loading() && front() === 'a' ? 'true' : null"
          [document]="s.document"
          [dark]="dark()"
          [label]="'editor.preview.frame' | transloco: { title: title() }"
          (loaded)="frameLoaded('a')"
          (blockClick)="blockClick.emit($event)"
        />
      }
      @if (b(); as s) {
        <of-preview-frame
          #frameB
          class="of-live-frame bg-background absolute inset-2 overflow-hidden rounded-lg shadow-sm"
          [class.opacity-0]="front() !== 'b' || !!failure()"
          [attr.inert]="front() !== 'b' || !!failure() ? '' : null"
          [class.opacity-60]="loading() && front() === 'b' && !failure()"
          [attr.aria-busy]="loading() && front() === 'b' ? 'true' : null"
          [document]="s.document"
          [dark]="dark()"
          [label]="'editor.preview.frame' | transloco: { title: title() }"
          (loaded)="frameLoaded('b')"
          (blockClick)="blockClick.emit($event)"
        />
      }
    </div>
  `,
})
export class LivePreviewComponent {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly pages = inject(PreviewPages);
  private readonly me = inject(MeService);
  protected readonly readRef = inject(ReadRef);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly t = injectTranslate();

  readonly moduleId = input.required<string>();
  /** The module's title, for the frame's name. */
  readonly title = input('');
  /** The editor's language: the default. */
  readonly editorLang = input.required<string>();
  /** The language asked for (the address); none: the editor's. */
  readonly lang = input<string | undefined>(undefined);
  /** The languages the module exists in. */
  readonly languages = input<readonly string[]>([]);
  /** The variant asked for (the address, a slug); none: the first offered. */
  readonly variant = input<string | undefined>(undefined);
  /** Read the change set's working copies (the person's own draft, being edited). */
  readonly live = input(false);
  /** The working copy holds changes no save point has yet: the heading says so (#694). */
  readonly unsaved = input(false);
  /** Changes whenever an autosave landed: the page renders again a moment later. */
  readonly revision = input<unknown>(null);
  readonly config = input<Config | null>(null);
  /** Replaces the heading (the module editor's source beside a translation). */
  readonly heading = input('');

  readonly langChange = output<string>();
  readonly variantChange = output<string>();
  /** The variant shown (the one asked for, else the first offered), each time it changes; null: none. */
  readonly shownVariant = output<VariantSummary | null>();
  readonly closed = output<void>();
  /** A block of the page was clicked: its ID. */
  readonly blockClick = output<string>();

  protected readonly a = signal<Shown | null>(null);
  protected readonly b = signal<Shown | null>(null);
  /** The frame in view; the other loads the next page. */
  protected readonly front = signal<Slot | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly hidden = signal<HiddenDoc | null>(null);
  protected readonly hiddenLoading = signal(false);
  protected readonly hiddenFailed = signal(false);
  protected readonly listShown = signal(false);
  protected readonly hiddenPage = signal(1);
  protected readonly hiddenReloads = signal(0);
  private readonly reloads = signal(0);
  /** The manuals read for the variants; null until they are (the page waits for its variant). */
  private readonly manuals = signal<readonly ManualItem[] | null>(null);

  private readonly frameA = viewChild<PreviewFrameComponent>('frameA');
  private readonly frameB = viewChild<PreviewFrameComponent>('frameB');

  private runs = 0;
  private hiddenRuns = 0;
  private manualRuns = 0;
  /** The slot waiting for its frame to load before it is shown. */
  private incoming: Slot | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private manualsKey: string | null = null;
  private manualsMoves = 0;

  /** Read from the working copy while it holds changes no save point has yet. */
  protected readonly withUnsaved = computed(
    () => this.live() && this.unsaved(),
  );

  protected readonly dark = computed(() => this.theme.resolved() === 'dark');

  /**
   * The variants of the manuals the module is in, each once, in manual order, each by its label in
   * the interface language (#731).
   */
  protected readonly variants = computed((): VariantSummary[] => {
    const seen = new Set<string>();
    const found: VariantSummary[] = [];
    const config = this.config();
    for (const manual of manualsFor(this.manuals() ?? [], this.moduleId())) {
      for (const v of manual.meta.variants) {
        if (seen.has(v.slug)) continue;
        seen.add(v.slug);
        found.push({
          ...v,
          label: this.texts.variant(v.values, config, v.label),
        });
      }
    }
    return found;
  });
  protected readonly chosenVariant = computed(() =>
    chooseVariant(this.variants(), this.variant()),
  );
  protected readonly chosenLang = computed(() =>
    chooseLanguage(
      this.languages().length > 0 ? this.languages() : [this.editorLang()],
      this.lang() ?? this.editorLang(),
      this.editorLang(),
    ),
  );

  protected readonly listOpen = computed(
    () => this.listShown() && (this.hidden()?.meta.page.total ?? 0) > 0,
  );

  /** The preview screen for the same module, language and variant. */
  protected readonly fullPreview = computed(() => ({
    ...this.csLink.params(),
    module: this.moduleId(),
    lang: this.chosenLang() ?? undefined,
    variant: this.chosenVariant()?.slug,
  }));

  /** What to render: a new key renders at once, the same key again after an autosave. */
  private readonly request = computed(
    () => {
      const lang = this.chosenLang();
      const path = lang
        ? previewPath('module', {
            module: this.moduleId(),
            manual: null,
            lang,
            variant: null,
          })
        : null;
      if (!lang || !path || this.manuals() === null) return null;
      const ref = this.readRef.ref();
      const live = !!ref && this.live();
      const variant = this.chosenVariant()?.slug ?? null;
      return {
        // The branch's moves to a new head (an update from its base, #491): read there at once.
        key: [
          this.me.me().id,
          ref ?? '',
          this.readRef.moves(),
          path,
          variant ?? '',
          live,
        ].join('\n'),
        path,
        ref,
        live,
        lang,
        variant,
      };
    },
    { equal: (x, y) => x?.key === y?.key },
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The editor numbers image callouts in the variant shown here (#547).
    let shown: string | null | undefined;
    effect(() => {
      const variant = this.chosenVariant();
      untracked(() => {
        if ((variant?.slug ?? null) === shown) return;
        shown = variant?.slug ?? null;
        this.shownVariant.emit(variant);
      });
    });
    // The manuals (for the variants), for whoever acts, at the ref; at a new head of the same
    // branch (an update from its base, #491) read again, those shown kept meanwhile.
    effect(() => {
      const key = `${this.me.me().id}\n${this.readRef.ref() ?? ''}`;
      const moves = this.readRef.moves();
      untracked(() => void this.loadManuals(key, moves));
    });
    let last: string | null = null;
    let lastReload = 0;
    effect(() => {
      const request = this.request();
      this.revision();
      const reload = this.reloads();
      untracked(() => {
        clearTimeout(this.timer);
        // Another module, language or variant, or "Try again": at once. The same one after an
        // autosave: once typing has had a moment to settle.
        const wait =
          request?.key === last && reload === lastReload ? LIVE_DEBOUNCE_MS : 0;
        last = request?.key ?? null;
        lastReload = reload;
        this.timer = setTimeout(() => void this.load(request), wait);
      });
    });
    effect(() => {
      const request = this.request();
      const page = this.hiddenPage();
      this.revision();
      this.hiddenReloads();
      untracked(() => void this.loadHidden(request, page));
    });
    // Another module, language or variant: the list starts again at its first page.
    effect(() => {
      this.request();
      untracked(() => this.hiddenPage.set(1));
    });
    destroyRef.onDestroy(() => {
      clearTimeout(this.timer);
      this.runs++;
      this.hiddenRuns++;
      this.manualRuns++;
      for (const slot of [this.a(), this.b()]) this.release(slot);
    });
  }

  protected reload(): void {
    this.failure.set(null);
    this.reloads.update((n) => n + 1);
  }

  protected pickLang(value: string | string[]): void {
    const lang = Array.isArray(value) ? value[0] : value;
    if (lang) this.langChange.emit(lang);
  }

  protected pickVariant(value: string | string[]): void {
    const slug = Array.isArray(value) ? value[0] : value;
    if (slug) this.variantChange.emit(slug);
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected errorText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  /** A frame has loaded its page: the incoming one takes the reader's place, then the stage. */
  protected frameLoaded(slot: Slot): void {
    if (slot !== this.incoming) return;
    this.incoming = null;
    const current = this.front();
    const from = current ? this.frame(current)?.anchor() : null;
    this.frame(slot)?.restore(from ?? null);
    this.front.set(slot);
    this.loading.set(false);
  }

  private frame(slot: Slot): PreviewFrameComponent | undefined {
    return slot === 'a' ? this.frameA() : this.frameB();
  }

  private release(shown: Shown | null): void {
    for (const url of shown?.images ?? []) URL.revokeObjectURL(url);
  }

  private async load(
    request: LivePreviewComponent['request'] extends () => infer R ? R : never,
  ): Promise<void> {
    const run = ++this.runs;
    if (!request) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      let params = new HttpParams().set('theme', 'light');
      if (request.ref) params = params.set('ref', request.ref);
      if (request.live) params = params.set('workingCopy', 'true');
      if (request.variant) params = params.set('variant', request.variant);
      const read = await this.pages.read(
        request.path,
        params,
        () => run === this.runs,
      );
      if (!read) return;
      const shown: Shown = {
        key: request.key,
        document: this.pages.document(read, this.dark()),
        images: [...read.images.values()],
      };
      this.failure.set(null);
      const front = this.front();
      const inView = front === 'a' ? this.a() : front === 'b' ? this.b() : null;
      // The same page as the one in view (an edit the variant hides, an undo): nothing to swap.
      if (inView?.document === shown.document && this.incoming === null) {
        this.release(shown);
        this.loading.set(false);
        return;
      }
      // The frame not in view takes it; a page still loading there is replaced.
      const slot: Slot = front === 'a' ? 'b' : 'a';
      const target = slot === 'a' ? this.a : this.b;
      const inFlight = this.incoming === slot;
      // That very page is still loading there: its `load` finishes the swap.
      if (inFlight && target()?.document === shown.document) {
        this.release(shown);
        return;
      }
      const same = target()?.document === shown.document;
      this.release(target());
      this.incoming = slot;
      target.set(shown);
      // The frame holds this very document already: it loads no more, so it is shown now.
      if (same) this.frameLoaded(slot);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
      this.loading.set(false);
    }
  }

  private async loadHidden(
    request: LivePreviewComponent['request'] extends () => infer R ? R : never,
    page: number,
  ): Promise<void> {
    const run = ++this.hiddenRuns;
    this.hiddenFailed.set(false);
    if (!request) {
      this.hidden.set(null);
      return;
    }
    this.hiddenLoading.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.get('/modules/{lang}/{id}/hidden-content', {
          path: { lang: request.lang, id: this.moduleId() },
          query: {
            ...pageQuery({ number: page, size: HIDDEN_PAGE_SIZE }),
            ...(request.variant ? { variant: request.variant } : {}),
            ...(request.live && { workingCopy: 'true' as const }),
          },
        }),
      );
      if (run !== this.hiddenRuns) return;
      const lastPage = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > lastPage) {
        this.hiddenPage.set(lastPage);
        return;
      }
      this.hidden.set(doc);
    } catch {
      if (run !== this.hiddenRuns) return;
      this.hidden.set(null);
      this.hiddenFailed.set(true);
    }
    this.hiddenLoading.set(false);
  }

  /**
   * The manuals, read once per person and ref (`key`) and head (`moves`); at a new head of the
   * same ref, the manuals shown stay until read.
   */
  private async loadManuals(key: string, moves: number): Promise<void> {
    const sameRef = key === this.manualsKey;
    if (sameRef && moves === this.manualsMoves) return;
    this.manualsKey = key;
    this.manualsMoves = moves;
    const run = ++this.manualRuns;
    if (!sameRef) this.manuals.set(null);
    const found: ManualItem[] = [];
    try {
      for (let page = 1; page <= MANUAL_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/manuals', {
            query: pageQuery({ number: page, size: MANUAL_PAGE_SIZE }),
          }),
        );
        for (const manual of doc.data) {
          if ('attributes' in manual) found.push(manual);
        }
        if (!doc.links.next) break;
      }
    } catch {
      // No variants to choose from: the module is previewed without one.
    }
    if (run === this.manualRuns) this.manuals.set(found);
  }
}
