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
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideLanguages, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { LanguageBadgeComponent } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ErrorStateComponent } from '@openfolia/ui/states';
import {
  manifestTexts,
  languageDirection,
  type Manifest,
  variantSlug,
} from '@openfolia/content-model/core';

import { ApiClient, ReadRef, toApiError, type ApiError } from '../api';
import { injectDraftBlocked } from '../content/module-actions';
import { languageName } from '../content/browser-model';
import { TranslationsSource } from './translations-source';
import { apiErrorText } from '../i18n';
import { contentOf } from '../module-editor/module-model';
import { ModuleTranslation } from '../module-editor/module-translation';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import {
  BADGE_STATE,
  blockTexts,
  configLabelTexts,
  designBlockTexts,
  manualTexts,
  openBlocks,
  parseCell,
  STATE_TEXT,
  type StatusDetail,
} from './translations-model';
import { TranslationsChanges } from './translations-view';
import type { Regions } from '../admin/page-designs/region-text';

/** What the panel read for its cell. */
interface Read {
  readonly detail: StatusDetail;
  /** The source's text per block. */
  readonly source: ReadonlyMap<string, string>;
  /** The translation's text per block; null without a file in that language. */
  readonly target: ReadonlyMap<string, string> | null;
  /** Each block's name where its key says little (a manual's cover images, #656). */
  readonly labels?: ReadonlyMap<string, string>;
}

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly read: Read }
  | { readonly kind: 'error'; readonly error: ApiError };

/**
 * The side panel of a cell of the matrix (#87): one module in one target language, its blocks
 * that need work (outdated, never translated or at the agency), each with the source text and the
 * current translation, read-only, and links to the module in the editor. A language with no
 * translation yet offers "Start translation" (#264's flow: a working copy in the chosen draft
 * revision, opened beside its source).
 */
@Component({
  selector: 'of-translation-cell-panel',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ErrorStateComponent,
    FadeInDirective,
    LanguageBadgeComponent,
    ZardButtonComponent,
    GuardDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideExternalLink, lucideLanguages, lucideX }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <h2
          class="m-0 text-base font-medium break-words"
          data-slot="panel-title"
        >
          {{ shownTitle() }}
        </h2>
        <p
          class="text-muted-foreground m-0 font-mono text-xs [overflow-wrap:anywhere]"
        >
          {{ designId() || manualId() || moduleId() || configKey() }}
        </p>
      </div>
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        type="button"
        data-slot="panel-close"
        [attr.aria-label]="'editor.translations.panel.close' | transloco"
        (click)="closed.emit()"
      >
        <ng-icon name="lucideX" aria-hidden="true" />
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="font-medium">{{ languageLabel() }}</span>
      @if (state(); as s) {
        <of-language-badge
          [state]="badgeState[s]"
          [label]="stateText[s] | transloco"
        />
      }
    </div>

    @if (designId(); as design) {
      <div class="flex flex-wrap gap-2">
        <a
          z-button
          zType="outline"
          zSize="sm"
          data-slot="open-design"
          [routerLink]="['/admin', 'page-designs', design]"
          [queryParams]="csLink.params()"
        >
          <ng-icon
            name="lucideExternalLink"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.translations.panel.openDesign' | transloco }}
        </a>
      </div>
    } @else if (isConfig()) {
      <div class="flex flex-wrap gap-2">
        <a
          z-button
          zType="outline"
          zSize="sm"
          data-slot="open-settings"
          [routerLink]="['/admin', 'settings']"
          [queryParams]="csLink.params()"
        >
          <ng-icon
            name="lucideExternalLink"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.translations.panel.openSettings' | transloco }}
        </a>
      </div>
    } @else if (manualId(); as manual) {
      <div class="flex flex-wrap gap-2">
        <a
          z-button
          zType="outline"
          zSize="sm"
          data-slot="open-manual"
          [routerLink]="['/manuals']"
          [queryParams]="{ ...csLink.params(), manual }"
        >
          <ng-icon
            name="lucideExternalLink"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.translations.panel.openManual' | transloco }}
        </a>
      </div>
    } @else {
      <div class="flex flex-wrap gap-2">
        <a
          z-button
          zType="outline"
          zSize="sm"
          data-slot="open-source"
          [routerLink]="['/content', sourceLang(), moduleId()]"
          [queryParams]="csLink.params()"
        >
          <ng-icon
            name="lucideExternalLink"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{
            'editor.translations.panel.openSource'
              | transloco: { language: sourceLabel() }
          }}
        </a>
        @if (state() === 'missing') {
          <button
            z-button
            zSize="sm"
            type="button"
            data-slot="start-translation"
            [zLoading]="starting()"
            [ofGuard]="{
              permission: 'content.edit',
              blockedReason: startBlocked(),
            }"
            (click)="start()"
          >
            <ng-icon
              name="lucideLanguages"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.translations.panel.start' | transloco }}
          </button>
        } @else if (state()) {
          <a
            z-button
            zType="outline"
            zSize="sm"
            data-slot="open-translation"
            [routerLink]="['/content', lang(), moduleId()]"
            [queryParams]="csLink.params()"
          >
            <ng-icon
              name="lucideExternalLink"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{
              'editor.translations.panel.openTranslation'
                | transloco: { language: languageLabel() }
            }}
          </a>
        }
      </div>
    }

    @switch (view().kind) {
      @case ('loading') {
        <div
          ofFadeIn="delayed"
          class="flex flex-col gap-3"
          role="status"
          aria-busy="true"
        >
          <span class="sr-only">{{
            'editor.translations.panel.loading' | transloco
          }}</span>
          @for (i of [1, 2, 3]; track i) {
            <span
              class="bg-muted block h-16 animate-pulse rounded-md motion-reduce:animate-none"
              aria-hidden="true"
            ></span>
          }
        </div>
      }
      @case ('error') {
        <of-error-state
          [kind]="errorKind()"
          [message]="errorText()"
          (retry)="reload()"
        />
      }
      @case ('ready') {
        @let r = ready()!;
        <section class="flex min-w-0 flex-col gap-2" ofFadeIn>
          <h3 class="m-0 text-sm font-medium" data-slot="panel-summary">
            {{
              'editor.translations.panel.summary'
                | transloco
                  : {
                      open: blocks().length,
                      total: r.detail.meta.totalBlocks,
                    }
            }}
          </h3>
          @if (blocks().length === 0) {
            <p class="text-muted-foreground m-0 text-sm break-words">
              {{ 'editor.translations.panel.nothingOpen' | transloco }}
            </p>
          } @else {
            <ol class="m-0 flex list-none flex-col gap-2 p-0">
              @for (b of blocks(); track b.blockId) {
                <li
                  class="border-border flex min-w-0 flex-col gap-2 rounded-lg border p-3"
                  data-slot="panel-block"
                  [attr.data-block]="b.blockId"
                >
                  <div
                    class="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span
                      class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]"
                      data-slot="block-label"
                      >{{ r.labels?.get(b.blockId) ?? b.blockId }}</span
                    >
                    <of-language-badge
                      [state]="badgeState[b.state]"
                      [label]="stateText[b.state] | transloco"
                    />
                  </div>
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-muted-foreground text-xs">{{
                      sourceLabel()
                    }}</span>
                    <p
                      class="m-0 text-sm break-words whitespace-pre-line"
                      data-slot="block-source"
                      [attr.lang]="sourceLang()"
                      [attr.dir]="sourceDir()"
                    >
                      {{ r.source.get(b.blockId) ?? '' }}
                    </p>
                  </div>
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-muted-foreground text-xs">{{
                      languageLabel()
                    }}</span>
                    @if (r.target?.get(b.blockId); as text) {
                      <p
                        class="text-muted-foreground m-0 text-sm break-words whitespace-pre-line"
                        data-slot="block-target"
                        [attr.lang]="lang()"
                        [attr.dir]="targetDir()"
                      >
                        {{ text }}
                      </p>
                    } @else {
                      <p
                        class="text-muted-foreground m-0 text-sm italic"
                        data-slot="block-target"
                      >
                        {{
                          'editor.translations.panel.noTranslation' | transloco
                        }}
                      </p>
                    }
                  </div>
                </li>
              }
            </ol>
          }
        </section>
      }
    }
  `,
})
export class TranslationCellPanelComponent {
  /** The cell: `<lang>/<moduleId>`. */
  readonly cell = input.required<string>();
  /** The source module's title, while the panel has not read it. */
  readonly title = input('');
  readonly sourceLang = input.required<string>();
  readonly closed = output<void>();

  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly translation = inject(ModuleTranslation);
  private readonly me = inject(MeService);
  private readonly readRef = inject(ReadRef);
  private readonly changes = inject(TranslationsChanges);
  private readonly draftBlocked = injectDraftBlocked();
  private readonly t = injectTranslate();
  protected readonly csLink = inject(ChangeSetUrl);

  protected readonly badgeState = BADGE_STATE;
  protected readonly stateText = STATE_TEXT;

  protected readonly view = signal<PanelState>({ kind: 'loading' });
  protected readonly starting = signal(false);
  private readonly reloads = signal(0);
  private runs = 0;

  private readonly parsed = computed(() => parseCell(this.cell()));
  protected readonly lang = computed(() => this.parsed()?.lang ?? '');
  protected readonly moduleId = computed(() => {
    const cell = this.parsed();
    return cell?.kind === 'module' ? cell.moduleId : '';
  });
  /** A page design's region text (#568): the design; '' for a module. */
  protected readonly designId = computed(() => {
    const cell = this.parsed();
    return cell?.kind === 'design' ? cell.designId : '';
  });
  /** A manual's own text (#656: its cover images' alternative text): the manual; '' otherwise. */
  protected readonly manualId = computed(() => {
    const cell = this.parsed();
    return cell?.kind === 'manual' ? cell.manualId : '';
  });

  /** The project labels (#731): one cell per target language. */
  protected readonly isConfig = computed(
    () => this.parsed()?.kind === 'config',
  );
  /** The project labels' key, as an export names their file. */
  protected readonly configKey = computed(() =>
    this.isConfig() ? 'config.project' : '',
  );

  protected readonly ready = computed(() => {
    const v = this.view();
    return v.kind === 'ready' ? v.read : null;
  });
  protected readonly state = computed(
    () => this.ready()?.detail.attributes.state ?? null,
  );
  protected readonly blocks = computed(() => {
    const r = this.ready();
    return r ? openBlocks(r.detail) : [];
  });
  protected readonly shownTitle = computed(
    () =>
      (this.isConfig()
        ? this.t('editor.translations.matrix.configTitle')
        : this.ready()?.detail.meta.title) ||
      this.title() ||
      this.designId() ||
      this.manualId() ||
      this.moduleId(),
  );
  /** The configuration, where the page has it (the matrix's), for each side's direction. */
  private readonly source = inject(TranslationsSource, { optional: true });
  /** Each side's text direction (#458): the source's and the translation's, in their own. */
  protected readonly sourceDir = computed(() =>
    languageDirection(this.sourceLang(), this.source?.config()),
  );
  protected readonly targetDir = computed(() =>
    languageDirection(this.lang(), this.source?.config()),
  );
  protected readonly languageLabel = computed(() =>
    languageName(this.language.locale(), this.lang()),
  );
  protected readonly sourceLabel = computed(() =>
    languageName(this.language.locale(), this.sourceLang()),
  );
  protected readonly startBlocked = computed(
    () =>
      this.draftBlocked() ??
      (this.starting() ? 'editor.moduleActions.translating' : null),
  );

  protected readonly errorKind = computed(() => {
    const v = this.view();
    return v.kind === 'error' ? v.error.kind : 'unknown';
  });
  protected readonly errorText = computed(() => {
    const v = this.view();
    if (v.kind !== 'error') return '';
    const text = apiErrorText(v.error);
    return this.t(text.key, text.params);
  });

  constructor() {
    effect(() => {
      const cell = this.parsed();
      const source = this.sourceLang();
      this.reloads();
      // Another revision (or its new head, #466), or an export or a cancel: the blocks may have
      // changed.
      this.readRef.ref();
      this.readRef.moves();
      this.changes.changed();
      untracked(() => {
        if (cell?.kind === 'design')
          void this.loadDesign(cell.lang, cell.designId, source);
        else if (cell?.kind === 'manual')
          void this.loadManual(cell.lang, cell.manualId, source);
        else if (cell?.kind === 'config') void this.loadConfig(cell.lang);
        else if (cell) void this.load(cell.lang, cell.moduleId, source);
      });
    });
    inject(DestroyRef).onDestroy(() => this.runs++);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  /** Starts the language version in the chosen draft revision and opens it beside its source. */
  protected async start(): Promise<void> {
    const chosen = this.changeSets.selected();
    if (!chosen || this.startBlocked() || this.starting()) return;
    const moduleId = this.moduleId();
    const lang = this.lang();
    const person = this.me.me().id;
    this.starting.set(true);
    try {
      const started = await this.translation.start(
        {
          moduleId,
          from: this.sourceLang(),
          to: lang,
          title: this.shownTitle(),
        },
        chosen.id,
        person,
      );
      if (started && this.moduleId() === moduleId && this.lang() === lang) {
        await this.router.navigate(['/content', lang, moduleId], {
          queryParams: { ...this.csLink.params(), preview: 'source' },
        });
      }
    } finally {
      this.starting.set(false);
    }
  }

  /** A page design's region text (#568): its status, and the design's text in both languages. */
  private async loadDesign(
    lang: string,
    designId: string,
    source: string,
  ): Promise<void> {
    const run = ++this.runs;
    if (
      this.view().kind !== 'ready' ||
      this.ready()?.detail.id !== this.cell()
    ) {
      this.view.set({ kind: 'loading' });
    }
    try {
      const [detail, design] = await Promise.all([
        firstValueFrom(
          this.api.get('/translations/status/{lang}/designs/{designId}', {
            path: { lang, designId },
          }),
        ),
        firstValueFrom(
          this.api.get('/page-designs/{designId}', { path: { designId } }),
        ),
      ]);
      if (run !== this.runs) return;
      const attributes = design.data.attributes as unknown as {
        readonly regions: Regions;
      };
      this.view.set({
        kind: 'ready',
        read: {
          detail: detail.data,
          source: designBlockTexts(attributes.regions, source, source, false),
          target:
            detail.data.attributes.state === 'missing'
              ? null
              : designBlockTexts(attributes.regions, lang, source, true),
        },
      });
    } catch (error) {
      if (run !== this.runs) return;
      this.view.set({ kind: 'error', error: toApiError(error) });
    }
  }

  /** A manual's cover image text (#656): its status, and the manifest's text in both languages. */
  private async loadManual(
    lang: string,
    manualId: string,
    source: string,
  ): Promise<void> {
    const run = ++this.runs;
    if (
      this.view().kind !== 'ready' ||
      this.ready()?.detail.id !== this.cell()
    ) {
      this.view.set({ kind: 'loading' });
    }
    try {
      const [detail, manual] = await Promise.all([
        firstValueFrom(
          this.api.get('/translations/status/{lang}/manuals/{manualId}', {
            path: { lang, manualId },
          }),
        ),
        firstValueFrom(
          this.api.get('/manuals/{id}', { path: { id: manualId } }),
        ),
      ]);
      if (run !== this.runs) return;
      const manifest = manual.data.attributes as unknown as Pick<
        Manifest,
        'title' | 'entries' | 'coverImage'
      >;
      this.view.set({
        kind: 'ready',
        read: {
          detail: detail.data,
          source: manualTexts(manifest, source, source, false),
          target:
            detail.data.attributes.state === 'missing'
              ? null
              : manualTexts(manifest, lang, source, true),
          labels: new Map(
            manifestTexts(manifest, source).map(({ key, kind, variant }) => [
              key,
              kind === 'title'
                ? this.t('editor.translations.panel.manualTitle')
                : kind === 'group'
                  ? this.t('editor.translations.panel.groupTitle')
                  : variant
                    ? this.t('editor.translations.panel.coverVariant', {
                        variant: variantSlug(variant),
                      })
                    : this.t('editor.translations.panel.coverDefault'),
            ]),
          ),
        },
      });
    } catch (error) {
      if (run !== this.runs) return;
      this.view.set({ kind: 'error', error: toApiError(error) });
    }
  }

  /** The project labels (#731): their status, and each label in both languages. */
  private async loadConfig(lang: string): Promise<void> {
    const run = ++this.runs;
    if (
      this.view().kind !== 'ready' ||
      this.ready()?.detail.id !== this.cell()
    ) {
      this.view.set({ kind: 'loading' });
    }
    try {
      const [detail, config] = await Promise.all([
        firstValueFrom(
          this.api.get('/translations/status/{lang}/config/project', {
            path: { lang },
          }),
        ),
        firstValueFrom(this.api.get('/config')),
      ]);
      if (run !== this.runs) return;
      const stored = config.data.attributes;
      const source = stored.languages.source;
      this.view.set({
        kind: 'ready',
        read: {
          detail: detail.data,
          source: configLabelTexts(stored, source, source, false),
          target:
            detail.data.attributes.state === 'missing'
              ? null
              : configLabelTexts(stored, lang, source, true),
        },
      });
    } catch (error) {
      if (run !== this.runs) return;
      this.view.set({ kind: 'error', error: toApiError(error) });
    }
  }

  private async load(
    lang: string,
    moduleId: string,
    source: string,
  ): Promise<void> {
    const run = ++this.runs;
    // The same cell read again (a retry, an export) keeps what it shows until the answer.
    if (
      this.view().kind !== 'ready' ||
      this.ready()?.detail.id !== this.cell()
    ) {
      this.view.set({ kind: 'loading' });
    }
    const module = (l: string) =>
      firstValueFrom(
        this.api.get('/modules/{lang}/{id}', {
          path: { lang: l, id: moduleId },
        }),
      );
    try {
      const [detail, sourceDoc] = await Promise.all([
        firstValueFrom(
          this.api.get('/translations/status/{lang}/{moduleId}', {
            path: { lang, moduleId },
          }),
        ),
        module(source),
      ]);
      const target =
        detail.data.attributes.state === 'missing'
          ? null
          : await module(lang).catch((error: unknown) => {
              // No file in that language (deleted meanwhile): nothing translated to show.
              if (toApiError(error).status === 404) return null;
              throw error;
            });
      if (run !== this.runs) return;
      this.view.set({
        kind: 'ready',
        read: {
          detail: detail.data,
          source: blockTexts(contentOf(sourceDoc.data.attributes)),
          target: target ? blockTexts(contentOf(target.data.attributes)) : null,
        },
      });
    } catch (error) {
      if (run !== this.runs) return;
      this.view.set({ kind: 'error', error: toApiError(error) });
    }
  }
}
