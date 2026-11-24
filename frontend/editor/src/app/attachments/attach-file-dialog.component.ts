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
import { formatFileSize } from '@openfolia/content-model/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFile,
  lucideFileArchive,
  lucideFileAudio,
  lucideFileBraces,
  lucideFileCode,
  lucideFileImage,
  lucideFileSpreadsheet,
  lucideFileText,
  lucideFileVideo,
  lucideLoaderCircle,
  lucideSearch,
  lucideUpload,
} from '@ng-icons/lucide';
import { Subscription } from 'rxjs';

import { attachmentIcon, type AttachmentIcon } from '@openfolia/ui/blocks';
import { ZardButtonComponent } from '@openfolia/ui/button';
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
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError } from '../api';
import { languageName } from '../content/browser-model';
import type { AttachmentChoice } from '../doc-editor/blocks/doc-blocks-context';
import { apiErrorText } from '../i18n';
import { searchQuery } from '../images/image-model';
import { pageWithUploads } from '../media/media-model';
import {
  defaultName,
  fileTypeName,
  rowName,
  type AttachmentItem,
} from './attachment-model';
import { SandboxSession } from '../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../sandbox/sandbox-note.component';

/** Rows a page. */
const PAGE_SIZE = 10;
/** Typing pauses this long before the search is sent. */
const SEARCH_DELAY = 250;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 1000;

const ICONS: Record<AttachmentIcon, string> = {
  archive: 'lucideFileArchive',
  data: 'lucideFileBraces',
  code: 'lucideFileCode',
  text: 'lucideFileText',
  sheet: 'lucideFileSpreadsheet',
  image: 'lucideFileImage',
  audio: 'lucideFileAudio',
  video: 'lucideFileVideo',
  file: 'lucideFile',
};

/** A file uploaded from this dialog: listed at once, first, while it is sent and after. */
interface Upload {
  readonly key: number;
  readonly file: File;
  /** The API's answer, once there. */
  readonly asset: string | null;
  /** The name it is kept under (the API's), else the file's own. */
  readonly fileName: string;
  readonly contentType: string | null;
  readonly size: number;
}

/** A row of the list: an upload of this dialog, or a file of the list. */
type Row =
  | { readonly kind: 'upload'; readonly key: string; readonly upload: Upload }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly item: AttachmentItem;
    };

/** What a row shows: the file, what it is and where it is used. */
interface RowFacts {
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number | null;
  readonly asset: string | null;
}

/**
 * The attach-file dialog, the module editor's `pickAttachment`: pick a file the change set's
 * modules attach (`GET /assets?filter[type]=attachment`, paged, searched with `filter[q]`, the
 * change set's own uploads first: `filter[changeSet]`) or upload a new one of any type
 * (`POST /change-sets/{id}/assets?kind=attachment`: the server decides its type and refuses what
 * the settings do not take, with a toast offering Retry). The side panel sets the name readers see
 * (required) and an optional description, both in the module's language. `open()` resolves to the
 * choice, or null when cancelled. Files are never opened or shown here: a row only names them.
 */
@Component({
  selector: 'of-attach-file-dialog',
  imports: [
    SandboxNoteComponent,
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ListFrameComponent,
    ListGridDirective,
    NgIcon,
    TranslocoPipe,
  ],
  viewProviders: [
    provideIcons({
      lucideFile,
      lucideFileArchive,
      lucideFileAudio,
      lucideFileBraces,
      lucideFileCode,
      lucideFileImage,
      lucideFileSpreadsheet,
      lucideFileText,
      lucideFileVideo,
      lucideLoaderCircle,
      lucideSearch,
      lucideUpload,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="visible()"
      (zVisibleChange)="$event || cancel()"
      (zAfterClose)="closed()"
      class="gap-0 p-0 sm:max-w-[56rem] max-sm:max-h-[calc(100dvh-2rem)] max-sm:overflow-y-auto"
    >
      <z-dialog-header
        class="border-border flex-row items-center justify-between gap-3 border-b py-3 ps-5 pe-12"
      >
        <z-dialog-title class="text-lg">{{
          (editing()
            ? 'editor.attachments.editTitle'
            : 'editor.attachments.title'
          ) | transloco
        }}</z-dialog-title>
        @if (sandbox.on()) {
          <!-- A public sandbox takes no uploads (issue 826): picking from the list stays. -->
          <of-sandbox-note
            class="max-w-72"
            [text]="'editor.sandbox.uploadsOffPickFile' | transloco"
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
            {{ 'editor.attachments.upload' | transloco }}
          </button>
          <input
            #fileInput
            type="file"
            class="hidden"
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
                [attr.aria-label]="'editor.attachments.search' | transloco"
                [placeholder]="'editor.attachments.search' | transloco"
                [value]="typed()"
                (input)="type($any($event.target).value)"
              />
            </z-input-group>
            <of-list-frame
              class="md:h-[26rem]"
              offset="18rem"
              [items]="rows()"
              [page]="shownPage()"
              [loading]="loading()"
              [error]="error()"
              [skeletonRows]="6"
              [label]="'editor.attachments.list' | transloco"
              [emptyTitle]="emptyTitle()"
              [emptyDescription]="emptyDescription()"
              (pageChange)="goTo($event)"
              (retry)="load()"
            >
              <ng-template ofListGrid let-rows>
                <div
                  class="grid grid-cols-1 gap-1.5 p-0.5"
                  role="radiogroup"
                  [attr.aria-label]="'editor.attachments.list' | transloco"
                  (keydown)="moveIn($event)"
                >
                  @for (row of asRows(rows); track row.key) {
                    @let facts = factsOf(row);
                    @let chosen = row.key === chosenKey();
                    <button
                      type="button"
                      role="radio"
                      class="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 items-center gap-3 rounded-lg border p-2 text-start outline-none focus-visible:ring-[3px]"
                      [class.border-foreground]="chosen"
                      [class.ring-1]="chosen"
                      [class.ring-foreground]="chosen"
                      [attr.aria-checked]="chosen"
                      [attr.tabindex]="row.key === focusKey() ? 0 : -1"
                      [attr.data-key]="row.key"
                      (click)="choose(row)"
                    >
                      <span
                        class="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md"
                        aria-hidden="true"
                      >
                        @if (facts.asset) {
                          <ng-icon [name]="iconOf(facts.mediaType)" size="18" />
                        } @else {
                          <ng-icon
                            class="animate-spin motion-reduce:animate-none"
                            name="lucideLoaderCircle"
                            size="18"
                          />
                        }
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span
                          class="text-[0.8125rem] leading-5 font-medium [overflow-wrap:anywhere]"
                          >{{ facts.fileName }}</span
                        >
                        <span class="text-muted-foreground text-xs">{{
                          rowLine(row)
                        }}</span>
                      </span>
                    </button>
                  }
                </div>
              </ng-template>
            </of-list-frame>
          </div>

          <form
            id="attach-file-form"
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
                  {{ 'editor.attachments.chooseFirst' | transloco }}
                </p>
              }
            </div>

            <div class="flex flex-col gap-1.5">
              <label
                class="text-muted-foreground text-xs"
                for="attachment-name"
              >
                {{
                  'editor.attachments.name'
                    | transloco: { language: langName() }
                }}
                <span aria-hidden="true">*</span>
              </label>
              <input
                z-input
                id="attachment-name"
                autocomplete="off"
                required
                [attr.maxlength]="nameMax"
                [attr.lang]="lang()"
                [attr.aria-invalid]="nameError() ? 'true' : null"
                [attr.aria-describedby]="
                  nameError() ? 'attachment-name-error' : null
                "
                [value]="name()"
                (input)="typeName($any($event.target).value)"
              />
              @if (nameError()) {
                <p
                  id="attachment-name-error"
                  class="text-destructive m-0 text-xs"
                >
                  {{ 'editor.attachments.nameRequired' | transloco }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 text-xs">
                  {{ 'editor.attachments.nameHint' | transloco }}
                </p>
              }
            </div>

            <div class="flex flex-col gap-1.5">
              <label
                class="text-muted-foreground text-xs"
                for="attachment-description"
                >{{ 'editor.attachments.description' | transloco }}</label
              >
              <input
                z-input
                id="attachment-description"
                autocomplete="off"
                [attr.maxlength]="descriptionMax"
                [attr.lang]="lang()"
                [placeholder]="
                  'editor.attachments.descriptionPlaceholder' | transloco
                "
                [value]="description()"
                (input)="description.set($any($event.target).value)"
              />
            </div>
          </form>
        </div>
      }
      <z-dialog-footer class="m-0 items-center px-5 py-3 sm:justify-between">
        <p
          class="text-muted-foreground m-0 text-xs"
          id="attachment-insert-reason"
        >
          {{ insertBlocked() | transloco }}
        </p>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.attachments.cancel' | transloco }}
          </button>
          <button
            z-button
            type="submit"
            form="attach-file-form"
            [zDisabled]="!!insertBlocked()"
            [attr.aria-describedby]="
              insertBlocked() ? 'attachment-insert-reason' : null
            "
          >
            {{
              (editing()
                ? 'editor.attachments.apply'
                : 'editor.attachments.insert'
              ) | transloco
            }}
          </button>
        </div>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class AttachFileDialogComponent {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  /** The draft change set: uploads go there, and its own uploads are listed first. */
  readonly changeSetId = input<string | null>(null);
  /** The module's language: the name and description are in it. */
  readonly lang = input('');

  protected readonly nameMax = NAME_MAX;
  protected readonly descriptionMax = DESCRIPTION_MAX;

  protected readonly visible = signal(false);
  /** The block being edited (null: a new attachment). */
  protected readonly editing = signal<AttachmentChoice | null>(null);

  protected readonly typed = signal('');
  protected readonly query = signal('');
  private readonly pageNumber = signal(1);

  private readonly items = signal<readonly AttachmentItem[]>([]);
  protected readonly page = signal<ListFramePage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<ListFrameError | null>(null);

  private readonly uploads = signal<readonly Upload[]>([]);
  /** The chosen row's key and its file, once there is one (an upload under way has none). */
  private readonly chosen = signal<{
    key: string;
    file: RowFacts | null;
  } | null>(null);
  private readonly focused = signal<string | null>(null);

  protected readonly name = signal('');
  protected readonly nameError = signal(false);
  /** The name was typed: choosing another file no longer replaces it. */
  private nameTyped = false;
  protected readonly description = signal('');

  private resolve: ((choice: AttachmentChoice | null) => void) | null = null;
  private choice: AttachmentChoice | null = null;
  private loads: Subscription | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadKeys = 0;
  /** Counts the dialog's openings: an answer for an earlier one is dropped. */
  private session = 0;

  constructor() {
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
   * Opens the dialog, for a new attachment (null) or the block's current one, and resolves to the
   * choice, or null when cancelled. Opening again while open answers the earlier call with null.
   */
  open(current: AttachmentChoice | null): Promise<AttachmentChoice | null> {
    this.answer(null);
    this.session += 1;
    this.editing.set(current);
    this.typed.set('');
    this.query.set('');
    this.pageNumber.set(1);
    this.items.set([]);
    this.page.set(null);
    this.error.set(null);
    this.uploads.set([]);
    this.chosen.set(
      current
        ? {
            key: current.asset,
            file: {
              asset: current.asset,
              fileName: current.fileName,
              mediaType: current.mediaType,
              size: current.size,
            },
          }
        : null,
    );
    this.focused.set(null);
    this.name.set(current?.name ?? '');
    this.nameTyped = !!current;
    this.nameError.set(false);
    this.description.set(current?.description ?? '');
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    // Opened again while open: the effect sees nothing new, so the list is read here.
    const reload = this.visible();
    this.visible.set(true);
    if (reload) this.load();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  protected readonly langName = computed(() =>
    languageName(this.language.locale(), this.lang()),
  );

  /** This dialog's uploads first, then the list without them. */
  protected readonly rows = computed((): readonly Row[] => {
    const uploads = this.uploads();
    const sent = new Set(uploads.map((u) => u.asset).filter(Boolean));
    const firstPage = (this.page()?.currentPage ?? 1) === 1;
    return [
      ...(firstPage
        ? uploads.map((upload): Row => ({
            kind: 'upload',
            key: upload.asset ?? `upload-${upload.key}`,
            upload,
          }))
        : []),
      ...this.items()
        .filter((item) => !sent.has(item.attributes.reference))
        .map((item): Row => ({
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

  protected readonly focusKey = computed(() => {
    const keys = this.rows().map((r) => r.key);
    const focused = this.focused();
    if (focused && keys.includes(focused)) return focused;
    const chosen = this.chosenKey();
    if (chosen && keys.includes(chosen)) return chosen;
    return keys[0] ?? null;
  });

  /** The side panel's head: the chosen file's name and what it is. */
  protected readonly details = computed(() => {
    const chosen = this.chosen();
    if (!chosen) return null;
    if (!chosen.file)
      return { name: this.t('editor.attachments.uploading'), facts: '' };
    return {
      name: chosen.file.fileName,
      facts: this.factsLine(chosen.file),
    };
  });

  protected readonly emptyTitle = computed(() =>
    this.query()
      ? this.t('editor.attachments.noMatch', { query: this.query() })
      : this.t('editor.attachments.none'),
  );

  protected readonly emptyDescription = computed(() =>
    this.query()
      ? this.t('editor.attachments.noMatchHint')
      : this.changeSetId()
        ? this.t('editor.attachments.noneHint')
        : '',
  );

  /** Why Insert can't be used yet (a translation key), or '' when it can. */
  protected readonly insertBlocked = computed(() => {
    const chosen = this.chosen();
    if (!chosen) return 'editor.attachments.chooseFirst';
    if (!chosen.file?.asset) return 'editor.attachments.waitForUpload';
    return '';
  });

  protected asRows(value: unknown): readonly Row[] {
    return value as readonly Row[];
  }

  protected iconOf(mediaType: string): string {
    return ICONS[attachmentIcon(mediaType)];
  }

  protected factsOf(row: Row): RowFacts {
    if (row.kind === 'upload')
      return {
        asset: row.upload.asset,
        fileName: row.upload.fileName,
        mediaType: row.upload.contentType ?? '',
        size: row.upload.size,
      };
    const { attributes } = row.item;
    return {
      asset: attributes.reference,
      fileName: rowName(row.item),
      mediaType: attributes.contentType ?? '',
      size: attributes.size,
    };
  }

  /** A row's second line: type and size, and where it is used (or that it is a fresh upload). */
  protected rowLine(row: Row): string {
    const facts = this.factsOf(row);
    const where =
      row.kind === 'upload'
        ? this.t(
            row.upload.asset
              ? 'editor.attachments.uploaded'
              : 'editor.attachments.uploading',
          )
        : row.item.meta.usedInCount > 0
          ? this.t('editor.attachments.usedIn', {
              count: row.item.meta.usedInCount,
            })
          : row.item.meta.missing
            ? this.t('editor.attachments.missing')
            : row.item.meta.uploaded
              ? this.t('editor.attachments.uploaded')
              : '';
    return [this.factsLine(facts, false), where].filter(Boolean).join(' · ');
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

  /** Reads the page of files for the search, keeping the last one on screen meanwhile. */
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
          'filter[type]': 'attachment',
          ...(q ? { 'filter[q]': q } : {}),
          ...(changeSetId ? { 'filter[changeSet]': changeSetId } : {}),
          ...pageQuery({ number: this.pageNumber(), size: PAGE_SIZE }),
        },
      })
      .subscribe({
        next: (document) => {
          if (session !== this.session) return;
          const page = document.meta.page;
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
          const text = apiErrorText(error);
          this.items.set([]);
          this.error.set({
            kind: error.kind,
            message: this.t(text.key, text.params),
          });
          this.loading.set(false);
        },
      });
  }

  protected choose(row: Row): void {
    const facts = this.factsOf(row);
    this.chosen.set({ key: row.key, file: facts.asset ? facts : null });
    this.focused.set(row.key);
    this.suggestName(facts.fileName);
  }

  /** Arrows move the choice through the list, Home and End to its ends. */
  protected moveIn(event: KeyboardEvent): void {
    const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 };
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const list = event.currentTarget as HTMLElement;
    const buttons = [...list.querySelectorAll<HTMLElement>('[role="radio"]')];
    const index = buttons.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
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
    const row = this.rows().find((r) => r.key === key);
    if (!row) return;
    this.choose(row);
    buttons[next]?.focus();
  }

  protected typeName(value: string): void {
    this.name.set(value);
    this.nameTyped = value.trim() !== '';
    if (value.trim()) this.nameError.set(false);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.upload(file);
  }

  /**
   * Uploads a file into the change set: its row shows at once, first and chosen, and becomes the
   * file when the API answers (with the type the server decided and the name it kept); a refusal
   * takes the row back with a toast that says why and offers Retry.
   */
  protected upload(file: File): void {
    const changeSetId = this.changeSetId();
    if (!changeSetId || !this.visible() || this.sandbox.on()) return;
    const session = this.session;
    const key = (this.uploadKeys += 1);
    const upload: Upload = {
      key,
      file,
      asset: null,
      fileName: file.name,
      contentType: null,
      size: file.size,
    };
    this.uploads.update((list) => [upload, ...list]);
    if ((this.page()?.currentPage ?? 1) !== 1) this.pageNumber.set(1);
    this.chosen.set({ key: `upload-${key}`, file: null });
    this.focused.set(`upload-${key}`);
    this.suggestName(file.name);
    this.api
      .upload(
        '/change-sets/{changeSetId}/assets',
        { path: { changeSetId }, kind: 'attachment' },
        file,
      )
      .subscribe({
        next: ({ data }) => {
          if (session !== this.session) return;
          const { reference, contentType, size, fileName } = data.attributes;
          const kept: Upload = {
            ...upload,
            asset: reference,
            fileName: fileName ?? file.name,
            contentType,
            size,
          };
          // The same file twice: one row, the first.
          const already = this.uploads().some(
            (u) => u.key !== key && u.asset === reference,
          );
          this.uploads.update((list) =>
            already
              ? list.filter((u) => u.key !== key)
              : list.map((u) => (u.key === key ? kept : u)),
          );
          if (this.chosen()?.key === `upload-${key}`)
            this.chosen.set({
              key: reference,
              file: {
                asset: reference,
                fileName: kept.fileName,
                mediaType: contentType,
                size,
              },
            });
          if (this.focused() === `upload-${key}`) this.focused.set(reference);
          // Read the list again: it lists and counts the upload itself now (#690).
          if (this.visible()) this.load();
        },
        error: (failure: unknown) => {
          if (session !== this.session) return;
          this.uploads.update((list) => list.filter((u) => u.key !== key));
          if (this.chosen()?.key === `upload-${key}`) this.chosen.set(null);
          const text = apiErrorText(toApiError(failure));
          // Retry only into the dialog it was chosen in, while that is still open.
          if (!this.visible()) {
            this.toast.error(text);
            return;
          }
          this.toast.error(text, {
            actionLabel: translated('editor.attachments.retry'),
            onAction: () => {
              if (session === this.session && this.visible()) this.upload(file);
            },
          });
        },
      });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const file = this.chosen()?.file;
    if (!file?.asset) return;
    const name = this.name().replace(/\s+/g, ' ').trim();
    if (!name) {
      this.nameError.set(true);
      const form = event.target as HTMLFormElement;
      form.querySelector<HTMLInputElement>('#attachment-name')?.focus();
      return;
    }
    this.finish({
      asset: file.asset,
      name,
      description: this.description().replace(/\s+/g, ' ').trim(),
      fileName: file.fileName,
      mediaType: file.mediaType || 'application/octet-stream',
      size: file.size ?? 0,
    });
  }

  protected cancel(): void {
    this.finish(null);
  }

  /** A new file's name suggests the name readers see, until one is typed. */
  private suggestName(fileName: string): void {
    if (this.nameTyped) return;
    this.name.set(defaultName(fileName).slice(0, NAME_MAX));
    if (this.name()) this.nameError.set(false);
  }

  private factsLine(file: RowFacts, withName = false): string {
    return [
      withName ? file.fileName : null,
      fileTypeName(file.mediaType),
      file.size === null
        ? null
        : formatFileSize(file.size, this.language.locale()),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Closes the dialog; the open call is answered once it is gone and the focus is back where it
   * was (`closed`), so the caller can then put it elsewhere (the editor, on the new block).
   */
  private finish(choice: AttachmentChoice | null): void {
    this.choice = choice;
    this.visible.set(false);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.loads?.unsubscribe();
    this.loads = null;
  }

  protected closed(): void {
    this.answer(this.choice);
  }

  private answer(choice: AttachmentChoice | null): void {
    this.choice = null;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(choice);
  }
}
