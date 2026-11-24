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
import { lucideSearch, lucideUpload } from '@ng-icons/lucide';
import { Subscription } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import {
  ListFrameComponent,
  ListGridDirective,
  type ListFrameError,
  type ListFramePage,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError } from '../api';
import { languageName } from '../content/browser-model';
import type { ImageChoice } from '../doc-editor/blocks/doc-blocks-context';
import { apiErrorText } from '../i18n';
import { pageWithUploads } from '../media/media-model';
import { MeService } from '../permissions/me';
import {
  assetHash,
  DEFAULT_PRESET,
  presetOf,
  searchQuery,
  SIZE_PRESETS,
  tileLabel,
  typeName,
  UPLOAD_TYPES,
  widthOf,
  type AssetItem,
  type SizePreset,
  type TileLabel,
} from './image-model';
import { ImageSources } from './image-sources';
import { ImageThumbComponent } from './image-thumb.component';
import { SandboxSession } from '../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../sandbox/sandbox-note.component';

/** Tiles a page: three rows of three, and some. */
const PAGE_SIZE = 12;
/** Typing pauses this long before the search is sent. */
const SEARCH_DELAY = 250;
const ALT_MAX = 500;
const CAPTION_MAX = 300;

/** An image uploaded from this dialog: shown at once, first, while it is sent and after. */
interface Upload {
  readonly key: number;
  readonly file: File;
  /** The file's own bytes, shown at once. */
  readonly preview: string;
  /** The API's answer, once there. */
  readonly asset: string | null;
  readonly contentType: string | null;
  readonly size: number;
}

/** A tile of the grid: an upload of this dialog, or an image of the list. */
type Tile =
  | { readonly kind: 'upload'; readonly key: string; readonly upload: Upload }
  | { readonly kind: 'item'; readonly key: string; readonly item: AssetItem };

/** What is chosen: the tile's key, and the image once there is one (an upload under way has none). */
interface Chosen {
  readonly key: string;
  readonly asset: string | null;
}

/**
 * Screen 10, the image dialog: pick an image the change set's modules show (`GET /assets`, paged,
 * searched with `filter[q]`, with the change set's own uploads first: `filter[changeSet]`) or
 * upload a new one (`POST /change-sets/{id}/assets`, shown at once and taken back with a Retry
 * toast when refused). The side panel sets the size (a preset: the block's width), the alt text in
 * the module's language (required) and the optional caption. `open()` resolves to the choice, or
 * null when cancelled. A transient picker for the editor: its state is not in the address (it
 * hands its result to the insertion point, which a link could not restore). `pickOnly` makes it a
 * plain file picker (a page design's logo, #392): no size, alt text or caption, only the file.
 */
@Component({
  selector: 'of-insert-image-dialog',
  imports: [
    SandboxNoteComponent,
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardCheckboxComponent,
    SegmentedComponent,
    ListFrameComponent,
    ListGridDirective,
    ImageThumbComponent,
    NgIcon,
    TranslocoPipe,
  ],
  viewProviders: [provideIcons({ lucideSearch, lucideUpload })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="visible()"
      (zVisibleChange)="$event || cancel()"
      (zAfterClose)="closed()"
      class="gap-0 p-0 sm:max-w-[60rem] max-sm:max-h-[calc(100dvh-2rem)] max-sm:overflow-y-auto"
    >
      <z-dialog-header
        class="border-border flex-row items-center justify-between gap-3 border-b py-3 ps-5 pe-12"
      >
        <z-dialog-title class="text-lg">{{
          (pickOnly()
            ? 'editor.images.pickTitle'
            : editing()
              ? 'editor.images.editTitle'
              : 'editor.images.title'
          ) | transloco
        }}</z-dialog-title>
        @if (sandbox.on()) {
          <!-- A public sandbox takes no uploads (issue 826): picking from the list stays. -->
          <of-sandbox-note
            class="max-w-72"
            [text]="'editor.sandbox.uploadsOffPickImage' | transloco"
          />
        } @else if (changeSetId()) {
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            (click)="fileInput.click()"
          >
            <ng-icon name="lucideUpload" aria-hidden="true" />
            {{ 'editor.images.upload' | transloco }}
          </button>
          <input
            #fileInput
            type="file"
            class="hidden"
            accept="image/png,image/jpeg"
            tabindex="-1"
            aria-hidden="true"
            (change)="picked($event)"
          />
        }
      </z-dialog-header>
      @if (visible()) {
        <div class="grid min-h-0 md:grid-cols-[minmax(0,1fr)_19rem]">
          <div class="flex min-h-0 min-w-0 flex-col gap-3 p-4">
            <z-input-group class="w-full">
              <z-input-group-addon>
                <ng-icon name="lucideSearch" aria-hidden="true" />
              </z-input-group-addon>
              <input
                z-input
                type="search"
                cdkFocusInitial
                autocomplete="off"
                maxlength="200"
                [attr.aria-label]="'editor.images.search' | transloco"
                [placeholder]="'editor.images.search' | transloco"
                [value]="typed()"
                (input)="type($any($event.target).value)"
              />
            </z-input-group>
            <of-list-frame
              class="md:h-[26rem]"
              offset="18rem"
              [items]="tiles()"
              [page]="shownPage()"
              [loading]="loading()"
              [error]="error()"
              [skeletonRows]="9"
              [label]="'editor.images.list' | transloco"
              [emptyTitle]="emptyTitle()"
              [emptyDescription]="emptyDescription()"
              (pageChange)="goTo($event)"
              (retry)="load()"
            >
              <ng-template ofListGrid let-tiles>
                <div
                  class="grid grid-cols-2 gap-3 p-0.5 sm:grid-cols-3"
                  role="radiogroup"
                  [attr.aria-label]="'editor.images.list' | transloco"
                  (keydown)="moveIn($event)"
                >
                  @for (tile of asTiles(tiles); track tile.key) {
                    @let label = labelOf(tile);
                    @let chosen = tile.key === chosenKey();
                    <button
                      type="button"
                      role="radio"
                      class="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-start outline-none focus-visible:ring-[3px]"
                      [class.border-foreground]="chosen"
                      [class.ring-1]="chosen"
                      [class.ring-foreground]="chosen"
                      [attr.aria-checked]="chosen"
                      [attr.tabindex]="tile.key === focusKey() ? 0 : -1"
                      [attr.data-key]="tile.key"
                      (click)="choose(tile)"
                    >
                      <of-image-thumb
                        [asset]="assetOf(tile) ?? ''"
                        [changeSetId]="changeSetId()"
                        [src]="
                          tile.kind === 'upload' ? tile.upload.preview : ''
                        "
                      />
                      <span
                        class="min-w-0 px-0.5 text-[0.8125rem] leading-5 [overflow-wrap:anywhere]"
                      >
                        @switch (label.kind) {
                          @case ('module') {
                            {{ label.title }}
                            @if (label.more > 0) {
                              <span class="text-muted-foreground">{{
                                'editor.images.more'
                                  | transloco: { count: label.more }
                              }}</span>
                            }
                          }
                          @case ('uploaded') {
                            {{ 'editor.images.uploaded' | transloco }}
                          }
                          @case ('uploading') {
                            <span class="text-muted-foreground">{{
                              'editor.images.uploading' | transloco
                            }}</span>
                          }
                          @case ('missing') {
                            <span class="text-destructive">{{
                              'editor.images.missing' | transloco
                            }}</span>
                          }
                          @default {
                            <span class="font-mono text-xs">{{
                              label.hash
                            }}</span>
                          }
                        }
                      </span>
                    </button>
                  }
                </div>
              </ng-template>
            </of-list-frame>
          </div>

          <form
            id="insert-image-form"
            class="border-border bg-muted/40 flex min-w-0 flex-col gap-4 border-t p-5 md:border-t-0 md:border-s"
            novalidate
            (submit)="submit($event)"
          >
            <div class="flex min-h-10 flex-col gap-1">
              @if (details(); as d) {
                <p class="m-0 text-sm font-medium [overflow-wrap:anywhere]">
                  {{ d.name }}
                </p>
                <p class="text-muted-foreground m-0 text-xs">
                  {{ d.facts }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 text-sm">
                  {{ 'editor.images.chooseFirst' | transloco }}
                </p>
              }
            </div>

            @if (!pickOnly()) {
              <div class="flex flex-col gap-1.5">
                <span
                  class="text-muted-foreground text-xs"
                  id="image-size-label"
                  >{{ 'editor.images.size.label' | transloco }}</span
                >
                <of-segmented
                  class="w-full"
                  [options]="sizeOptions()"
                  [value]="preset()"
                  [label]="'editor.images.size.label' | transloco"
                  (valueChange)="preset.set($any($event))"
                />
                @if (!preset()) {
                  <p class="text-muted-foreground m-0 text-xs">
                    {{
                      (width() === null
                        ? 'editor.images.size.natural'
                        : 'editor.images.size.custom'
                      ) | transloco: { width: width() }
                    }}
                  </p>
                }
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-muted-foreground text-xs" for="image-alt">
                  {{
                    'editor.images.alt' | transloco: { language: langName() }
                  }}
                  <span aria-hidden="true">*</span>
                </label>
                <input
                  z-input
                  id="image-alt"
                  autocomplete="off"
                  required
                  [attr.maxlength]="altMax"
                  [attr.lang]="lang()"
                  [attr.aria-invalid]="altError() ? 'true' : null"
                  [attr.aria-describedby]="
                    altError() ? 'image-alt-error' : null
                  "
                  [value]="alt()"
                  (input)="typeAlt($any($event.target).value)"
                />
                @if (altError()) {
                  <p id="image-alt-error" class="text-destructive m-0 text-xs">
                    {{ 'editor.images.altRequired' | transloco }}
                  </p>
                } @else {
                  <p class="text-muted-foreground m-0 text-xs">
                    {{ 'editor.images.altHint' | transloco }}
                  </p>
                }
              </div>

              <div class="flex flex-col gap-1.5">
                <label
                  class="text-muted-foreground text-xs"
                  for="image-caption"
                  >{{ 'editor.images.caption' | transloco }}</label
                >
                <input
                  z-input
                  id="image-caption"
                  autocomplete="off"
                  [attr.maxlength]="captionMax"
                  [attr.lang]="lang()"
                  [placeholder]="'editor.images.captionPlaceholder' | transloco"
                  [value]="caption()"
                  (input)="caption.set($any($event.target).value)"
                />
              </div>

              <div class="flex flex-col gap-1">
                <z-checkbox
                  [zDisabled]="true"
                  aria-describedby="image-per-language"
                >
                  {{ 'editor.images.perLanguage' | transloco }}
                </z-checkbox>
                <p
                  id="image-per-language"
                  class="text-muted-foreground m-0 ps-6 text-xs"
                >
                  {{ 'editor.images.perLanguageReason' | transloco }}
                </p>
              </div>
            }
          </form>
        </div>
      }
      <z-dialog-footer class="m-0 items-center px-5 py-3 sm:justify-between">
        <p class="text-muted-foreground m-0 text-xs" id="image-insert-reason">
          {{ insertBlocked() | transloco }}
        </p>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.images.cancel' | transloco }}
          </button>
          <button
            z-button
            type="submit"
            form="insert-image-form"
            [zDisabled]="!!insertBlocked()"
            [attr.aria-describedby]="
              insertBlocked() ? 'image-insert-reason' : null
            "
          >
            {{
              (pickOnly()
                ? 'editor.images.choose'
                : editing()
                  ? 'editor.images.apply'
                  : 'editor.images.insert'
              ) | transloco
            }}
          </button>
        </div>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class InsertImageDialogComponent {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly sources = inject(ImageSources);
  private readonly me = inject(MeService).me;
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  /** The draft change set: uploads go there, and its own uploads are listed first. */
  readonly changeSetId = input<string | null>(null);
  /** The module's language: the alt text and caption are in it. */
  readonly lang = input('');
  /** Only the file is chosen (no size, alt text or caption): a page design's logo (#392). */
  readonly pickOnly = input(false);

  protected readonly altMax = ALT_MAX;
  protected readonly captionMax = CAPTION_MAX;

  protected readonly visible = signal(false);
  /** The block being edited (null: a new image). */
  protected readonly editing = signal<ImageChoice | null>(null);

  protected readonly typed = signal('');
  protected readonly query = signal('');
  private readonly pageNumber = signal(1);

  private readonly items = signal<readonly AssetItem[]>([]);
  protected readonly page = signal<ListFramePage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<ListFrameError | null>(null);

  private readonly uploads = signal<readonly Upload[]>([]);
  private readonly chosen = signal<Chosen | null>(null);
  /** The tile that takes the focus in the grid (one tab stop, arrows move). */
  private readonly focused = signal<string | null>(null);

  protected readonly preset = signal<SizePreset | ''>(DEFAULT_PRESET);
  /** The width kept when no preset is chosen (an image edited with a width of its own). */
  protected readonly width = signal<number | null>(null);
  protected readonly alt = signal('');
  protected readonly altError = signal(false);
  protected readonly caption = signal('');

  private resolve: ((choice: ImageChoice | null) => void) | null = null;
  /** The choice made, handed on once the dialog has closed. */
  private choice: ImageChoice | null = null;
  private loads: Subscription | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadKeys = 0;
  /** Counts the dialog's openings: an answer for an earlier one is dropped. */
  private session = 0;

  constructor() {
    // Read again when the search, the page or the change set changes, while open.
    effect(() => {
      const open = this.visible();
      this.query();
      this.pageNumber();
      this.changeSetId();
      if (open) untracked(() => this.load());
    });
    inject(DestroyRef).onDestroy(() => {
      this.loads?.unsubscribe();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.answer(null);
    });
  }

  /**
   * Opens the dialog, for a new image (null) or the block's current one, and resolves to the
   * choice, or null when cancelled. Opening again while open answers the earlier call with null.
   */
  open(current: ImageChoice | null, file?: File): Promise<ImageChoice | null> {
    this.answer(null);
    this.session += 1;
    this.editing.set(current);
    this.typed.set('');
    this.query.set('');
    this.pageNumber.set(1);
    this.items.set([]);
    this.page.set(null);
    this.error.set(null);
    this.clearUploads();
    this.chosen.set(
      current ? { key: current.asset, asset: current.asset } : null,
    );
    this.focused.set(null);
    this.preset.set(current ? presetOf(current.width) : DEFAULT_PRESET);
    this.width.set(current ? current.width : null);
    this.alt.set(current?.alt ?? '');
    this.altError.set(false);
    this.caption.set(current?.caption ?? '');
    this.visible.set(true);
    const answer = new Promise<ImageChoice | null>(
      (resolve) => (this.resolve = resolve),
    );
    // A file dropped or pasted into the document: uploading at once, chosen, as if picked here.
    if (file) this.upload(file);
    return answer;
  }

  protected readonly langName = computed(() =>
    languageName(this.language.locale(), this.lang()),
  );

  protected readonly sizeOptions = computed((): SegmentedOption[] =>
    SIZE_PRESETS.map((p) => ({ value: p.id, label: this.t(p.label) })),
  );

  /** The uploads of this dialog first, then the list without them. */
  protected readonly tiles = computed((): readonly Tile[] => {
    const uploads = this.uploads();
    const sent = new Set(uploads.map((u) => u.asset).filter(Boolean));
    const firstPage = (this.page()?.currentPage ?? 1) === 1;
    return [
      ...(firstPage
        ? uploads.map((upload): Tile => ({
            kind: 'upload',
            key: upload.asset ?? `upload-${upload.key}`,
            upload,
          }))
        : []),
      ...this.items()
        .filter((item) => !sent.has(item.attributes.reference))
        .map((item): Tile => ({
          kind: 'item',
          key: item.attributes.reference,
          item,
        })),
    ];
  });

  /** The list's paging, its total counting this dialog's uploads it shows first (#690). */
  protected readonly shownPage = computed(() =>
    pageWithUploads(
      this.page(),
      this.items().map((item) => item.attributes.reference),
      this.uploads(),
    ),
  );

  protected readonly chosenKey = computed(() => this.chosen()?.key ?? null);

  /** The tile that holds the grid's tab stop: the focused one, else the chosen, else the first. */
  protected readonly focusKey = computed(() => {
    const keys = this.tiles().map((t) => t.key);
    const focused = this.focused();
    if (focused && keys.includes(focused)) return focused;
    const chosen = this.chosenKey();
    if (chosen && keys.includes(chosen)) return chosen;
    return keys[0] ?? null;
  });

  private readonly chosenTile = computed(
    () => this.tiles().find((t) => t.key === this.chosenKey()) ?? null,
  );

  /** The side panel's head: what the chosen image is called and what it is. */
  protected readonly details = computed(() => {
    const chosen = this.chosen();
    if (!chosen) return null;
    const tile = this.chosenTile();
    if (!tile)
      return {
        name: this.t('editor.images.current'),
        facts: chosen.asset ? (assetHash(chosen.asset) ?? '').slice(0, 12) : '',
      };
    const label = this.labelOf(tile);
    const name =
      label.kind === 'module'
        ? label.title
        : label.kind === 'uploaded'
          ? this.t('editor.images.uploaded')
          : label.kind === 'uploading'
            ? this.t('editor.images.uploading')
            : label.kind === 'missing'
              ? this.t('editor.images.missing')
              : label.hash;
    const fmt = new Intl.NumberFormat(this.language.locale());
    const facts =
      tile.kind === 'upload'
        ? [
            typeName(tile.upload.contentType ?? tile.upload.file.type),
            this.bytes(tile.upload.size),
          ]
        : [
            typeName(tile.item.attributes.contentType),
            tile.item.attributes.width && tile.item.attributes.height
              ? this.t('editor.images.pixels', {
                  width: fmt.format(tile.item.attributes.width),
                  height: fmt.format(tile.item.attributes.height),
                })
              : null,
            tile.item.attributes.size === null
              ? null
              : this.bytes(tile.item.attributes.size),
            tile.item.meta.usedInCount > 0
              ? this.t('editor.images.usedIn', {
                  count: tile.item.meta.usedInCount,
                })
              : null,
          ];
    return { name, facts: facts.filter(Boolean).join(' · ') };
  });

  protected readonly emptyTitle = computed(() =>
    this.query()
      ? this.t('editor.images.noMatch', { query: this.query() })
      : this.t('editor.images.none'),
  );

  protected readonly emptyDescription = computed(() =>
    this.query()
      ? this.t('editor.images.noMatchHint')
      : this.changeSetId()
        ? this.t('editor.images.noneHint')
        : '',
  );

  /** Why Insert can't be used yet (a translation key), or '' when it can. */
  protected readonly insertBlocked = computed(() => {
    const chosen = this.chosen();
    if (!chosen) return 'editor.images.chooseFirst';
    if (!chosen.asset) return 'editor.images.waitForUpload';
    return '';
  });

  protected asTiles(value: unknown): readonly Tile[] {
    return value as readonly Tile[];
  }

  protected assetOf(tile: Tile): string | null {
    return tile.kind === 'upload'
      ? tile.upload.asset
      : tile.item.attributes.reference;
  }

  protected labelOf(
    tile: Tile,
  ): TileLabel | { kind: 'uploading' } | { kind: 'missing' } {
    if (tile.kind === 'upload')
      return tile.upload.asset ? { kind: 'uploaded' } : { kind: 'uploading' };
    if (tile.item.meta.missing && tile.item.meta.usedIn.length === 0)
      return { kind: 'missing' };
    return tileLabel(tile.item, this.lang());
  }

  protected type(value: string): void {
    this.typed.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      const next = searchQuery(value);
      if (next === this.query()) return;
      this.pageNumber.set(1);
      this.query.set(next);
    }, SEARCH_DELAY);
  }

  protected goTo(page: number): void {
    this.pageNumber.set(page);
  }

  /** Reads the page of images for the search, keeping the last one on screen meanwhile. */
  protected load(): void {
    this.loads?.unsubscribe();
    const session = this.session;
    const q = this.query();
    const changeSetId = this.changeSetId();
    this.loading.set(true);
    this.error.set(null);
    this.loads = this.api
      .get('/assets', {
        query: {
          'filter[type]': 'image',
          ...(q ? { 'filter[q]': q } : {}),
          ...(changeSetId ? { 'filter[changeSet]': changeSetId } : {}),
          ...pageQuery({ number: this.pageNumber(), size: PAGE_SIZE }),
        },
      })
      .subscribe({
        next: (document) => {
          if (session !== this.session) return;
          const page = document.meta.page;
          // A page past the end (images gone meanwhile): the last one instead.
          if (page.currentPage > page.lastPage && page.lastPage >= 1) {
            this.pageNumber.set(page.lastPage);
            return;
          }
          this.items.set(document.data);
          this.page.set(page);
          this.loading.set(false);
        },
        error: (failure: unknown) => {
          if (session !== this.session) return;
          const error = toApiError(failure);
          this.items.set([]);
          this.error.set({
            kind: error.kind,
            message: this.errorMessage(error),
          });
          this.loading.set(false);
        },
      });
  }

  protected choose(tile: Tile): void {
    this.chosen.set({ key: tile.key, asset: this.assetOf(tile) });
    this.focused.set(tile.key);
  }

  /** Arrows move the choice through the grid (a row is as wide as the grid shows), Home and End to its ends. */
  protected moveIn(event: KeyboardEvent): void {
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!keys.includes(event.key)) return;
    const grid = event.currentTarget as HTMLElement;
    const buttons = [...grid.querySelectorAll<HTMLElement>('[role="radio"]')];
    const index = buttons.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const columns = Math.max(
      1,
      getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
        .length,
    );
    const rtl = getComputedStyle(grid).direction === 'rtl';
    const step: Record<string, number> = {
      ArrowLeft: rtl ? 1 : -1,
      ArrowRight: rtl ? -1 : 1,
      ArrowUp: -columns,
      ArrowDown: columns,
    };
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.min(
              buttons.length - 1,
              Math.max(0, index + (step[event.key] ?? 0)),
            );
    const key = buttons[next]?.dataset['key'];
    const tile = this.tiles().find((t) => t.key === key);
    if (!tile) return;
    this.choose(tile);
    buttons[next]?.focus();
  }

  protected typeAlt(value: string): void {
    this.alt.set(value);
    if (value.trim()) this.altError.set(false);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.upload(file);
  }

  /**
   * Uploads an image into the change set: its tile shows at once, first and chosen, and becomes
   * the image when the API answers; a refusal takes the tile back with a toast offering Retry.
   */
  protected upload(file: File): void {
    const changeSetId = this.changeSetId();
    if (!changeSetId || !this.visible()) return;
    // A file dropped or pasted in a public sandbox (#826): the dialog says why, nothing is sent.
    if (this.sandbox.on()) {
      this.toast.error(translated('editor.sandbox.uploadsOffPickImage'));
      return;
    }
    // `accept` is only a hint: anything else is refused here, before it is shown or sent.
    if (!UPLOAD_TYPES.includes(file.type)) {
      this.toast.error(translated('editor.images.notAnImage'));
      return;
    }
    const session = this.session;
    // Who uploads: the bytes are shown from here to them only (#716).
    const uploader = this.me().id;
    const key = (this.uploadKeys += 1);
    const upload: Upload = {
      key,
      file,
      preview: this.sources.objectUrl(file) ?? '',
      asset: null,
      contentType: file.type || null,
      size: file.size,
    };
    this.uploads.update((list) => [upload, ...list]);
    if ((this.page()?.currentPage ?? 1) !== 1) this.pageNumber.set(1);
    this.chosen.set({ key: `upload-${key}`, asset: null });
    this.api
      .upload(
        '/change-sets/{changeSetId}/assets',
        { path: { changeSetId } },
        file,
      )
      .subscribe({
        next: ({ data }) => {
          if (session !== this.session) return;
          const asset = data.attributes.reference;
          this.sources.remember(
            asset,
            file,
            data.attributes.contentType,
            changeSetId,
            uploader,
          );
          // The same image twice: one tile, the first.
          const already = this.uploads().some(
            (u) => u.key !== key && u.asset === asset,
          );
          this.uploads.update((list) =>
            already
              ? list.filter((u) => u.key !== key)
              : list.map((u) =>
                  u.key === key
                    ? {
                        ...u,
                        asset,
                        contentType: data.attributes.contentType,
                        size: data.attributes.size,
                      }
                    : u,
                ),
          );
          if (already) this.sources.release(upload.preview);
          if (this.chosen()?.key === `upload-${key}`)
            this.chosen.set({ key: asset, asset });
          if (this.focused() === `upload-${key}`) this.focused.set(asset);
          // Read the list again: it lists and counts the upload itself now (#690).
          if (this.visible()) this.load();
        },
        error: (failure: unknown) => {
          if (session !== this.session) return;
          this.uploads.update((list) => list.filter((u) => u.key !== key));
          this.sources.release(upload.preview);
          if (this.chosen()?.key === `upload-${key}`) this.chosen.set(null);
          this.toast.error(apiErrorText(toApiError(failure)), {
            actionLabel: translated('editor.images.retry'),
            // Only into the dialog it was chosen in, while that is still open.
            onAction: () => {
              if (session === this.session && this.visible()) this.upload(file);
            },
          });
        },
      });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const chosen = this.chosen();
    if (!chosen?.asset) return;
    if (this.pickOnly()) {
      this.finish({ asset: chosen.asset, alt: '', caption: '', width: null });
      return;
    }
    const alt = this.alt().replace(/\s+/g, ' ').trim();
    if (!alt) {
      this.altError.set(true);
      const form = event.target as HTMLFormElement;
      form.querySelector<HTMLInputElement>('#image-alt')?.focus();
      return;
    }
    const preset = this.preset();
    this.finish({
      asset: chosen.asset,
      alt,
      caption: this.caption(),
      width: preset ? widthOf(preset) : this.width(),
    });
  }

  protected cancel(): void {
    this.finish(null);
  }

  /**
   * Closes the dialog; the open call is answered once it is gone and the focus is back where it
   * was (`closed`), so the caller can then put it elsewhere (the editor, on the new image).
   */
  private finish(choice: ImageChoice | null): void {
    this.choice = choice;
    this.visible.set(false);
    this.loads?.unsubscribe();
    this.loads = null;
  }

  protected closed(): void {
    this.answer(this.choice);
  }

  /** Answers the open call (once). */
  private answer(choice: ImageChoice | null): void {
    this.choice = null;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(choice);
  }

  /** Takes back the previews of this dialog's uploads that never became images. */
  private clearUploads(): void {
    for (const upload of this.uploads())
      if (!upload.asset) this.sources.release(upload.preview);
    this.uploads.set([]);
  }

  private errorMessage(error: Parameters<typeof apiErrorText>[0]): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  private bytes(size: number): string {
    return formatFileSize(size, this.language.locale());
  }
}
