import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideCalendarClock,
  lucideCircleCheck,
  lucideCircleSlash,
  lucideStar,
  lucideWebhook,
} from '@ng-icons/lucide';
import { map } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  LanguageService,
  translated,
  type TranslatedText,
} from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  NoAccessStateComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { ApiError, toApiError } from '../api';
import { languageName } from '../content/browser-model';
import { injectPersonName } from '../history/history-model';
import { apiErrorText } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { idParam, injectQueryState, intParam, listParam } from '../view-state';
import { ReleaseActions } from './release-actions';
import { ReleaseArchiveButtonComponent } from './release-archive-button.component';
import { ReleaseChangesComponent } from './release-changes.component';
import { ReleaseFilesComponent } from './release-files.component';
import { ReleaseSource } from './release-source';
import {
  canPlanAgain,
  inProgress,
  NOTES_SUMMARY,
  notesShown,
  POLL_MS,
  RELEASE_ID,
  releaseStateOf,
  shortCommit,
  STATE_BADGE,
  STATE_TEXT,
  type OutputProgress,
  type ReleaseItem,
} from './releases-model';
import { WithdrawReleaseDialogComponent } from './withdraw-dialog.component';

const DATE_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
};
const LANG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const CHANGE_ID = /^[A-Za-z0-9-]{2,35}\/[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * A release's page (`/releases/:releaseId`, screen 16): what it is (product, product version,
 * who cut it and when, its commit and tag, withdrawn or not and why), its notes (the summary and
 * the summaries per language), its changelog (`of-release-changes`) and its files
 * (`of-release-files`). Where the files stand (`meta.outputs`: being prepared, rendering, done
 * or failed) is read again every few seconds while they are under way, and a toast says when they
 * are all ready (or some failed) while the page is open. A publisher withdraws it here (final,
 * with the reason), retries a failed file and plans the files again when none were planned. The
 * notes open on the summary in the interface language when the release has one (#794); a chosen
 * one, the pages and the opened changes are in the address.
 */
@Component({
  selector: 'of-release-detail-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    PageHeaderComponent,
    SegmentedComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    FadeInDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    GuardDirective,
    ReleaseChangesComponent,
    ReleaseArchiveButtonComponent,
    ReleaseFilesComponent,
    WithdrawReleaseDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ReleaseSource],
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideCalendarClock,
      lucideCircleCheck,
      lucideCircleSlash,
      lucideStar,
      lucideWebhook,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-5' },
  template: `
    @if (release(); as r) {
      <div class="flex flex-col gap-1.5" ofFadeIn>
        <of-page-header [title]="name()">
          <span ofTitleAside class="inline-flex flex-wrap gap-1.5">
            <z-badge [zType]="stateBadge[state()]" class="gap-1">
              <ng-icon
                [name]="
                  state() === 'withdrawn'
                    ? 'lucideCircleSlash'
                    : 'lucideCircleCheck'
                "
                aria-hidden="true"
              />
              {{ stateText[state()] | transloco }}
            </z-badge>
            @if (r.attributes.major) {
              <z-badge zType="warning" class="gap-1">
                <ng-icon name="lucideStar" aria-hidden="true" />
                {{ 'editor.releases.major' | transloco }}
              </z-badge>
            }
          </span>
          <a
            z-button
            zType="ghost"
            [routerLink]="['/releases']"
            [queryParams]="{ release: r.id }"
          >
            <ng-icon
              name="lucideArrowLeft"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.detail.back' | transloco }}
          </a>
          <a
            z-button
            zType="outline"
            [routerLink]="['/admin/webhooks']"
            [queryParams]="{ event: 'manual.released' }"
            [ofGuard]="{ permission: 'webhook.manage' }"
          >
            <ng-icon
              name="lucideWebhook"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.webhooks' | transloco }}
          </a>
          @if (state() === 'published') {
            <button
              z-button
              zType="destructive"
              type="button"
              data-slot="withdraw"
              [ofGuard]="{ permission: 'release.publish' }"
              (click)="openWithdraw()"
            >
              {{ 'editor.releases.withdraw.action' | transloco }}
            </button>
          }
        </of-page-header>
        <p class="text-muted-foreground m-0 text-sm break-words">
          {{
            'editor.releases.detail.published'
              | transloco
                : {
                    name: person(r.attributes.publishedBy),
                    date: (r.attributes.publishedAt | ofDate: dateTime),
                  }
          }}
          ·
          <span class="font-mono text-xs" [attr.title]="r.attributes.commit">{{
            commit()
          }}</span>
          ·
          <span class="font-mono text-xs [overflow-wrap:anywhere]">{{
            r.attributes.tag
          }}</span>
        </p>
      </div>

      @if (r.attributes.withdrawal; as w) {
        <div
          ofFadeIn
          role="note"
          class="border-border bg-muted flex flex-col gap-1 rounded-lg border p-4"
          data-slot="withdrawal"
        >
          <p class="m-0 flex items-center gap-2 font-medium">
            <ng-icon name="lucideCircleSlash" aria-hidden="true" />
            {{
              'editor.releases.detail.withdrawn'
                | transloco
                  : {
                      name: person(w.by),
                      date: (w.at | ofDate: dateTime),
                    }
            }}
          </p>
          <p class="m-0 text-sm break-words whitespace-pre-line">
            {{ w.reason }}
          </p>
        </div>
      }

      <div class="grid min-w-0 gap-6 xl:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-6">
          <section class="flex min-w-0 flex-col gap-3" aria-labelledby="notes">
            <h2 id="notes" class="m-0 text-base font-semibold">
              {{ 'editor.releases.notes.title' | transloco }}
            </h2>
            @if (noteOptions().length > 1) {
              <of-segmented
                [label]="'editor.releases.notes.language' | transloco"
                [options]="noteOptions()"
                [value]="notesLang()"
                (valueChange)="view.set({ notes: $event })"
              />
            }
            @if (notes(); as text) {
              <p
                class="m-0 text-sm break-words whitespace-pre-line"
                data-slot="notes"
              >
                {{ text }}
              </p>
            } @else {
              <p class="text-muted-foreground m-0 text-sm">
                {{ 'editor.releases.notes.none' | transloco }}
              </p>
            }
          </section>
          <section
            class="flex min-w-0 flex-col gap-1"
            aria-labelledby="changes"
          >
            <h2 id="changes" class="m-0 text-base font-semibold">
              {{ 'editor.releases.changes.title' | transloco }}
            </h2>
            <of-release-changes
              [release]="r"
              [manuals]="manuals()"
              [page]="view.get('changesPage')()"
              [opened]="view.get('change')()"
              (pageChange)="view.set({ changesPage: $event })"
              (toggled)="toggleChange($event)"
            />
          </section>
        </div>
        <section class="flex min-w-0 flex-col gap-3" aria-labelledby="files">
          <div class="flex flex-wrap items-center gap-2">
            <h2
              id="files"
              tabindex="-1"
              class="m-0 me-auto scroll-mt-4 text-base font-semibold outline-none"
            >
              {{ 'editor.releases.files.title' | transloco }}
            </h2>
            @if (noFiles()) {
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                [zLoading]="planning()"
                [ofGuard]="{ permission: 'release.publish' }"
                (click)="replan()"
              >
                {{ 'editor.releases.files.plan' | transloco }}
              </button>
            }
            <of-release-archive-button
              [releaseId]="r.id"
              [name]="name()"
              [progress]="progress()"
            />
          </div>
          @if (r.attributes.withdrawal) {
            <p class="text-muted-foreground m-0 text-sm">
              {{ 'editor.releases.files.withdrawn' | transloco }}
            </p>
          }
          <of-release-files
            [release]="r"
            [manuals]="manuals()"
            [page]="view.get('filesPage')()"
            (pageChange)="view.set({ filesPage: $event })"
            [reloadKey]="filesReload()"
            [progress]="progress()"
            (retried)="watchProgress()"
          />
        </section>
      </div>

      <of-withdraw-release-dialog
        [(open)]="withdrawOpen"
        [name]="name()"
        [busy]="withdrawing()"
        [error]="withdrawError()"
        (withdraw)="withdraw($event)"
      />
    } @else if (failure(); as e) {
      <div class="border-border rounded-xl border p-6">
        @if (e.kind === 'unauthorized') {
          <of-no-access
            [heading]="'editor.releases.detail.noAccess' | transloco"
          />
        } @else {
          <of-error-state
            [kind]="e.kind"
            [heading]="
              (e.kind === 'not-found'
                ? 'editor.releases.detail.notFound'
                : 'editor.releases.detail.loadFailed'
              ) | transloco
            "
            [message]="errorText(e)"
            (retry)="reload()"
          />
        }
      </div>
    } @else {
      <div
        ofFadeIn="delayed"
        class="flex flex-col gap-3"
        role="status"
        aria-busy="true"
      >
        <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
        <z-skeleton class="h-8 w-72" aria-hidden="true" />
        <z-skeleton class="h-4 w-96 max-w-full" aria-hidden="true" />
        <div class="grid gap-6 xl:grid-cols-2" aria-hidden="true">
          <z-skeleton class="h-64 w-full" />
          <z-skeleton class="h-64 w-full" />
        </div>
      </div>
    }
  `,
})
export class ReleaseDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly me = inject(MeService);
  private readonly source = inject(ReleaseSource);
  private readonly actions = inject(ReleaseActions);
  private readonly toast = inject(ToastService);
  private readonly document = inject(DOCUMENT);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  protected readonly person = (who: { kind: string; id: string }) =>
    this.nameOf(who.kind, who.id);
  private readonly nameOf = injectPersonName();

  protected readonly view = injectQueryState({
    notes: idParam(LANG),
    changesPage: intParam(1),
    change: listParam(CHANGE_ID),
    filesPage: intParam(1),
  });

  private readonly releaseId = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('releaseId') ?? '')),
    { initialValue: '' },
  );

  protected readonly dateTime = DATE_TIME;
  protected readonly stateBadge = STATE_BADGE;
  protected readonly stateText = STATE_TEXT;
  protected readonly release = signal<ReleaseItem | null>(null);
  protected readonly failure = signal<ApiError | null>(null);
  protected readonly manuals = this.source.manualsAtTag;
  /** Where the files stand; undefined until read, null when they cannot be counted. */
  protected readonly progress = signal<OutputProgress | null | undefined>(
    undefined,
  );
  /** No files (or an incomplete planning), and none on their way: planning them again is offered. */
  protected readonly noFiles = computed(() => canPlanAgain(this.progress()));
  /** The files were seen under way on this page: their end is told in a toast. */
  private sawProgress = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  protected readonly planning = signal(false);
  protected readonly withdrawOpen = signal(false);
  protected readonly withdrawing = signal(false);
  protected readonly withdrawError = signal('');
  private readonly reloads = signal(0);
  private runs = 0;

  protected readonly state = computed(() => {
    const release = this.release();
    return release ? releaseStateOf(release) : 'published';
  });

  protected readonly name = computed(() => {
    const release = this.release();
    if (!release) return '';
    return this.t('editor.releases.name', {
      product: this.source.productLabel(release.attributes.product),
      version: release.attributes.revision,
    });
  });

  protected readonly commit = computed(() =>
    shortCommit(this.release()?.attributes.commit ?? ''),
  );

  /** The summary first, then each language's. */
  protected readonly noteOptions = computed((): SegmentedOption[] => {
    const release = this.release();
    if (!release) return [];
    return [
      { value: NOTES_SUMMARY, label: this.t('editor.releases.notes.summary') },
      ...Object.keys(release.attributes.notesByLanguage).map((lang) => ({
        value: lang,
        label: languageName(this.language.locale(), lang),
      })),
    ];
  });

  /**
   * The notes shown: the choice in the address, else the summary in the interface language when
   * the release has one, else the summary (#794).
   */
  protected readonly notesLang = computed(() =>
    notesShown(
      this.release()?.attributes.notesByLanguage ?? {},
      this.view.get('notes')(),
      this.language.locale(),
    ),
  );

  protected readonly notes = computed(() => {
    const release = this.release();
    if (!release) return null;
    const lang = this.notesLang();
    return lang === NOTES_SUMMARY
      ? release.attributes.notes
      : (release.attributes.notesByLanguage[lang] ?? null);
  });

  constructor() {
    effect(() => {
      const id = this.releaseId();
      this.me.me();
      this.reloads();
      untracked(() => {
        // Read anew for whoever acts now.
        this.source.forget();
        void this.source.readConfig();
        void this.load(id);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runs++;
      clearTimeout(this.pollTimer);
    });
    // The manuals at the release's tag, for titles and variant labels.
    effect(() => {
      const tag = this.release()?.attributes.tag;
      this.me.me();
      if (tag) untracked(() => void this.source.readManualsAt(tag));
    });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected errorText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  protected toggleChange(id: string): void {
    const opened = this.view.get('change')();
    this.view.set(
      {
        change: opened.includes(id)
          ? opened.filter((o) => o !== id)
          : [...opened, id],
      },
      { replace: true },
    );
  }

  protected openWithdraw(): void {
    this.withdrawError.set('');
    this.withdrawOpen.set(true);
  }

  protected async withdraw(reason: string): Promise<void> {
    const release = this.release();
    if (!release || this.withdrawing()) return;
    this.withdrawing.set(true);
    this.withdrawError.set('');
    try {
      this.release.set(
        await this.actions.withdraw(release, this.name(), reason),
      );
      this.withdrawOpen.set(false);
    } catch (text) {
      const message = text as TranslatedText;
      this.withdrawError.set(this.t(message.key, message.params));
    } finally {
      this.withdrawing.set(false);
    }
  }

  protected readonly filesReload = signal(0);

  protected async replan(): Promise<void> {
    const release = this.release();
    if (!release || this.planning()) return;
    this.planning.set(true);
    const planned = await this.actions.replan(release.id);
    this.planning.set(false);
    // The planned files are queued: read and poll them.
    if (planned) {
      this.filesReload.update((n) => n + 1);
      this.watchProgress(0);
    }
  }

  /** Reads where the files stand again soon, and on until they are no longer under way. */
  protected watchProgress(delay = POLL_MS): void {
    const id = this.release()?.id;
    if (!id) return;
    const run = this.runs;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(id, run), delay);
  }

  private async poll(id: string, run: number): Promise<void> {
    try {
      const release = await this.source.release(id);
      if (run !== this.runs) return;
      this.showProgress(release.meta.outputs);
    } catch {
      // Tried again later; what was shown stays.
      if (run !== this.runs) return;
    }
    if (inProgress(this.progress()) && this.progress() !== null) {
      this.watchProgress();
    }
  }

  private showProgress(next: OutputProgress | null): void {
    const before = this.progress();
    this.progress.set(next);
    if (inProgress(next)) {
      if (next) this.sawProgress = true;
      return;
    }
    if (!this.sawProgress || !next || !before || !inProgress(before)) return;
    this.sawProgress = false;
    if (next.refused) {
      // Too many files (#477): the files' panel says why; nothing more to tell.
    } else if (next.state === 'failed' && next.failed === 0) {
      // Its planning failed, after some batches or none (#477): the page says so and offers
      // planning again.
      this.toast.error(translated('editor.releases.progress.planFailed'));
    } else if (next.state === 'failed') {
      this.toast.error(
        translated('editor.releases.files.toast.failed', {
          failed: next.failed,
        }),
        {
          duration: 12_000,
          actionLabel: translated('editor.releases.files.toast.show'),
          onAction: () => this.showFiles(),
        },
      );
    } else if (next.state === 'done' && next.total > 0) {
      this.toast.success(
        translated('editor.releases.files.toast.ready', { total: next.total }),
      );
    }
  }

  /** Scrolls to the files and moves the focus there. */
  private showFiles(): void {
    const heading = this.document.getElementById('files');
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }

  private async load(id: string): Promise<void> {
    const run = ++this.runs;
    this.failure.set(null);
    if (!RELEASE_ID.test(id)) {
      this.release.set(null);
      this.failure.set(
        new ApiError('not-found', 404, 'not-found', 'No such release.'),
      );
      return;
    }
    clearTimeout(this.pollTimer);
    this.sawProgress = false;
    try {
      const release = await this.source.release(id);
      if (run !== this.runs) return;
      this.progress.set(undefined);
      this.release.set(release);
      this.showProgress(release.meta.outputs);
      if (inProgress(release.meta.outputs) && release.meta.outputs) {
        this.watchProgress();
      }
    } catch (error) {
      if (run !== this.runs) return;
      this.release.set(null);
      this.failure.set(toApiError(error));
    }
  }
}
