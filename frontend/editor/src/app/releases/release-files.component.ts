import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideClock,
  lucideDownload,
  lucideLoaderCircle,
  lucideQrCode,
  lucideRotateCcw,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { MeterBarComponent } from '@openfolia/ui/meter-bar';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { StableAddressDialogComponent } from '../addresses/stable-address-dialog.component';
import { DesignInUseComponent } from '../admin/page-designs/design-in-use.component';
import {
  StableAddresses,
  type ShownAddress,
} from '../addresses/stable-addresses';
import { languageName } from '../content/browser-model';
import { apiErrorText, UiTexts } from '../i18n';
import { ReleaseSource } from './release-source';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import type { ManualItem } from '../preview/preview-model';
import { frameOffset } from './frame-offset';
import { ReleaseActions } from './release-actions';
import {
  afterRetry,
  anyPending,
  donePercent,
  FILE_PAGE_SIZE,
  groupOutputs,
  OFFLINE_PACKAGES,
  OUTPUT_STATE_BADGE,
  OUTPUT_STATE_TEXT,
  outputNames,
  POLL_MS,
  progressKey,
  progressParams,
  sameProgress,
  type OutputProgress,
  type OutputState,
  type OutputTexts,
  type ReleaseItem,
  type ReleaseOutput,
  waitingText,
} from './releases-model';

type OutputDoc = Response<'/releases/{releaseId}/outputs'>;

const STATE_ICON: Readonly<Record<OutputState, string>> = {
  queued: 'lucideClock',
  rendering: 'lucideLoaderCircle',
  done: 'lucideCircleCheck',
  failed: 'lucideCircleX',
};

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * A release's files (`GET /releases/:id/outputs`), by manual, then variant and language: the
 * state as a badge with an icon and a word, the size, Download once done, and Retry on a failed
 * one (`release.publish`). Above them, where they stand (`progress`, the release's
 * `meta.outputs`, which the parent reads again while they are under way): "Preparing the files…"
 * while they are planned (instead of "No files"), then "4 of 9 files ready" with a bar, and
 * "Waiting for 1,240 files of newer releases" while they wait behind those (#497). The page
 * of files is read again, quietly (the rows stay in place), whenever that progress changes; a
 * row whose state changed fades its new badge in. Without a progress (none given) the page reads
 * itself again every few seconds while any file on it is under way. A reader who may not read a
 * whole manual is not shown its files (the API leaves them out). Paged; the page is the parent's
 * (`?filesPage=`).
 */
@Component({
  selector: 'of-release-files',
  imports: [
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListTableDirective,
    MeterBarComponent,
    FadeInDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardTableImports,
    GuardDirective,
    StableAddressDialogComponent,
    DesignInUseComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideClock,
      lucideDownload,
      lucideLoaderCircle,
      lucideQrCode,
      lucideRotateCcw,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <!-- With no files (yet), the frame below says why: being prepared, failed, or none. -->
    @if (summarised(); as p) {
      <div
        ofFadeIn
        class="flex min-w-0 flex-col gap-1.5"
        data-slot="files-progress"
        [attr.data-progress]="p.state"
        role="status"
      >
        <p class="m-0 flex min-h-5 items-start gap-1.5 text-sm">
          @if (p.state === 'planning' || p.state === 'rendering') {
            <ng-icon
              name="lucideLoaderCircle"
              class="text-muted-foreground mt-0.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          } @else if (p.state === 'failed') {
            <ng-icon
              name="lucideCircleX"
              class="text-destructive mt-0.5 shrink-0"
              aria-hidden="true"
            />
          } @else if (p.total > 0) {
            <ng-icon
              name="lucideCircleCheck"
              class="text-success mt-0.5 shrink-0"
              aria-hidden="true"
            />
          }
          <span class="min-w-0 break-words">
            {{ summary() }}
            <!-- Behind newer releases' files: on the same line, so nothing below moves. -->
            @if (waiting(); as w) {
              <span
                ofFadeIn
                class="text-muted-foreground"
                data-slot="files-waiting"
                >· {{ w }}</span
              >
            }
          </span>
        </p>
        <of-meter-bar
          [value]="percent()"
          [tone]="
            p.failed > 0 || p.state === 'failed' ? 'destructive' : 'success'
          "
          [label]="'editor.releases.files.progressLabel' | transloco"
          [valueText]="summary()"
        />
      </div>
    } @else if (progress()?.state === 'planning') {
      <!-- The line's room, kept while the files are planned: no jump when it comes. While
           earlier releases are planned first (in the order cut), it says how many. -->
      <div class="flex flex-col gap-1.5">
        @if (waiting(); as w) {
          <p
            ofFadeIn
            class="text-muted-foreground m-0 flex min-h-5 items-start gap-1.5 text-sm"
            data-slot="files-waiting"
            role="status"
          >
            <ng-icon
              name="lucideClock"
              class="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0 break-words">{{ w }}</span>
          </p>
        } @else {
          <span aria-hidden="true" class="block h-5"></span>
        }
        <span aria-hidden="true" class="block h-1.5"></span>
      </div>
    }
    <of-list-frame
      #frame
      class="min-h-48 min-w-0"
      [label]="'editor.releases.files.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [skeletonRows]="4"
      [emptyTitle]="empty().title | transloco"
      [emptyDescription]="empty().description | transloco: empty().params"
      (pageChange)="pageChange.emit($event)"
      (retry)="reload()"
    >
      @if (progress()?.state === 'planning') {
        <ng-icon
          ofListEmpty
          name="lucideLoaderCircle"
          class="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      }
      <ng-template ofListTable let-items>
        <table z-table class="min-w-[34rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head>
                {{ 'editor.releases.files.table.file' | transloco }}
              </th>
              <th z-table-head class="w-32">
                {{ 'editor.releases.files.table.state' | transloco }}
              </th>
              <th z-table-head class="w-20">
                {{ 'editor.releases.files.table.size' | transloco }}
              </th>
              <th z-table-head class="w-52">
                <span class="sr-only">{{
                  'editor.releases.files.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          @for (group of groups(items); track group.manual) {
            <tbody z-table-body>
              <tr z-table-row class="hover:bg-transparent">
                <th
                  scope="colgroup"
                  colspan="4"
                  class="text-start font-medium break-words whitespace-normal"
                >
                  <span
                    class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <span class="min-w-0 break-words">{{
                      manualTitle(group.manual)
                    }}</span>
                    @if (group.outputs[0]?.meta?.design; as design) {
                      <of-design-in-use
                        class="text-muted-foreground text-xs font-normal"
                        [design]="design"
                      />
                    }
                  </span>
                </th>
              </tr>
              @for (o of group.outputs; track o.id) {
                <tr z-table-row [attr.data-state-file]="o.attributes.state">
                  <td
                    z-table-cell
                    class="ps-4 align-top break-words whitespace-normal"
                  >
                    <span class="block">{{ fileLabel(o) }}</span>
                    @if (
                      o.attributes.error && o.attributes.state === 'failed'
                    ) {
                      <span class="text-destructive block text-xs">{{
                        errorText(o)
                      }}</span>
                    }
                  </td>
                  <td z-table-cell class="align-top">
                    <!-- A new state is a new badge, faded in. -->
                    @for (state of [o.attributes.state]; track state) {
                      <z-badge ofFadeIn [zType]="badge[state]" class="gap-1">
                        <ng-icon
                          [name]="icon[state]"
                          aria-hidden="true"
                          [class.animate-spin]="state === 'rendering'"
                          class="motion-reduce:animate-none"
                        />
                        {{ stateText[state] | transloco }}
                      </z-badge>
                    }
                  </td>
                  <td
                    z-table-cell
                    class="text-muted-foreground align-top tabular-nums"
                  >
                    {{ size(o) }}
                  </td>
                  <td z-table-cell class="text-end align-top">
                    <div class="flex flex-wrap justify-end gap-2">
                      @if (hasAddress(o)) {
                        <button
                          z-button
                          zType="ghost"
                          zSize="sm"
                          type="button"
                          data-slot="file-address"
                          [attr.aria-label]="
                            'editor.addresses.openLabel'
                              | transloco: { name: fullLabel(o) }
                          "
                          (click)="showAddress(o)"
                        >
                          <ng-icon
                            name="lucideQrCode"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{ 'editor.addresses.open' | transloco }}
                        </button>
                      }
                      @if (o.attributes.state === 'done') {
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          [attr.aria-label]="
                            'editor.releases.files.downloadLabel'
                              | transloco: { name: fullLabel(o) }
                          "
                          (click)="download(o)"
                        >
                          <ng-icon
                            name="lucideDownload"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{ 'editor.releases.files.download' | transloco }}
                        </button>
                      } @else if (o.attributes.state === 'failed') {
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          [zLoading]="retrying() === o.id"
                          [ofGuard]="{
                            permission: 'release.publish',
                            blockedReason: retryBlocked(),
                          }"
                          [attr.aria-label]="
                            'editor.releases.files.retryLabel'
                              | transloco: { name: fullLabel(o) }
                          "
                          (click)="retry(o)"
                        >
                          <ng-icon
                            name="lucideRotateCcw"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{ 'editor.releases.retry' | transloco }}
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          }
        </table>
      </ng-template>
    </of-list-frame>
    <of-stable-address-dialog
      [(open)]="addressOpen"
      [name]="addressName()"
      [address]="address()"
      [loading]="addressLoading()"
      [failure]="addressFailure()"
    />
  `,
})
export class ReleaseFilesComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly actions = inject(ReleaseActions);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  /** The release page's reads: the configuration at `main`, for the variants' labels. */
  private readonly source = inject(ReleaseSource, { optional: true });
  private readonly t = injectTranslate();
  private readonly addresses = inject(StableAddresses);

  readonly release = input.required<ReleaseItem>();
  /**
   * Where the files stand (the release's `meta.outputs`), read again by the parent while they are
   * under way; undefined when the parent gives none (the page then polls itself).
   */
  readonly progress = input<OutputProgress | null | undefined>(undefined);
  /** The manuals at the release's tag: their titles and variants' labels. */
  readonly manuals = input<readonly ManualItem[]>([]);
  readonly page = input(1);
  /** Bumped by the parent to read the files again (after planning them anew). */
  readonly reloadKey = input(0);
  readonly pageChange = output<number>();
  /** A failed file was queued again: its progress is worth reading again. */
  readonly retried = output<void>();

  protected readonly badge = OUTPUT_STATE_BADGE;
  protected readonly stateText = OUTPUT_STATE_TEXT;
  protected readonly icon = STATE_ICON;

  protected readonly doc = signal<OutputDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly retrying = signal<string | null>(null);
  /** The stable address dialog (#450): which file's, and what was found. */
  protected readonly addressOpen = signal(false);
  protected readonly addressName = signal('');
  protected readonly address = signal<ShownAddress | null>(null);
  protected readonly addressLoading = signal(false);
  protected readonly addressFailure = signal<string | null>(null);
  private addressRuns = 0;
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly retryBlocked = computed(() =>
    this.retrying() !== null ? 'editor.releases.files.retrying' : null,
  );

  private readonly releaseId = computed(() => this.release().id);
  /** A file was queued again: the parent's next progress reloads the page, whatever it says. */
  private reloadAfterRetry = false;

  /** The progress shown above the rows; with none (yet), the frame's empty state says why. */
  protected readonly summarised = computed(() => {
    const p = this.progress();
    return p && p.total > 0 ? p : null;
  });

  protected readonly summary = computed(() => {
    const p = this.progress();
    return p ? this.t(progressKey(p), progressParams(p)) : '';
  });

  /** "Waiting for 1,240 files of newer releases" while its own wait behind them; else null. */
  protected readonly waiting = computed(() => {
    const text = waitingText(this.progress());
    return text ? this.t(text.key, text.params) : null;
  });

  protected readonly percent = computed(() => {
    const p = this.progress();
    return p ? donePercent(p) : 0;
  });

  /**
   * What the frame says with no files: being prepared, preparing failed, too many to prepare
   * (#477), or none at all.
   */
  protected readonly empty = computed(() => {
    const p = this.progress();
    if (p?.state === 'planning')
      return {
        title: 'editor.releases.files.preparing.title',
        description: 'editor.releases.files.preparing.description',
        params: {},
      };
    if (p?.refused)
      return {
        title: 'editor.releases.files.tooMany.title',
        description:
          p.refused.wanted === null
            ? 'editor.releases.files.tooMany.descriptionLimit'
            : 'editor.releases.files.tooMany.description',
        params: progressParams(p),
      };
    if (p?.state === 'failed')
      return {
        title: 'editor.releases.files.planFailed.title',
        description: 'editor.releases.files.planFailed.description',
        params: {},
      };
    return {
      title: 'editor.releases.files.empty.title',
      description: 'editor.releases.files.empty.description',
      params: {},
    };
  });

  private readonly manualsById = computed(
    () => new Map(this.manuals().map((m) => [m.id, m])),
  );

  constructor() {
    effect(() => {
      const request = {
        releaseId: this.releaseId(),
        page: this.page(),
        me: this.me.me().id,
      };
      this.reloads();
      this.reloadKey();
      untracked(() => void this.load(request.releaseId, request.page));
    });
    // Files got further (or were planned), or a file was queued again: the page again, quietly.
    // After a retry the next answer reloads even when its counts are the same as before (the file
    // may have failed again at once), so the row never stays "Queued".
    let shown: OutputProgress | null | undefined;
    let first = true;
    effect(() => {
      const next = this.progress();
      const changed = !sameProgress(shown, next);
      shown = next;
      if (first) {
        first = false;
        return;
      }
      if (!changed && !this.reloadAfterRetry) return;
      this.reloadAfterRetry = false;
      untracked(() => {
        if (this.doc()) void this.load(this.releaseId(), this.page(), true);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.timer);
    });
  }

  protected groups(items: readonly unknown[]) {
    return groupOutputs(items as readonly ReleaseOutput[]);
  }

  private readonly shownTexts: OutputTexts = {
    title: (t) => this.texts.text(t),
    variant: (values, fallback) =>
      this.texts.variant(values, this.source?.config(), fallback),
    offlinePackage: () => this.t('editor.releases.files.offlinePackage'),
    audience: (id) =>
      this.source?.config()?.audiences.find((a) => a.id === id)?.label,
  };

  /** The group's heading: the manual's title, or "Offline packages" (#59). */
  protected manualTitle(id: string): string {
    if (id === OFFLINE_PACKAGES)
      return this.t('editor.releases.files.offlinePackages');
    const manual = this.manualsById().get(id);
    return (manual && this.texts.text(manual.attributes.title)) || id;
  }

  /**
   * "Large · English": the variant's label, then the language; for an offline package (#59) its
   * audience level's ("Public · English"), or the language alone with no levels configured.
   */
  protected fileLabel(o: ReleaseOutput): string {
    const language = languageName(this.language.locale(), o.attributes.lang);
    const { variant } = outputNames(this.manualsById(), o, this.shownTexts);
    if (variant === '') return language;
    return this.t('editor.releases.files.name', { variant, language });
  }

  protected fullLabel(o: ReleaseOutput): string {
    return `${this.manualTitle(o.attributes.manual ?? OFFLINE_PACKAGES)}, ${this.fileLabel(o)}`;
  }

  /** A manual's PDF has stable addresses (#450); an offline package has none. */
  protected hasAddress(o: ReleaseOutput): boolean {
    return o.attributes.kind === 'pdf';
  }

  protected size(o: ReleaseOutput): string {
    return o.attributes.size === null
      ? ''
      : formatFileSize(o.attributes.size, this.language.locale());
  }

  protected errorText(o: ReleaseOutput): string {
    const code = o.attributes.error?.code ?? '';
    const text = apiErrorText({ kind: 'unknown', code, errors: [] });
    return this.t(text.key, text.params);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected download(o: ReleaseOutput): void {
    void this.actions.download(this.release().id, o.id, this.fullLabel(o));
  }

  /** Opens the file's stable addresses, looked up for it (the latest and the release's own). */
  protected async showAddress(o: ReleaseOutput): Promise<void> {
    const run = ++this.addressRuns;
    this.addressName.set(this.fullLabel(o));
    this.address.set(null);
    this.addressFailure.set(null);
    this.addressLoading.set(true);
    this.addressOpen.set(true);
    try {
      const { manual, variant, lang } = o.attributes;
      if (manual === null || variant === null) return;
      const found = await this.addresses.find({
        releaseId: this.release().id,
        manual,
        variant,
        lang,
      });
      if (run !== this.addressRuns) return;
      this.address.set(found);
    } catch (error) {
      if (run !== this.addressRuns) return;
      this.addressFailure.set(apiErrorText(toApiError(error)).key);
    } finally {
      if (run === this.addressRuns) this.addressLoading.set(false);
    }
  }

  protected async retry(o: ReleaseOutput): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(o.id);
    // Shown as queued at once; put back when the API refuses.
    const before = this.doc();
    this.replace(o.id, (x) => afterRetry(x, null));
    const answer = await this.actions.retry(this.release().id, o.id);
    this.retrying.set(null);
    if (answer) {
      this.replace(o.id, (x) => afterRetry(x, answer));
      this.reloadAfterRetry = true;
      this.retried.emit();
      this.schedule();
    } else if (before) {
      this.doc.set(before);
    }
  }

  private replace(id: string, change: (o: ReleaseOutput) => ReleaseOutput) {
    const doc = this.doc();
    if (!doc) return;
    this.doc.set({
      ...doc,
      data: doc.data.map((o) => (o.id === id ? change(o) : o)),
    });
  }

  /**
   * Without a progress from the parent: the page, read again in a few seconds while any file on
   * it is under way: quietly, so the rows stay as they are (not dimmed) until the new answer
   * replaces them. With one, the parent's polling drives it.
   */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.progress() !== undefined) return;
    if (!anyPending(this.doc()?.data ?? [])) return;
    this.timer = setTimeout(
      () => void this.load(this.release().id, this.page(), true),
      POLL_MS,
    );
  }

  private read(releaseId: string, page: number): Promise<OutputDoc> {
    return firstValueFrom(
      this.api.get('/releases/{releaseId}/outputs', {
        path: { releaseId },
        query: pageQuery({ number: page, size: FILE_PAGE_SIZE }),
      }),
    );
  }

  private async load(
    releaseId: string,
    page: number,
    quiet = false,
  ): Promise<void> {
    const run = ++this.runs;
    clearTimeout(this.timer);
    if (!quiet) {
      this.loading.set(true);
      this.failure.set(null);
    }
    try {
      const doc = await this.read(releaseId, page);
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        // Past the end (fewer files now): the last page instead.
        this.pageChange.emit(last);
        return;
      }
      this.doc.set(doc);
      this.schedule();
    } catch (error) {
      if (run !== this.runs) return;
      // A poll that failed tries again later; the rows read last stay.
      if (quiet) this.timer = setTimeout(() => this.schedule(), POLL_MS);
      else this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
