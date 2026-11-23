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
import { lucideDownload, lucidePackage } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  LanguageService,
  RelativeTimePipe,
  translated,
} from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName } from '../content/browser-model';
import { injectPersonName } from '../history/history-model';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { frameOffset } from '../releases/frame-offset';
import { injectQueryState, intParam } from '../view-state';
import { TranslationJobCancellation } from './job-cancellation';
import { TranslationJobDownload } from './job-download';
import {
  cancellable,
  JOB_PAGE_SIZES,
  JOB_STATE_BADGE,
  JOB_STATE_TEXT,
  jobSubjectText,
  type JobItem,
} from './translations-model';
import { TranslationsSource } from './translations-source';
import { TranslationsChanges } from './translations-view';

type JobDoc = Response<'/translations/exports'>;

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * The Jobs tab of Translations (#87): the delta exports, newest first, paged: what was sent
 * (a manual, a folder or chosen modules, with its blocks and words), into which languages, who
 * sent it when, its due date and its state. Each can be downloaded again, and one not cancelled as
 * a COTI package for a translation management system (#140); one still at the agency can be
 * cancelled, with Undo (the cancel goes once the toast ends). Page and size live in
 * the address.
 */
@Component({
  selector: 'of-translation-jobs-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    DatePipe,
    RelativeTimePipe,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardTableImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideDownload, lucidePackage })],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      [label]="'editor.translations.jobs.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="'editor.translations.jobs.empty.title' | transloco"
      [emptyDescription]="
        'editor.translations.jobs.empty.description' | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <table z-table class="min-w-[56rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[30%]">
                {{ 'editor.translations.jobs.table.subject' | transloco }}
              </th>
              <th z-table-head class="w-40">
                {{ 'editor.translations.jobs.table.languages' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.translations.jobs.table.exported' | transloco }}
              </th>
              <th z-table-head class="w-32">
                {{ 'editor.translations.jobs.table.due' | transloco }}
              </th>
              <th z-table-head class="w-32">
                {{ 'editor.translations.jobs.table.state' | transloco }}
              </th>
              <th z-table-head class="w-64">
                <span class="sr-only">{{
                  'editor.translations.jobs.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (job of asJobs(items); track job.id) {
              @let state = stateOf(job);
              <tr
                z-table-row
                [ofListItem]="job"
                data-slot="job-row"
                [attr.data-row]="job.id"
                [attr.data-state]="state"
              >
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="block font-medium break-words">{{
                    subjectText(job)
                  }}</span>
                  <span
                    class="text-muted-foreground block text-xs break-words"
                    >{{
                      'editor.translations.jobs.counts'
                        | transloco
                          : {
                              modules: job.meta.modules,
                              units: job.meta.units,
                              words: job.meta.words,
                            }
                    }}</span
                  >
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="flex flex-wrap gap-1">
                    @for (l of job.attributes.languages; track l) {
                      <z-badge
                        zType="outline"
                        class="font-semibold uppercase"
                        [attr.title]="languageLabel(l)"
                        >{{ l
                        }}<span class="sr-only">
                          {{ languageLabel(l) }}</span
                        ></z-badge
                      >
                    }
                  </span>
                </td>
                <td
                  z-table-cell
                  class="text-muted-foreground align-top text-sm whitespace-normal"
                >
                  <span
                    class="block"
                    [attr.title]="job.attributes.createdAt | ofDate: dateTime"
                    >{{ job.attributes.createdAt | ofRelativeTime }}</span
                  >
                  <span class="block text-xs break-words">{{
                    person(job.attributes.createdBy)
                  }}</span>
                </td>
                <td z-table-cell class="align-top text-sm whitespace-normal">
                  @if (job.attributes.dueDate; as due) {
                    {{ due | ofDate: dateOnly }}
                  } @else {
                    <span class="text-muted-foreground">{{
                      'editor.translations.jobs.noDue' | transloco
                    }}</span>
                  }
                </td>
                <td z-table-cell class="align-top">
                  <z-badge [zType]="stateBadge[state]" data-slot="job-state">{{
                    stateText[state] | transloco
                  }}</z-badge>
                </td>
                <td z-table-cell class="align-top">
                  <span class="flex flex-wrap justify-end gap-1">
                    <button
                      z-button
                      zType="outline"
                      zSize="xs"
                      type="button"
                      data-slot="job-download"
                      [zLoading]="downloading() === job.id"
                      [attr.aria-label]="
                        'editor.translations.jobs.downloadLabel'
                          | transloco: { name: subjectText(job) }
                      "
                      (click)="download(job)"
                    >
                      <ng-icon
                        name="lucideDownload"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      {{ 'editor.translations.jobs.download' | transloco }}
                    </button>
                    @if (state !== 'cancelled') {
                      <button
                        z-button
                        zType="outline"
                        zSize="xs"
                        type="button"
                        data-slot="job-package"
                        class="animate-in fade-in-0 motion-reduce:animate-none"
                        [zLoading]="downloading() === packageKey(job)"
                        [attr.aria-label]="
                          'editor.translations.jobs.packageLabel'
                            | transloco: { name: subjectText(job) }
                        "
                        (click)="downloadPackage(job)"
                      >
                        <ng-icon
                          name="lucidePackage"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {{ 'editor.translations.jobs.package' | transloco }}
                      </button>
                    }
                    @if (state === 'sent' && mayCancel(job)) {
                      <button
                        z-button
                        zType="ghost"
                        zSize="xs"
                        type="button"
                        data-slot="job-cancel"
                        [attr.aria-label]="
                          'editor.translations.jobs.cancelLabel'
                            | transloco: { name: subjectText(job) }
                        "
                        (click)="cancel(job)"
                      >
                        {{
                          'editor.translations.jobs.cancel.action' | transloco
                        }}
                      </button>
                    }
                  </span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
export class TranslationJobsPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  private readonly changes = inject(TranslationsChanges);
  private readonly cancellation = inject(TranslationJobCancellation);
  private readonly downloads = inject(TranslationJobDownload);
  private readonly t = injectTranslate();
  private readonly nameOf = injectPersonName();
  private readonly source = inject(TranslationsSource);

  protected readonly view = injectQueryState({
    page: intParam(1),
    size: intParam(JOB_PAGE_SIZES[0], { only: JOB_PAGE_SIZES }),
  });
  protected readonly pageSizes = JOB_PAGE_SIZES;
  protected readonly stateText = JOB_STATE_TEXT;
  protected readonly stateBadge = JOB_STATE_BADGE;
  protected readonly dateTime: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  protected readonly dateOnly: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeZone: 'UTC',
  };

  protected readonly doc = signal<JobDoc | null>(null);
  protected readonly loading = signal(false);
  protected readonly downloading = signal<string | null>(null);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  protected readonly person = (who: { kind: string; id: string }) =>
    this.nameOf(who.kind, who.id);

  constructor() {
    effect(() => {
      const query = {
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.me.me();
      this.changes.changed();
      this.reloads();
      untracked(() => void this.load(query));
    });
    inject(DestroyRef).onDestroy(() => this.runs++);
  }

  protected asJobs(items: readonly unknown[]): readonly JobItem[] {
    return items as readonly JobItem[];
  }

  /** The job's state, cancelled at once while its cancel waits for Undo. */
  protected stateOf(job: JobItem): JobItem['attributes']['state'] {
    return job.attributes.state === 'sent' &&
      this.cancellation.isCancelling(job.id)
      ? 'cancelled'
      : job.attributes.state;
  }

  protected mayCancel(job: JobItem): boolean {
    return cancellable(job);
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected subjectText(job: JobItem): string {
    return jobSubjectText(job.attributes.subject, this.t, {
      manuals: this.source.manualTitles(),
      folders: this.source.folderLabels(),
    });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected async download(job: JobItem): Promise<void> {
    if (this.downloading()) return;
    this.downloading.set(job.id);
    try {
      await this.downloads.save({
        id: job.id,
        languages: job.attributes.languages,
      });
    } catch {
      this.toast.error(
        translated('editor.translations.jobs.downloadFailed', {
          name: this.subjectText(job),
        }),
      );
    } finally {
      this.downloading.set(null);
    }
  }

  /** The `downloading` key of a job's package, apart from its file's. */
  protected packageKey(job: JobItem): string {
    return `${job.id}/package`;
  }

  protected async downloadPackage(job: JobItem): Promise<void> {
    if (this.downloading()) return;
    this.downloading.set(this.packageKey(job));
    try {
      await this.downloads.savePackage({ id: job.id });
    } catch {
      this.toast.error(
        translated('editor.translations.jobs.packageFailed', {
          name: this.subjectText(job),
        }),
      );
    } finally {
      this.downloading.set(null);
    }
  }

  protected cancel(job: JobItem): void {
    this.cancellation.cancel(job.id, this.subjectText(job));
  }

  private async load(query: { page: number; size: number }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/translations/exports', {
          query: pageQuery({ number: query.page, size: query.size }),
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
