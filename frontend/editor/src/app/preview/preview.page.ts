import { HttpClient, HttpParams } from '@angular/common/http';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleSlash, lucideFileText } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSelectImports } from '@openfolia/ui/select';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
} from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ThemeService } from '@openfolia/ui/theme';
import { ToastService } from '@openfolia/ui/toast';

import {
  API_BASE_URL,
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { DesignInUseComponent } from '../admin/page-designs/design-in-use.component';
import { HiddenContentBarComponent } from './hidden-content-bar.component';
import { PreviewPages } from './preview-pages';
import { languageName } from '../content/browser-model';
import { injectPersonName, injectPersonText } from '../history/history-model';
import { apiErrorText, UiTexts } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import { injectFailureText } from '../session/failure-text';
import { injectQueryState } from '../view-state';
import { PreviewFrameComponent } from './preview-frame.component';
import {
  chooseLanguage,
  chooseManual,
  chooseVariant,
  HIDDEN_PAGE_SIZE,
  manualsFor,
  PREVIEW_VIEW,
  previewPath,
  type HiddenDoc,
  type ManualItem,
  type PreviewScope,
} from './preview-model';

type Config = Response<'/config'>['data']['attributes'];
type Withdrawal = NonNullable<
  Response<'/releases'>['data'][number]['attributes']['withdrawal']
>;

/** What the page is about, read once per person, ref and module. */
interface Context {
  readonly key: string;
  readonly config: Config;
  readonly manuals: readonly ManualItem[];
  /** The module's title and languages; none without `?module=`. */
  readonly module: {
    readonly title: string;
    readonly languages: readonly string[];
  } | null;
}

/** The rendered page, ready for the frame. */
interface Shown {
  readonly key: string;
  readonly document: string;
  readonly title: string;
}

/** At most this many pages of manuals are read to find the ones using the module. */
const MANUAL_PAGES = 10;
const MANUAL_PAGE_SIZE = 100;
const SUMMARY_PAGE_SIZE = 100;
/** At most this many pages of withdrawn releases are looked through for the tag's. */
const WITHDRAWN_PAGES = 5;
const WITHDRAWN_PAGE_SIZE = 200;
/** Space kept below the preview: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * Screen 11, the preview (`/preview`): a module (`?module=`) or a whole manual (`?manual=`, or
 * `?scope=manual` with a module) as a reader sees it, per language, variant and output, read at
 * the chosen change set (an author's draft) or the released content. HTML shows the API's
 * rendered page in a sandboxed frame (`PreviewFrameComponent`, `previewDocument`); PDF builds the
 * manual's PDF and opens it in a new tab. Above it, what the variant hides
 * (`…/hidden-content`), with the full list on request. Variants come from the manual's manifest
 * (`GET /manuals`), the languages from the module (its translations) or the configuration.
 */
@Component({
  selector: 'of-preview-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    SegmentedComponent,
    ZardSelectImports,
    ZardButtonComponent,
    ZardSkeletonComponent,
    FadeInDirective,
    RefreshingDirective,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    GuardDirective,
    PreviewFrameComponent,
    HiddenContentBarComponent,
    ZardSwitchComponent,
    ZardBadgeComponent,
    DatePipe,
    DesignInUseComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCircleSlash, lucideFileText })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.preview.title' | transloco">
      @if (tag(); as t) {
        <span
          ofTitleAside
          class="flex max-w-full min-w-0 flex-wrap items-center gap-1.5"
        >
          <z-badge
            zType="outline"
            class="h-auto max-w-full break-all whitespace-normal"
            >{{ 'editor.preview.atRelease' | transloco: { tag: t } }}</z-badge
          >
          @if (withdrawal()) {
            <z-badge
              ofFadeIn
              zType="secondary"
              class="gap-1"
              data-slot="withdrawn-badge"
            >
              <ng-icon name="lucideCircleSlash" aria-hidden="true" />
              {{ 'editor.releases.state.withdrawn' | transloco }}
            </z-badge>
          }
        </span>
      }
      @if (moduleId() && manualBuildable()) {
        <of-segmented
          [label]="'editor.preview.scope.label' | transloco"
          [options]="scopeOptions()"
          [value]="scope() ?? ''"
          (valueChange)="setScope($event)"
        />
      }
      @if (languages().length > 0) {
        <z-select
          class="w-auto min-w-36"
          zPosition="popper"
          [zPrefix]="'editor.preview.language' | transloco"
          [zAriaLabel]="'editor.preview.language' | transloco"
          [zValue]="lang() ?? ''"
          (zSelectionChange)="setLang($event)"
        >
          @for (l of languages(); track l) {
            <z-select-item [zValue]="l">{{ languageLabel(l) }}</z-select-item>
          }
        </z-select>
      }
      @if (variants().length > 0) {
        <z-select
          class="w-auto max-w-72 min-w-36"
          zPosition="popper"
          [zPrefix]="'editor.preview.variant' | transloco"
          [zAriaLabel]="'editor.preview.variant' | transloco"
          [zValue]="variant()?.slug ?? ''"
          (zSelectionChange)="setVariant($event)"
        >
          @for (v of variants(); track v.slug) {
            <z-select-item [zValue]="v.slug">{{ v.label }}</z-select-item>
          }
        </z-select>
      }
      @if (ownDraft()) {
        <z-switch
          class="shrink-0"
          [zChecked]="live()"
          (zCheckedChange)="setUnsaved($event)"
          >{{ 'editor.preview.unsaved' | transloco }}</z-switch
        >
      }
      @if (scope()) {
        <of-segmented
          [label]="'editor.preview.output.label' | transloco"
          [options]="outputOptions()"
          [value]="output()"
          (valueChange)="setOutput($event)"
        />
      }
      @if (back(); as b) {
        <a
          z-button
          zType="outline"
          [routerLink]="b.commands"
          [queryParams]="b.query"
          >{{ b.label | transloco }}</a
        >
      }
    </of-page-header>

    @if (withdrawal(); as w) {
      <div
        role="note"
        ofFadeIn
        class="bg-muted flex flex-col gap-1 rounded-md p-3 text-sm"
        data-slot="withdrawal"
      >
        <span class="font-medium break-words">{{
          'editor.preview.withdrawn'
            | transloco
              : { tag: tag(), name: person(w.by), date: (w.at | ofDate) }
        }}</span>
        <span class="break-words whitespace-pre-line">{{ w.reason }}</span>
      </div>
    }

    @if (!scope()) {
      @if (contextError(); as e) {
        <div class="border-border rounded-xl border p-6">
          @if (e.kind === 'unauthorized') {
            <of-no-access [heading]="'editor.preview.noAccess' | transloco" />
          } @else {
            <of-error-state
              [kind]="e.kind"
              [heading]="'editor.preview.loadFailed' | transloco"
              [message]="errorText(e)"
              (retry)="reload()"
            />
          }
        </div>
      } @else if (context() || (!moduleId() && !manualAsked())) {
        <div class="border-border rounded-xl border">
          <of-empty-state
            [title]="emptyTitle() | transloco"
            [description]="emptyDescription() | transloco"
          />
        </div>
      } @else {
        <div
          ofFadeIn="delayed"
          class="bg-muted h-11 rounded-lg"
          aria-hidden="true"
        ></div>
      }
    } @else {
      <of-hidden-content-bar
        [hidden]="hidden()"
        [loading]="hiddenLoading()"
        [failed]="hiddenError()"
        [open]="listOpen()"
        [config]="shownConfig()"
        [source]="sourceText()"
        (toggled)="toggleList()"
        (retry)="reloadHidden()"
        (pageChange)="view.set({ hiddenPage: $event })"
      />

      <div
        #stage
        class="bg-muted flex min-h-80 min-w-0 flex-col rounded-xl p-3 sm:p-6"
        [style.height]="stageHeight()"
      >
        @if (output() === 'pdf') {
          <div
            ofFadeIn
            class="bg-background mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-lg p-8 text-center shadow-sm"
          >
            <ng-icon
              name="lucideFileText"
              size="28"
              class="text-muted-foreground"
              aria-hidden="true"
            />
            <p class="m-0 font-medium break-words">
              {{ pdfTitle() }}
            </p>
            <p class="text-muted-foreground m-0 text-sm break-words">
              {{ pdfText() }}
            </p>
            @if (manual()?.meta?.design; as design) {
              <of-design-in-use
                class="text-muted-foreground justify-center text-sm"
                [design]="design"
              />
            }
            <button
              z-button
              type="button"
              [zLoading]="building()"
              [ofGuard]="{
                permission: 'content.read',
                blockedReason: pdfBlocked(),
              }"
              (click)="openPdf()"
            >
              {{ 'editor.preview.pdf.open' | transloco }}
            </button>
          </div>
        } @else if (failure(); as e) {
          <div
            ofFadeIn
            class="bg-background flex flex-1 flex-col justify-center rounded-lg p-6"
          >
            @if (e.kind === 'unauthorized') {
              <of-no-access [heading]="'editor.preview.noAccess' | transloco" />
            } @else {
              <of-error-state
                [kind]="e.kind"
                [heading]="
                  (e.kind === 'not-found'
                    ? 'editor.preview.notFound'
                    : 'editor.preview.loadFailed'
                  ) | transloco
                "
                [message]="errorText(e)"
                (retry)="reload()"
              />
            }
          </div>
        } @else if (shown(); as s) {
          <of-preview-frame
            ofFadeIn
            class="bg-background mx-auto w-full max-w-5xl flex-1 overflow-hidden rounded-lg p-2 shadow-sm sm:px-6 sm:py-4"
            [ofRefreshing]="loading()"
            [document]="s.document"
            [dark]="dark()"
            [label]="'editor.preview.frame' | transloco: { title: s.title }"
          />
        } @else {
          <div
            ofFadeIn="delayed"
            class="bg-background mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 rounded-lg p-8 shadow-sm"
            role="status"
            aria-busy="true"
          >
            <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
            <z-skeleton class="h-8 w-64" aria-hidden="true" />
            <z-skeleton class="h-4 w-full" aria-hidden="true" />
            <z-skeleton class="h-4 w-5/6" aria-hidden="true" />
            <z-skeleton class="h-4 w-4/6" aria-hidden="true" />
            <z-skeleton class="mt-4 h-24 w-full" aria-hidden="true" />
          </div>
        }
      </div>
    }
  `,
})
export class PreviewPage {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly pages = inject(PreviewPages);
  private readonly me = inject(MeService);
  private readonly readRef = inject(ReadRef);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly t = injectTranslate();
  private readonly failureText = injectFailureText();
  private readonly nameOf = injectPersonName();
  private readonly personText = injectPersonText();

  protected readonly view = injectQueryState(PREVIEW_VIEW);
  protected readonly moduleId = this.view.get('module');
  private readonly manualAsked = this.view.get('manual');
  protected readonly output = this.view.get('output');
  /** A release's tag (`?tag=`): read the content as released, whatever revision is chosen. */
  protected readonly tag = this.view.get('tag');
  /** Where reads go: the release's tag, else the chosen revision's branch (none: released). */
  private readonly ref = computed(() => this.tag() ?? this.readRef.ref());
  /**
   * Where reads go, as the keys of what is shown name it: the branch with its moves to a new head
   * (an update from main, #466), so what was read at its old head is read again. A tag never
   * moves.
   */
  private readonly refKey = computed(() => {
    const tag = this.tag();
    return tag ?? `${this.readRef.ref() ?? ''}@${this.readRef.moves()}`;
  });

  /** The withdrawal of the release whose tag is read (#330); null when it stands or none is. */
  protected readonly withdrawal = signal<Withdrawal | null>(null);
  private withdrawalRuns = 0;
  protected readonly person = (who: { kind: string; id: string }) =>
    this.personText(who, this.nameOf(who.kind, who.id));

  protected readonly context = signal<Context | null>(null);
  protected readonly contextError = signal<ApiError | null>(null);
  protected readonly shown = signal<Shown | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly hidden = signal<HiddenDoc | null>(null);
  protected readonly hiddenLoading = signal(false);
  protected readonly hiddenError = signal(false);
  protected readonly building = signal(false);
  protected readonly stageHeight = signal<string | null>(null);
  private readonly reloads = signal(0);
  private readonly hiddenReloads = signal(0);
  private readonly stage = viewChild('stage', { read: ElementRef });
  private runs = 0;
  private hiddenRuns = 0;
  private contextRuns = 0;
  /** The `blob:` URLs of the images shown; released when the next page replaces them. */
  private imageUrls: string[] = [];

  protected readonly dark = computed(() => this.theme.resolved() === 'dark');

  /** The change set read is the person's own draft: its working copies can be shown. */
  protected readonly ownDraft = computed(() => {
    const id = this.changeSets.selected()?.id;
    const option = this.changeSets.options().find((o) => o.id === id);
    return (
      !this.tag() &&
      !!this.readRef.ref() &&
      option?.state === 'draft' &&
      option.authorId === this.me.me().id
    );
  });
  /** "Include unsaved changes": the working copies, on by default for the draft's author. */
  protected readonly live = computed(
    () => this.ownDraft() && this.view.get('unsaved')() !== 'off',
  );

  /** The manuals to choose from: the module's, else every manual. */
  private readonly candidates = computed(() =>
    manualsFor(this.context()?.manuals ?? [], this.moduleId()),
  );
  protected readonly manual = computed(() =>
    chooseManual(this.candidates(), this.manualAsked(), this.moduleId()),
  );

  /** The manual can be built: it is published in a variant at least. */
  protected readonly manualBuildable = computed(
    () => (this.manual()?.meta.variants.length ?? 0) > 0,
  );

  /** What is shown: this module, or the whole manual; none until it is known what exists. */
  protected readonly scope = computed((): PreviewScope | null => {
    const context = this.context();
    if (!context) return null;
    if (this.moduleId()) {
      if (!context.module) return null;
      return this.view.get('scope')() === 'manual' && this.manualBuildable()
        ? 'manual'
        : 'module';
    }
    const manual = this.manual();
    return manual && manual.meta.variants.length > 0 ? 'manual' : null;
  });

  /** The manual's variants, each by its label in the interface language (#731). */
  protected readonly variants = computed(() => {
    const config = this.context()?.config;
    return (this.manual()?.meta.variants ?? []).map((v) => ({
      ...v,
      label: this.texts.variant(v.values, config, v.label),
    }));
  });
  protected readonly variant = computed(() =>
    chooseVariant(this.variants(), this.view.get('variant')()),
  );

  protected readonly languages = computed((): readonly string[] => {
    const context = this.context();
    const scope = this.scope();
    if (!context || !scope) return [];
    if (scope === 'module') return context.module?.languages ?? [];
    const { source, targets } = context.config.languages;
    return [source, ...targets];
  });
  protected readonly lang = computed(() =>
    chooseLanguage(
      this.languages(),
      this.view.get('lang')(),
      this.context()?.config.languages.source,
    ),
  );

  protected readonly scopeOptions = computed((): SegmentedOption[] => [
    { value: 'module', label: this.t('editor.preview.scope.module') },
    { value: 'manual', label: this.t('editor.preview.scope.manual') },
  ]);
  protected readonly outputOptions = computed((): SegmentedOption[] => [
    { value: 'html', label: this.t('editor.preview.output.html') },
    { value: 'pdf', label: this.t('editor.preview.output.pdf') },
  ]);

  protected readonly listOpen = computed(
    () =>
      this.view.get('hidden')() === 'shown' &&
      (this.hidden()?.meta.page.total ?? 0) > 0,
  );

  /** Where "Back" leads: the module editor, else the manual builder. */
  protected readonly back = computed(() => {
    const module = this.moduleId();
    const cs = this.csLink.params();
    if (module) {
      const lang = this.lang() ?? this.view.get('lang')();
      if (!lang) return null;
      return {
        commands: ['/content', lang, module],
        query: cs,
        label: 'editor.preview.backToEditor',
      };
    }
    const manual = this.manual();
    if (!manual) return null;
    return {
      commands: ['/manuals'],
      query: { ...cs, manual: manual.id },
      label: 'editor.preview.backToManual',
    };
  });

  protected readonly sourceText = computed(() =>
    this.live()
      ? 'editor.preview.hidden.unsaved'
      : this.tag()
        ? 'editor.preview.hidden.release'
        : this.readRef.ref()
          ? 'editor.preview.hidden.draft'
          : 'editor.preview.hidden.released',
  );

  protected readonly emptyTitle = computed(() => {
    if (!this.moduleId() && !this.manualAsked())
      return 'editor.preview.empty.title';
    if (this.moduleId() && !this.context()?.module)
      return 'editor.preview.notFound';
    return 'editor.preview.noVariants.title';
  });
  protected readonly emptyDescription = computed(() => {
    if (!this.moduleId() && !this.manualAsked())
      return 'editor.preview.empty.description';
    if (this.moduleId() && !this.context()?.module)
      return 'editor.preview.notFoundDescription';
    return 'editor.preview.noVariants.description';
  });

  /** The configuration with its labels in the interface language (#731). */
  protected readonly shownConfig = computed(() => {
    const config = this.context()?.config;
    return config ? this.texts.labels(config) : null;
  });

  /** The manual's title in the interface language (#731); '' without one. */
  private readonly manualTitle = computed(() =>
    this.texts.text(
      this.manual()?.attributes.title,
      this.context()?.config.languages,
    ),
  );

  protected readonly pdfTitle = computed(() =>
    this.manual()
      ? this.t('editor.preview.pdf.title', {
          title: this.manualTitle(),
        })
      : this.t('editor.preview.pdf.noManual'),
  );
  protected readonly pdfText = computed(() => {
    const variant = this.variant();
    const lang = this.lang();
    if (!this.manual() || !variant || !lang)
      return this.t('editor.preview.pdf.noManualText');
    return this.t('editor.preview.pdf.text', {
      variant: variant.label,
      language: this.languageLabel(lang),
    });
  });
  protected readonly pdfBlocked = computed((): string | null =>
    this.manual() && this.variant() && this.lang()
      ? null
      : 'editor.preview.pdf.blocked',
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // What exists: the configuration, the manuals and the module, for whoever acts, at the ref.
    effect(() => {
      const module = this.moduleId();
      const ref = this.refKey();
      const me = this.me.me().id;
      this.reloads();
      if (this.changeSets.switching() || this.changeSets.resolving()) {
        this.contextRuns++;
        return;
      }
      untracked(
        () => void this.loadContext(`${me}\n${ref}\n${module ?? ''}`, module),
      );
    });
    // Whether the release read was withdrawn, and why.
    effect(() => {
      const tag = this.tag();
      this.me.me();
      this.reloads();
      untracked(() => void this.loadWithdrawal(tag));
    });
    // The rendered page.
    effect(() => {
      const request = this.pageRequest();
      this.reloads();
      untracked(() => void this.loadPage(request));
    });
    // What is hidden.
    effect(() => {
      const request = this.hiddenRequest();
      this.hiddenReloads();
      untracked(() => void this.loadHidden(request));
    });
    // A value the address names that is not offered is dropped from it.
    effect(() => {
      const context = this.context();
      if (!context || this.contextError()) return;
      const asked = this.view.values();
      const fix: Record<string, undefined> = {};
      if (asked.manual && this.manual()?.id !== asked.manual)
        fix['manual'] = undefined;
      if (asked.variant && this.variant()?.slug !== asked.variant)
        fix['variant'] = undefined;
      if (
        asked.lang &&
        this.languages().length > 0 &&
        this.lang() !== asked.lang
      )
        fix['lang'] = undefined;
      if (Object.keys(fix).length > 0) {
        untracked(() => this.view.set(fix, { replace: true }));
      }
    });
    // The stage takes the height left under it, so the page itself never scrolls.
    const measure = () => {
      const el = this.stage()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.stageHeight.set(
        `max(20rem, calc(100dvh - ${Math.max(0, top) + BELOW_FRAME_PX}px))`,
      );
    };
    // What sits above it changes height (the list opening, the header wrapping): measured again.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(this.host.nativeElement);
    afterRenderEffect(() => {
      this.stage();
      this.listOpen();
      this.hidden();
      this.withdrawal();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      // A read still under way is dropped, and makes no object URL nobody revokes.
      this.runs++;
      this.hiddenRuns++;
      this.contextRuns++;
      this.withdrawalRuns++;
      this.releaseImages();
    });
  }

  /** The page to read, as a key and its parts; null while there is nothing to read. */
  private readonly pageRequest = computed(
    () => {
      const scope = this.scope();
      const lang = this.lang();
      if (!scope || !lang || this.output() !== 'html') return null;
      const variant = this.variant()?.slug ?? null;
      const path = previewPath(scope, {
        module: this.moduleId() ?? null,
        manual: this.manual()?.id ?? null,
        lang,
        variant,
      });
      if (!path) return null;
      const ref = this.ref();
      const me = this.me.me().id;
      const live = this.live();
      return {
        key: [
          me,
          this.refKey(),
          path,
          scope === 'module' ? (variant ?? '') : '',
          live,
        ].join('\n'),
        path,
        ref,
        live,
        variant: scope === 'module' ? variant : null,
        // A manual's page in the editor's view, so its page breaks show (a module's always does).
        editorView: scope === 'manual',
      };
    },
    { equal: (a, b) => a?.key === b?.key },
  );

  private readonly hiddenRequest = computed(
    () => {
      // The PDF is the whole manual's: what is hidden is the manual's too.
      const scope = this.output() === 'pdf' ? 'manual' : this.scope();
      const lang = this.lang();
      const module = this.moduleId();
      const manual = this.manual();
      const variant = this.variant()?.slug;
      if (!this.scope() || !scope || !lang) return null;
      if (scope === 'manual' && (!manual || !variant)) return null;
      const page = this.view.get('hiddenPage')();
      const me = this.me.me().id;
      const ref = this.ref();
      const live = this.live();
      const target =
        scope === 'module'
          ? { kind: 'module' as const, id: module ?? '' }
          : { kind: 'manual' as const, id: manual?.id ?? '' };
      return {
        key: [
          me,
          this.refKey(),
          scope,
          target.id,
          lang,
          variant ?? '',
          page,
          live,
        ].join('\n'),
        ref,
        target,
        lang,
        variant,
        page,
        live,
      };
    },
    { equal: (a, b) => a?.key === b?.key },
  );

  protected reload(): void {
    this.contextError.set(null);
    this.reloads.update((n) => n + 1);
    this.hiddenReloads.update((n) => n + 1);
  }

  protected reloadHidden(): void {
    this.hiddenReloads.update((n) => n + 1);
  }

  protected setScope(value: string): void {
    this.view.set({
      scope: value === 'manual' ? 'manual' : 'module',
      hiddenPage: 1,
    });
  }

  protected setOutput(value: string): void {
    this.view.set({ output: value === 'pdf' ? 'pdf' : 'html', hiddenPage: 1 });
  }

  protected setLang(value: string | string[]): void {
    const lang = Array.isArray(value) ? value[0] : value;
    if (lang) this.view.set({ lang, hiddenPage: 1 });
  }

  protected setVariant(value: string | string[]): void {
    const slug = Array.isArray(value) ? value[0] : value;
    if (slug) this.view.set({ variant: slug, hiddenPage: 1 });
  }

  protected setUnsaved(on: boolean): void {
    this.view.set({ unsaved: on ? undefined : 'off', hiddenPage: 1 });
  }

  protected toggleList(): void {
    this.view.set({ hidden: this.listOpen() ? undefined : 'shown' });
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected errorText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  /** Builds the manual's PDF for the variant and language and opens it in a new tab. */
  protected async openPdf(): Promise<void> {
    const manual = this.manual();
    const variant = this.variant();
    const lang = this.lang();
    if (!manual || !variant || !lang || this.building()) return;
    // Opened at once, while the click still counts as the person's; shown the PDF when it comes.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    this.building.set(true);
    try {
      const ref = this.ref();
      const e = encodeURIComponent;
      const blob = await firstValueFrom(
        this.http.get(
          `${this.base}/manuals/${e(manual.id)}/variants/${e(variant.slug)}/${e(lang)}/pdf`,
          {
            params: liveParams(ref, this.live()),
            headers: { Accept: 'application/pdf' },
            responseType: 'blob',
          },
        ),
      );
      // Shown as a PDF whatever type the answer named: never as a page of this origin.
      const url = URL.createObjectURL(
        new Blob([blob], { type: 'application/pdf' }),
      );
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      this.toast.error(
        this.failureText(
          translated('editor.preview.pdf.failed', {
            title: this.texts.text(
              manual.attributes.title,
              this.context()?.config.languages,
            ),
          }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.openPdf(),
        },
      );
    } finally {
      this.building.set(false);
    }
  }

  private async loadContext(
    key: string,
    module: string | undefined,
  ): Promise<void> {
    const run = ++this.contextRuns;
    if (this.context()?.key === key) return;
    this.contextError.set(null);
    try {
      // A release's tag is named; else (undefined) the chosen revision's branch, as every read.
      const ref = this.tag();
      const [config, manuals, summary] = await Promise.all([
        firstValueFrom(this.api.get('/config', { query: { ref } })),
        this.readManuals(ref),
        module ? this.readModule(module, ref) : Promise.resolve(null),
      ]);
      if (run !== this.contextRuns) return;
      this.context.set({
        key,
        config: config.data.attributes,
        manuals,
        module: summary,
      });
    } catch (error) {
      if (run !== this.contextRuns) return;
      this.context.set(null);
      this.contextError.set(toApiError(error));
    }
  }

  /**
   * Looks the tag up among the withdrawn releases (`GET /releases?filter[state]=withdrawn`): few,
   * so a few pages hold them. A failure shows nothing: the read at the tag still works.
   */
  private async loadWithdrawal(tag: string | undefined): Promise<void> {
    const run = ++this.withdrawalRuns;
    if (!tag) {
      this.withdrawal.set(null);
      return;
    }
    try {
      for (let page = 1; page <= WITHDRAWN_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/releases', {
            query: {
              'filter[state]': 'withdrawn',
              ...pageQuery({ number: page, size: WITHDRAWN_PAGE_SIZE }),
            },
          }),
        );
        if (run !== this.withdrawalRuns) return;
        const found = doc.data.find((r) => r.attributes.tag === tag);
        if (found?.attributes.withdrawal) {
          this.withdrawal.set(found.attributes.withdrawal);
          return;
        }
        if (!doc.links.next) break;
      }
      this.withdrawal.set(null);
    } catch {
      if (run === this.withdrawalRuns) this.withdrawal.set(null);
    }
  }

  private async readManuals(ref: string | undefined): Promise<ManualItem[]> {
    const found: ManualItem[] = [];
    for (let page = 1; page <= MANUAL_PAGES; page++) {
      const doc = await firstValueFrom(
        this.api.get('/manuals', {
          query: {
            ref,
            ...pageQuery({ number: page, size: MANUAL_PAGE_SIZE }),
          },
        }),
      );
      for (const manual of doc.data) {
        if ('attributes' in manual) found.push(manual);
      }
      if (!doc.links.next) break;
    }
    return found;
  }

  /** The module's title and languages from its summary; null when the reader has no such module. */
  private async readModule(
    moduleId: string,
    ref: string | undefined,
  ): Promise<Context['module']> {
    // `filter[q]` matches titles too: the module may be past the first page.
    for (let page = 1; page <= MANUAL_PAGES; page++) {
      const found = await firstValueFrom(
        this.api.get('/module-summaries', {
          query: {
            ref,
            'filter[q]': moduleId,
            ...pageQuery({ number: page, size: SUMMARY_PAGE_SIZE }),
          },
        }),
      );
      const summary = found.data.find((s) => s.id === moduleId);
      if (summary) {
        return {
          title: summary.attributes.title,
          languages: summary.attributes.languages,
        };
      }
      if (!found.links.next) break;
    }
    return null;
  }

  private async loadPage(
    request: PreviewPage['pageRequest'] extends () => infer R ? R : never,
  ): Promise<void> {
    const run = ++this.runs;
    if (!request) {
      this.loading.set(false);
      this.failure.set(null);
      return;
    }
    this.loading.set(true);
    this.failure.set(null);
    try {
      let params = liveParams(request.ref, request.live).set('theme', 'light');
      if (request.variant) params = params.set('variant', request.variant);
      if (request.editorView) params = params.set('view', 'editor');
      const read = await this.pages.read(
        request.path,
        params,
        () => run === this.runs,
      );
      if (!read) return;
      const title =
        this.scope() === 'module'
          ? (this.context()?.module?.title ?? this.moduleId() ?? '')
          : this.manualTitle();
      this.releaseImages();
      this.imageUrls = [...read.images.values()];
      this.shown.set({
        key: request.key,
        document: this.pages.document(read, this.dark()),
        title,
      });
    } catch (error) {
      if (run !== this.runs) return;
      this.shown.set(null);
      this.failure.set(toApiError(error));
    }
    this.loading.set(false);
  }

  private releaseImages(): void {
    for (const url of this.imageUrls) URL.revokeObjectURL(url);
    this.imageUrls = [];
  }

  private async loadHidden(
    request: PreviewPage['hiddenRequest'] extends () => infer R ? R : never,
  ): Promise<void> {
    const run = ++this.hiddenRuns;
    this.hiddenError.set(false);
    if (!request) {
      this.hidden.set(null);
      this.hiddenLoading.set(false);
      return;
    }
    this.hiddenLoading.set(true);
    const page = pageQuery({ number: request.page, size: HIDDEN_PAGE_SIZE });
    try {
      const doc =
        request.target.kind === 'module'
          ? await firstValueFrom(
              this.api.get('/modules/{lang}/{id}/hidden-content', {
                path: { lang: request.lang, id: request.target.id },
                query: {
                  ...page,
                  ref: request.ref,
                  ...(request.variant ? { variant: request.variant } : {}),
                  ...(request.live && { workingCopy: 'true' as const }),
                },
              }),
            )
          : await firstValueFrom(
              this.api.get(
                '/manuals/{id}/variants/{variant}/{lang}/hidden-content',
                {
                  path: {
                    id: request.target.id,
                    variant: request.variant ?? '',
                    lang: request.lang,
                  },
                  query: {
                    ...page,
                    ref: request.ref,
                    ...(request.live && { workingCopy: 'true' as const }),
                  },
                },
              ),
            );
      if (run !== this.hiddenRuns) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && request.page > last) {
        this.view.set({ hiddenPage: last }, { replace: true });
        return;
      }
      this.hidden.set(doc);
    } catch {
      if (run !== this.hiddenRuns) return;
      this.hidden.set(null);
      this.hiddenError.set(true);
    }
    this.hiddenLoading.set(false);
  }
}

/** `?ref=` and, for the person's own draft with its unsaved changes, `?workingCopy=true`. */
export function liveParams(ref: string | undefined, live: boolean): HttpParams {
  let params = new HttpParams();
  if (ref) params = params.set('ref', ref);
  if (ref && live) params = params.set('workingCopy', 'true');
  return params;
}
