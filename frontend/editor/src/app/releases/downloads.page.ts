import {
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
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucideFileText,
  lucidePaperclip,
  lucideSearch,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import {
  SidePanelComponent,
  SidePanelContentDirective,
} from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import {
  idParam,
  injectQueryState,
  intParam,
  oneOfParam,
  textParam,
} from '../view-state';
import { DownloadVersionsComponent } from './download-versions.component';
import {
  DOWNLOAD_ID,
  DOWNLOAD_KINDS,
  DOWNLOAD_PAGE_SIZES,
  type DownloadDoc,
  type DownloadItem,
  type DownloadKind,
  KIND_TEXT,
  LANGUAGE,
} from './downloads-model';
import { frameOffset } from './frame-offset';
import { ReleaseActions } from './release-actions';
import { ReleaseSource } from './release-source';
import { ReleaseTabsComponent } from './release-tabs.component';

/** What the list is read for: the filters and the page. */
interface DownloadQuery {
  readonly product: string | undefined;
  readonly lang: string | undefined;
  readonly kind: DownloadKind | undefined;
  readonly q: string;
  readonly page: number;
  readonly size: number;
}

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;
/** A product (a facet value's ID). */
const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,99}$/;
/** How long typing waits before the list is read for it. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The download centre (`/releases/downloads`, #139), a tab of the Releases section: every file a
 * reader can download, each product's at its latest release: the files attached in modules and
 * the manuals' PDFs, each with its name, its module or manual, kind, language, the release it is
 * from and its size. Filtered by product, language, kind and words; only what the person may read
 * is listed (the API decides). Choosing a row opens its versions beside the list
 * (`of-download-versions`); each row's button saves the current file. The filters, the page and
 * the chosen download are in the address.
 */
@Component({
  selector: 'of-downloads-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardSelectImports,
    ZardTableImports,
    ReleaseTabsComponent,
    DownloadVersionsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ReleaseSource],
  viewProviders: [
    provideIcons({
      lucideDownload,
      lucideFileText,
      lucidePaperclip,
      lucideSearch,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.releases.title' | transloco" />
    <of-release-tabs current="downloads" />

    <div class="flex flex-wrap items-center gap-2">
      <z-select
        class="w-auto max-w-72 min-w-36"
        zPosition="popper"
        data-slot="product-filter"
        [zPrefix]="'editor.releases.filter.product' | transloco"
        [zAriaLabel]="'editor.releases.filter.product' | transloco"
        [zValue]="view.get('product')() ?? ''"
        (zSelectionChange)="setProduct($event)"
      >
        <z-select-item zValue="">{{
          'editor.releases.filter.all' | transloco
        }}</z-select-item>
        @for (p of source.products(); track p.id) {
          <z-select-item [zValue]="p.id">{{ p.label }}</z-select-item>
        }
      </z-select>
      <z-select
        class="w-auto max-w-72 min-w-36"
        zPosition="popper"
        data-slot="language-filter"
        [zPrefix]="'editor.releases.downloads.filter.language' | transloco"
        [zAriaLabel]="'editor.releases.downloads.filter.language' | transloco"
        [zValue]="view.get('lang')() ?? ''"
        (zSelectionChange)="setLanguage($event)"
      >
        <z-select-item zValue="">{{
          'editor.releases.filter.all' | transloco
        }}</z-select-item>
        @for (l of languages(); track l) {
          <z-select-item [zValue]="l">{{ languageLabel(l) }}</z-select-item>
        }
      </z-select>
      <z-select
        class="w-auto min-w-36"
        zPosition="popper"
        data-slot="kind-filter"
        [zPrefix]="'editor.releases.downloads.filter.kind' | transloco"
        [zAriaLabel]="'editor.releases.downloads.filter.kind' | transloco"
        [zValue]="view.get('kind')() ?? ''"
        (zSelectionChange)="setKind($event)"
      >
        <z-select-item zValue="">{{
          'editor.releases.filter.all' | transloco
        }}</z-select-item>
        @for (k of kinds; track k) {
          <z-select-item [zValue]="k">{{
            kindText[k] | transloco
          }}</z-select-item>
        }
      </z-select>
      <z-input-group class="min-w-0 sm:w-72">
        <z-input-group-addon>
          <ng-icon name="lucideSearch" aria-hidden="true" />
        </z-input-group-addon>
        <input
          z-input
          type="search"
          autocomplete="off"
          maxlength="200"
          [attr.aria-label]="
            'editor.releases.downloads.filter.search' | transloco
          "
          [placeholder]="'editor.releases.downloads.filter.search' | transloco"
          [value]="search()"
          (input)="typed($any($event.target).value)"
        />
      </z-input-group>
    </div>

    <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
      <of-list-frame
        #frame
        class="min-h-64 min-w-0 flex-1"
        data-slot="downloads"
        [label]="'editor.releases.downloads.table.label' | transloco"
        [items]="doc()?.data ?? []"
        [page]="doc()?.meta?.page ?? null"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [pageSizes]="pageSizes"
        [emptyTitle]="
          (filtered()
            ? 'editor.releases.downloads.empty.filteredTitle'
            : 'editor.releases.downloads.empty.title'
          ) | transloco
        "
        [emptyDescription]="
          (filtered()
            ? 'editor.releases.downloads.empty.filteredDescription'
            : 'editor.releases.downloads.empty.description'
          ) | transloco
        "
        (pageChange)="view.set({ page: $event })"
        (pageSizeChange)="view.set({ size: $event, page: 1 })"
        (retry)="reload()"
      >
        <ng-template ofListTable let-items>
          <table z-table class="min-w-[44rem] table-fixed">
            <thead z-table-header class="bg-background sticky top-0 z-10">
              <tr z-table-row>
                <th z-table-head>
                  {{ 'editor.releases.downloads.table.name' | transloco }}
                </th>
                <th z-table-head class="w-32">
                  {{ 'editor.releases.downloads.table.kind' | transloco }}
                </th>
                <th z-table-head class="w-[14%]">
                  {{ 'editor.releases.downloads.table.product' | transloco }}
                </th>
                <th z-table-head class="w-[12%]">
                  {{ 'editor.releases.downloads.table.version' | transloco }}
                </th>
                <th z-table-head class="w-24">
                  {{ 'editor.releases.downloads.table.size' | transloco }}
                </th>
                <th z-table-head class="w-14">
                  <span class="sr-only">{{
                    'editor.releases.downloads.save' | transloco
                  }}</span>
                </th>
              </tr>
            </thead>
            <tbody z-table-body>
              @for (d of asDownloads(items); track d.id) {
                @let chosen = d.id === selectedId();
                @let a = d.attributes;
                <tr
                  z-table-row
                  [ofListItem]="d"
                  class="cursor-pointer"
                  data-slot="download-row"
                  [attr.data-kind]="a.kind"
                  [attr.data-state]="chosen ? 'selected' : null"
                  [attr.aria-current]="chosen ? 'true' : null"
                  (click)="select(d)"
                >
                  <td z-table-cell class="align-top whitespace-normal">
                    <button
                      type="button"
                      class="text-foreground focus-visible:ring-ring/50 rounded-sm text-start font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                      [attr.aria-current]="chosen ? 'true' : null"
                      [attr.aria-label]="
                        'editor.releases.downloads.table.open'
                          | transloco: { name: a.name }
                      "
                      (click)="$event.stopPropagation(); select(d)"
                    >
                      {{ a.name }}
                    </button>
                    <span
                      class="text-muted-foreground block text-xs [overflow-wrap:anywhere]"
                      >{{ a.fileName }} · {{ languageLabel(a.lang) }}</span
                    >
                    @if (whereFrom(d); as from) {
                      <span
                        class="text-muted-foreground block text-xs [overflow-wrap:anywhere]"
                        >{{ from }}</span
                      >
                    }
                  </td>
                  <td z-table-cell class="align-top">
                    <z-badge zType="outline" class="gap-1 font-normal">
                      <ng-icon
                        [name]="
                          a.kind === 'manual'
                            ? 'lucideFileText'
                            : 'lucidePaperclip'
                        "
                        aria-hidden="true"
                      />
                      {{ kindText[a.kind] | transloco }}
                    </z-badge>
                  </td>
                  <td z-table-cell class="align-top whitespace-normal">
                    <span class="[overflow-wrap:anywhere]">{{
                      source.productLabel(a.product)
                    }}</span>
                  </td>
                  <td z-table-cell class="align-top whitespace-normal">
                    <span class="[overflow-wrap:anywhere]">{{
                      a.release.revision
                    }}</span>
                  </td>
                  <td
                    z-table-cell
                    class="text-muted-foreground align-top text-sm whitespace-normal tabular-nums"
                  >
                    {{ size(a.size) }}
                  </td>
                  <td z-table-cell class="align-top">
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon-sm"
                      type="button"
                      data-slot="download-file"
                      [attr.aria-label]="
                        'editor.releases.downloads.saveVersion'
                          | transloco
                            : { name: a.name, version: a.release.revision }
                      "
                      (click)="$event.stopPropagation(); save(d)"
                    >
                      <ng-icon name="lucideDownload" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </ng-template>
      </of-list-frame>

      <!-- Beside the list it grows and shrinks; stacked under it (narrow) it only fades. -->
      <of-side-panel
        class="[--of-side-panel-closed-width:100%] [--of-side-panel-width:100%] lg:[--of-side-panel-closed-width:0px] lg:[--of-side-panel-gap:1rem] lg:[--of-side-panel-width:22rem] xl:[--of-side-panel-width:24rem]"
      >
        <ng-template [ofSidePanelContent]="selected()" let-d>
          <aside
            class="border-border bg-card flex flex-col overflow-hidden rounded-xl border p-4"
            data-slot="download-panel"
            [style.max-height]="'calc(100dvh - ' + offset() + ')'"
            [attr.aria-label]="
              'editor.releases.downloads.panel.label' | transloco
            "
          >
            <of-download-versions
              [download]="d"
              (closed)="view.set({ download: undefined })"
            />
          </aside>
        </ng-template>
      </of-side-panel>
    </div>
  `,
})
export class DownloadsPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly actions = inject(ReleaseActions);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  protected readonly source = inject(ReleaseSource);

  protected readonly view = injectQueryState({
    product: idParam(PRODUCT),
    lang: idParam(LANGUAGE),
    kind: oneOfParam(DOWNLOAD_KINDS),
    q: textParam(),
    page: intParam(1),
    size: intParam(DOWNLOAD_PAGE_SIZES[0], { only: DOWNLOAD_PAGE_SIZES }),
    download: idParam(DOWNLOAD_ID),
  });
  protected readonly pageSizes = DOWNLOAD_PAGE_SIZES;
  protected readonly kinds = DOWNLOAD_KINDS;
  protected readonly kindText = KIND_TEXT;

  protected readonly doc = signal<DownloadDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The search box: ahead of the address while typing waits for the debounce. */
  protected readonly search = signal(this.view.get('q')());
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;
  private readFor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly selectedId = this.view.get('download');
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.doc()?.data.find((d) => d.id === id) ?? null) : null;
  });

  /** The configured languages: the source first, then the targets. */
  protected readonly languages = computed(() => {
    const languages = this.source.config()?.languages;
    return languages ? [languages.source, ...languages.targets] : [];
  });

  protected readonly filtered = computed(
    () =>
      this.view.get('product')() !== undefined ||
      this.view.get('lang')() !== undefined ||
      this.view.get('kind')() !== undefined ||
      this.view.get('q')() !== '',
  );

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    effect(() => {
      const query: DownloadQuery = {
        product: this.view.get('product')(),
        lang: this.view.get('lang')(),
        kind: this.view.get('kind')(),
        q: this.view.get('q')(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      const who = this.me.me().id;
      this.reloads();
      untracked(() => {
        // Whoever acts now: what was read for someone else is read anew.
        if (who !== this.readFor) {
          this.readFor = who;
          this.source.forget();
          void this.source.readConfig();
        }
        void this.load(query);
      });
    });
    // The address changed (Back, a link): the box follows it, unless typing is still waiting.
    effect(() => {
      const q = this.view.get('q')();
      untracked(() => {
        if (this.timer === undefined) this.search.set(q);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.timer);
    });
  }

  protected asDownloads(items: readonly unknown[]): readonly DownloadItem[] {
    return items as readonly DownloadItem[];
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected size(bytes: number): string {
    return formatFileSize(bytes, this.language.locale());
  }

  /** Where the file is from: the module it is attached in, or the manual's variant. */
  protected whereFrom(download: DownloadItem): string | null {
    const a = download.attributes;
    if (a.kind === 'attachment') {
      return this.t('editor.releases.downloads.inModule', {
        module: download.meta.moduleTitle ?? a.moduleId ?? '',
      });
    }
    return a.variant
      ? this.t('editor.releases.downloads.variant', { variant: a.variant })
      : null;
  }

  protected select(download: DownloadItem): void {
    this.view.set({
      download: this.selectedId() === download.id ? undefined : download.id,
    });
  }

  protected save(download: DownloadItem): void {
    const a = download.attributes;
    void this.actions.saveDownload(
      download.id,
      a.release.id,
      this.t('editor.releases.downloads.versionName', {
        name: a.name,
        version: a.release.revision,
      }),
    );
  }

  protected setProduct(value: string | string[]): void {
    const product = Array.isArray(value) ? value[0] : value;
    this.view.set({ product: product || undefined, page: 1 });
  }

  protected setLanguage(value: string | string[]): void {
    const lang = Array.isArray(value) ? value[0] : value;
    this.view.set({ lang: lang || undefined, page: 1 });
  }

  protected setKind(value: string | string[]): void {
    const kind = DOWNLOAD_KINDS.find(
      (k) => k === (Array.isArray(value) ? value[0] : value),
    );
    this.view.set({ kind, page: 1 });
  }

  protected typed(value: string): void {
    this.search.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.view.set({ q: value.trim(), page: 1 });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  private async load(query: DownloadQuery): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/downloads', {
          query: {
            ...(query.product ? { 'filter[product]': query.product } : {}),
            ...(query.lang ? { 'filter[lang]': query.lang } : {}),
            ...(query.kind ? { 'filter[kind]': query.kind } : {}),
            ...(query.q ? { 'filter[q]': query.q } : {}),
            ...pageQuery({ number: query.page, size: query.size }),
          },
        }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && query.page > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
