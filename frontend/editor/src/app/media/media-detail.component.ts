import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  resource,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCopy,
  lucideDownload,
  lucideFile,
  lucideRefreshCw,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ToastService } from '@openfolia/ui/toast';
import { ZardTooltipImports } from '@openfolia/ui/tooltip';

import { toApiError } from '../api';
import { AttachmentFiles } from '../attachments/attachment-files';
import { languageName } from '../content/browser-model';
import { apiErrorText } from '../i18n';
import { ImageThumbComponent } from '../images/image-thumb.component';
import { ChangeSetUrl } from '../session/change-set-url';
import {
  displayName,
  freshUpload,
  hasRenditions,
  inUse,
  isImage,
  PAGE_SIZES,
  shortType,
  type MediaItem,
} from './media-model';
import { UnusedLocator, type UnusedPlace } from './media-unused';
import { MediaUsageReader, type UsageRow } from './media-usage';

/**
 * Stands in for the link in a translated sentence, which is split around it: each language's
 * message has `{revision}` once (the translation check keeps the arguments the same everywhere).
 */
const MARK = '\u0000';

/** The rows of one language. */
interface LanguageGroup {
  readonly lang: string;
  readonly name: string;
  readonly same: readonly UsageRow[];
  readonly other: readonly UsageRow[];
}

/**
 * The details of one file (screen 23's side panel; a sheet on phones): a preview (the image's
 * 1280-pixel rendition; for an attached file its icon, name, size and Download), its type, size,
 * dimensions and hash (copyable), and where it is used per language: each module a link into the
 * editor at the block, with an image's alt text in that language, "Replace in <language>" (the
 * module in the editor, with the image dialog open on the block) and "Other image in <language>"
 * where that language's module shows another image in the same block. Delete only on a file
 * nobody uses (the "Unused" list) and only for a role that may delete files; otherwise the reason.
 * A file no module shown uses, on the other list, says that only what the reader sees here counts,
 * and (for a role that may delete) whether the "Unused" list has it, with a link, or why not.
 */
@Component({
  selector: 'of-media-detail',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    FadeInDirective,
    ImageThumbComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    ZardTooltipImports,
  ],
  providers: [AttachmentFiles],
  viewProviders: [
    provideIcons({
      lucideCopy,
      lucideDownload,
      lucideFile,
      lucideRefreshCw,
      lucideTrash2,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4 text-sm' },
  template: `
    @let f = item();
    <div class="flex items-start justify-between gap-2">
      <h2
        class="m-0 min-w-0 text-base font-medium [overflow-wrap:anywhere]"
        data-slot="media-detail-name"
      >
        {{ name() }}
      </h2>
      @if (closable()) {
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          type="button"
          class="-me-1 -mt-1 shrink-0"
          [attr.aria-label]="'editor.media.detail.close' | transloco"
          (click)="closed.emit()"
        >
          <ng-icon name="lucideX" aria-hidden="true" />
        </button>
      }
    </div>

    @if (image() && viewable()) {
      <of-image-thumb
        class="aspect-[4/3]"
        [asset]="f.attributes.reference"
        [changeSetId]="changeSetId()"
        [upload]="fresh()"
        [width]="renditions() ? 1280 : undefined"
      />
    } @else {
      <div
        class="bg-muted text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-md p-6 text-center"
      >
        <ng-icon name="lucideFile" size="32" aria-hidden="true" />
        <span class="text-foreground text-sm [overflow-wrap:anywhere]">{{
          name()
        }}</span>
        @if (f.attributes.size !== null) {
          <span class="text-xs">{{ bytes(f.attributes.size) }}</span>
        }
        @if (viewable()) {
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            [zDisabled]="downloading()"
            (click)="download()"
          >
            <ng-icon name="lucideDownload" aria-hidden="true" />
            {{ 'editor.media.detail.download' | transloco }}
          </button>
        }
      </div>
    }

    <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      <dt class="text-muted-foreground text-xs leading-5">
        {{ 'editor.media.detail.type' | transloco }}
      </dt>
      <dd class="m-0 [overflow-wrap:anywhere]">
        {{ typeText() }}
      </dd>
      <dt class="text-muted-foreground text-xs leading-5">
        {{ 'editor.media.detail.size' | transloco }}
      </dt>
      <dd class="m-0">
        {{
          f.attributes.size === null
            ? ('editor.media.detail.unknown' | transloco)
            : bytes(f.attributes.size)
        }}
      </dd>
      @if (dimensions(); as d) {
        <dt class="text-muted-foreground text-xs leading-5">
          {{ 'editor.media.detail.dimensions' | transloco }}
        </dt>
        <dd class="m-0">{{ d }}</dd>
      }
      <dt class="text-muted-foreground text-xs leading-5">
        {{ 'editor.media.detail.hash' | transloco }}
      </dt>
      <dd class="m-0 flex min-w-0 items-start gap-1">
        <code
          class="min-w-0 font-mono text-xs leading-5 [overflow-wrap:anywhere]"
          data-slot="media-hash"
          >{{ f.id }}</code
        >
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          type="button"
          class="-mt-1 shrink-0"
          [zTooltip]="'editor.media.detail.copyHash' | transloco"
          [attr.aria-label]="'editor.media.detail.copyHash' | transloco"
          (click)="copyHash()"
        >
          <ng-icon name="lucideCopy" aria-hidden="true" />
        </button>
      </dd>
    </dl>

    @if (f.meta.missing) {
      <p class="text-destructive m-0 text-xs">
        {{ 'editor.media.detail.missing' | transloco }}
      </p>
    }

    <section
      class="flex flex-col gap-2"
      [attr.aria-label]="'editor.media.detail.usage' | transloco"
    >
      <h3 class="text-muted-foreground m-0 text-xs font-normal">
        {{ 'editor.media.detail.usage' | transloco }}
      </h3>
      @if (coverOf().length > 0) {
        <ul
          class="m-0 flex list-none flex-col gap-1 p-0"
          data-slot="usage-manuals"
        >
          @for (m of coverOf(); track m.manualId) {
            <li class="flex min-w-0 flex-col gap-0.5">
              <span class="text-muted-foreground text-xs">{{
                'editor.media.detail.coverOf' | transloco
              }}</span>
              <a
                class="text-foreground focus-visible:ring-ring/50 self-start rounded-sm font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                [routerLink]="['/manuals']"
                [queryParams]="{ manual: m.manualId }"
                >{{ m.title }}</a
              >
            </li>
          }
        </ul>
      }
      @if (!used()) {
        <p class="text-muted-foreground m-0">
          {{
            (unusedList()
              ? 'editor.media.detail.unused'
              : 'editor.media.detail.notYetUsed'
            ) | transloco
          }}
        </p>
        @if (!unusedList()) {
          <p class="text-muted-foreground m-0 text-xs" data-slot="usage-scope">
            {{ 'editor.media.detail.onlyHere' | transloco }}
          </p>
        }
      } @else if (!modulesUse()) {
        <!-- Only manuals' cover images (issue 394): listed above. -->
      } @else if (usage.isLoading() && !usage.hasValue()) {
        <div class="flex flex-col gap-2" aria-hidden="true">
          <z-skeleton class="h-4 w-1/3" />
          <z-skeleton class="h-4 w-3/4" />
          <z-skeleton class="h-4 w-2/3" />
        </div>
        <span class="sr-only" role="status">{{
          'editor.media.detail.usageLoading' | transloco
        }}</span>
      } @else if (usage.error()) {
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-destructive m-0">{{ usageError() }}</p>
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            (click)="usage.reload()"
          >
            <ng-icon name="lucideRefreshCw" aria-hidden="true" />
            {{ 'editor.session.retry' | transloco }}
          </button>
        </div>
      } @else {
        <div class="flex flex-wrap gap-1" ofFadeIn>
          @for (g of groups(); track g.lang) {
            @if (g.same.length > 0) {
              <z-badge zType="success" class="font-normal">{{
                'editor.media.detail.usesIt' | transloco: { language: g.name }
              }}</z-badge>
            }
            @if (g.other.length > 0) {
              <z-badge zType="secondary" class="font-normal">{{
                'editor.media.detail.otherIn' | transloco: { language: g.name }
              }}</z-badge>
            }
          }
        </div>
        <ul class="m-0 flex list-none flex-col gap-3 p-0" ofFadeIn>
          @for (g of groups(); track g.lang) {
            <li class="flex flex-col gap-1.5">
              <span class="text-muted-foreground text-xs" [attr.lang]="null">{{
                g.name
              }}</span>
              <ul class="m-0 flex list-none flex-col gap-2 p-0">
                @for (row of g.same; track rowKey(row)) {
                  <li class="flex min-w-0 flex-col gap-0.5">
                    <a
                      class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                      [routerLink]="['/content', row.lang, row.moduleId]"
                      [queryParams]="blockLink(row)"
                      [attr.lang]="row.lang"
                      >{{ row.title }}</a
                    >
                    @if (row.alt !== null) {
                      <span
                        class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                        [attr.lang]="row.lang"
                      >
                        <span class="sr-only">{{
                          'editor.media.detail.alt' | transloco
                        }}</span>
                        {{
                          row.alt
                            ? '“' + row.alt + '”'
                            : ('editor.media.detail.noAlt' | transloco)
                        }}
                      </span>
                    }
                    @if (image() && row.blockId) {
                      @if (replaceBlocked(); as reason) {
                        <span
                          class="self-start"
                          [zTooltip]="reason | transloco"
                          tabindex="0"
                        >
                          <button
                            z-button
                            zType="link"
                            zSize="sm"
                            type="button"
                            class="h-auto p-0"
                            [zDisabled]="true"
                          >
                            {{
                              'editor.media.detail.replaceIn'
                                | transloco: { language: g.name }
                            }}
                          </button>
                        </span>
                      } @else {
                        <a
                          class="text-foreground focus-visible:ring-ring/50 self-start rounded-sm text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
                          [routerLink]="['/content', row.lang, row.moduleId]"
                          [queryParams]="replaceLink(row)"
                          data-slot="replace-link"
                          >{{
                            'editor.media.detail.replaceIn'
                              | transloco: { language: g.name }
                          }}</a
                        >
                      }
                    }
                  </li>
                }
                @for (row of g.other; track rowKey(row)) {
                  <li class="flex min-w-0 flex-col gap-0.5">
                    <a
                      class="text-foreground focus-visible:ring-ring/50 rounded-sm [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-[3px]"
                      [routerLink]="['/content', row.lang, row.moduleId]"
                      [queryParams]="blockLink(row)"
                      data-slot="other-link"
                      >{{
                        'editor.media.detail.otherImageIn'
                          | transloco: { language: g.name }
                      }}</a
                    >
                    <span
                      class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                      [attr.lang]="row.lang"
                      >{{ row.title }}</span
                    >
                  </li>
                }
              </ul>
            </li>
          }
        </ul>
        @if (more() > 0) {
          <p class="text-muted-foreground m-0 text-xs">
            {{ 'editor.media.detail.more' | transloco: { count: more() } }}
          </p>
        }
      }
    </section>

    <div class="border-border flex flex-col gap-2 border-t pt-3">
      @if (deletable()) {
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="text-destructive hover:text-destructive self-start"
          [attr.aria-label]="
            'editor.media.delete.label' | transloco: { name: name() }
          "
          (click)="deleted.emit()"
        >
          <ng-icon name="lucideTrash2" aria-hidden="true" />
          {{ 'editor.media.delete.action' | transloco }}
        </button>
      } @else if (checksUnused()) {
        <div
          class="flex flex-col gap-1.5 text-xs"
          role="status"
          data-slot="unused-check"
        >
          @let place = unusedPlace();
          @if (place === undefined) {
            <div class="flex flex-col gap-1.5 py-0.5" aria-hidden="true">
              <z-skeleton class="h-3.5 w-full" />
              <z-skeleton class="h-3.5 w-2/3" />
              <z-skeleton class="h-3.5 w-1/3" />
            </div>
            <span class="sr-only">{{
              'editor.media.unusedCheck.loading' | transloco
            }}</span>
          } @else {
            @if (place?.kind === 'absent') {
              @if (uploadHint(); as hint) {
                <p
                  class="text-muted-foreground m-0 [overflow-wrap:anywhere]"
                  data-slot="upload-hint"
                  ofFadeIn
                >
                  {{ hint.before
                  }}<a
                    class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
                    data-slot="upload-revision-link"
                    routerLink="/review"
                    [queryParams]="{ cs: hint.id }"
                    >{{ hint.link }}</a
                  >{{ hint.after }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0" ofFadeIn>
                  {{ 'editor.media.unusedCheck.absent' | transloco }}
                </p>
              }
            } @else {
              <p class="text-muted-foreground m-0" ofFadeIn>
                {{
                  (place?.kind === 'listed'
                    ? 'editor.media.unusedCheck.listed'
                    : 'editor.media.unusedCheck.unknown'
                  ) | transloco
                }}
              </p>
              <a
                class="text-foreground focus-visible:ring-ring/50 self-start rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
                data-slot="unused-link"
                ofFadeIn
                [routerLink]="[]"
                [queryParams]="unusedLink()"
                queryParamsHandling="merge"
                >{{
                  (place?.kind === 'listed'
                    ? 'editor.media.unusedCheck.open'
                    : 'editor.media.unusedCheck.look'
                  ) | transloco
                }}</a
              >
            }
          }
        </div>
      } @else {
        <p class="text-muted-foreground m-0 text-xs" data-slot="delete-reason">
          {{ deleteReason() | transloco }}
        </p>
      }
    </div>
  `,
})
export class MediaDetailComponent {
  private readonly reader = inject(MediaUsageReader);
  private readonly locator = inject(UnusedLocator);
  private readonly files = inject(AttachmentFiles);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly t = injectTranslate();

  readonly item = input.required<MediaItem>();
  /** The file is from the "Unused" list: nobody uses it. */
  readonly unusedList = input(false);
  /** The configured languages, source first: the order of the usage. */
  readonly languages = input<readonly string[]>([]);
  /** The person may delete unused files (`content.edit` unrestricted). */
  readonly canDelete = input(false);
  /** The chosen change set, where a fresh upload is previewed: the person's own, or null. */
  readonly changeSetId = input<string | null>(null);
  /** That change set's title; null while it isn't known (the sentence says "this revision"). */
  readonly changeSetTitle = input<string | null>(null);
  /** Why "Replace in <language>" can't be used now (a key), or null. */
  readonly replaceBlocked = input<string | null>(null);
  /** Whether it shows a close button (the side panel; the sheet has its own). */
  readonly closable = input(true);
  /** Bumps when the list is read again: the usage is read again too. */
  readonly revision = input(0);
  /** The list's page size: the link to the "Unused" list opens the page the file is on. */
  readonly pageSize = input<number>(PAGE_SIZES[0]);

  readonly closed = output<void>();
  readonly deleted = output<void>();

  protected readonly downloading = signal(false);

  /** The name the list shows for the file (its language); its own name by default. */
  readonly label = input<string | null>(null);

  protected readonly name = computed(
    () => this.label() ?? displayName(this.item()),
  );
  /**
   * Whether the API serves the file: not one nobody uses (unless it is the person's own
   * upload), as the grid shows it too.
   */
  protected readonly viewable = computed(
    () => !this.unusedList() || this.item().meta.uploaded,
  );
  protected readonly image = computed(() => isImage(this.item()));
  protected readonly renditions = computed(() => hasRenditions(this.item()));
  /** An upload no module shows yet: its preview is the change set's. */
  protected readonly fresh = computed(() => freshUpload(this.item()));
  protected readonly used = computed(() =>
    inUse(this.item(), this.unusedList()),
  );

  protected readonly typeText = computed(() => {
    const f = this.item();
    const short = shortType(f);
    const kind = this.t(
      this.image() ? 'editor.media.kind.image' : 'editor.media.kind.attachment',
    );
    const type = f.attributes.contentType;
    return [kind, short, short ? null : type].filter(Boolean).join(' · ');
  });

  protected readonly dimensions = computed(() => {
    const { width, height } = this.item().attributes;
    if (!width || !height) return null;
    const fmt = new Intl.NumberFormat(this.language.locale());
    return this.t('editor.images.pixels', {
      width: fmt.format(width),
      height: fmt.format(height),
    });
  });

  /** The manuals that have it as their cover image (#394). */
  protected readonly coverOf = computed(() =>
    this.unusedList() ? [] : (this.item().meta.usedInManuals ?? []),
  );
  /** Whether a module uses it: what the usage below reads. */
  protected readonly modulesUse = computed(
    () => !this.unusedList() && this.item().meta.usedInCount > 0,
  );

  protected readonly usage = resource({
    params: () =>
      this.modulesUse()
        ? {
            item: this.item(),
            languages: this.languages(),
            revision: this.revision(),
          }
        : undefined,
    loader: ({ params }) => this.reader.read(params.item, params.languages),
  });

  protected readonly usageError = computed(() => {
    const error = this.usage.error();
    if (!error) return '';
    const text = apiErrorText(toApiError(error));
    return this.t(text.key, text.params);
  });

  protected readonly groups = computed((): LanguageGroup[] => {
    if (!this.usage.hasValue()) return [];
    const rows = this.usage.value()?.rows ?? [];
    const locale = this.language.locale();
    const out = new Map<string, { same: UsageRow[]; other: UsageRow[] }>();
    for (const row of rows) {
      const group = out.get(row.lang) ?? { same: [], other: [] };
      group[row.kind].push(row);
      out.set(row.lang, group);
    }
    return [...out.entries()].map(([lang, g]) => ({
      lang,
      name: languageName(locale, lang),
      same: g.same,
      other: g.other,
    }));
  });

  protected readonly more = computed(() =>
    this.usage.hasValue() ? (this.usage.value()?.more ?? 0) : 0,
  );

  protected readonly deletable = computed(
    () => this.unusedList() && this.canDelete(),
  );

  /** Why there is no Delete (a key): the role first, as only that makes a difference then. */
  protected readonly deleteReason = computed(() =>
    this.canDelete()
      ? 'editor.media.delete.onlyUnused'
      : 'editor.media.delete.notAllowed',
  );

  /**
   * A file no module shown here uses, for a role that may delete files: whether the "Unused"
   * list has it (and a link there) or why not. That list alone checks every place a file can be
   * used, so only there is Delete offered.
   */
  protected readonly checksUnused = computed(
    () => !this.unusedList() && !this.used() && this.canDelete(),
  );

  private readonly unusedCheck = resource({
    params: () =>
      this.checksUnused()
        ? { id: this.item().id, revision: this.revision() }
        : undefined,
    loader: ({ params, abortSignal }) =>
      this.locator.find(params.id, abortSignal),
  });

  /** The last answer for the file shown, kept while the list is read again (no flash). */
  private readonly keptPlace = linkedSignal<
    { readonly id: string; readonly place: UnusedPlace | undefined },
    { readonly id: string; readonly place: UnusedPlace } | null
  >({
    source: () => ({
      id: this.item().id,
      place: this.unusedCheck.hasValue() ? this.unusedCheck.value() : undefined,
    }),
    computation: (now, previous) =>
      now.place
        ? { id: now.id, place: now.place }
        : previous?.value?.id === now.id
          ? previous.value
          : null,
  });

  /** Where the file is on the "Unused" list; undefined while first checking; null: not known. */
  protected readonly unusedPlace = computed(
    (): UnusedPlace | null | undefined => {
      // Read every time, so it has seen each answer (a linked signal computes only when read).
      const kept = this.keptPlace()?.place;
      if (this.unusedCheck.error()) return null;
      return kept;
    },
  );

  /**
   * Why a file uploaded into the person's own chosen change set isn't on the "Unused" list: the
   * sentence around a link to that change set's review page, named by its title ("this revision"
   * while the title isn't known). Only for `meta.uploaded`, which the API sets for uploads into
   * `filter[changeSet]`, the person's own change set; anyone else's is never named or linked.
   */
  protected readonly uploadHint = computed(() => {
    const id = this.changeSetId();
    if (!id || !this.item().meta.uploaded) return null;
    const title = this.changeSetTitle()?.trim() || null;
    const text = title
      ? this.t('editor.media.unusedCheck.absentUploadNamed', { revision: MARK })
      : this.t('editor.media.unusedCheck.absentUploadThis', {
          revision: MARK,
        });
    const at = text.indexOf(MARK);
    return {
      id,
      before: at < 0 ? text : text.slice(0, at),
      link: title ?? this.t('editor.media.unusedCheck.thisRevision'),
      after: at < 0 ? '' : text.slice(at + MARK.length),
    };
  });

  /**
   * The "Unused" list with this file open at the page it is on, the other filters left out (they
   * could hide it); when that page is not known, the list's first page, without the file (which
   * would close at once there).
   */
  protected readonly unusedLink = computed(
    (): Record<string, string | null> => {
      const place = this.unusedPlace();
      const page =
        place?.kind === 'listed'
          ? Math.floor(place.index / this.pageSize()) + 1
          : null;
      return {
        usage: 'unused',
        file: page === null ? null : this.item().id,
        page: page === null || page === 1 ? null : String(page),
        type: null,
        lang: null,
        q: null,
      };
    },
  );

  protected rowKey(row: UsageRow): string {
    return `${row.lang}/${row.moduleId}/${row.blockId ?? ''}/${row.kind}`;
  }

  protected blockLink(row: UsageRow): Record<string, string> {
    return {
      ...this.csLink.params(),
      ...(row.blockId ? { block: row.blockId } : {}),
    };
  }

  protected replaceLink(row: UsageRow): Record<string, string> {
    return { ...this.blockLink(row), replace: 'image' };
  }

  protected bytes(size: number): string {
    return formatFileSize(size, this.language.locale());
  }

  protected async copyHash(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.item().id);
      this.toast.success(translated('editor.media.detail.hashCopied'));
    } catch {
      this.toast.error(translated('editor.media.detail.copyFailed'));
    }
  }

  protected async download(): Promise<void> {
    const f = this.item();
    this.downloading.set(true);
    try {
      const saved = await this.files.save(
        f.attributes.reference,
        f.attributes.fileName ?? '',
        this.changeSetId(),
      );
      if (!saved)
        this.toast.error(
          translated('editor.media.detail.downloadMissing', {
            name: this.name(),
          }),
        );
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.toast.error(translated(text.key, text.params));
    } finally {
      this.downloading.set(false);
    }
  }
}
