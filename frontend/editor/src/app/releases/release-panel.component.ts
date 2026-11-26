import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideCircleCheck,
  lucideCircleSlash,
  lucideDownload,
  lucideHistory,
  lucideStar,
  lucideWebhook,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { DatePipe, injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { RefreshingDirective } from '@openfolia/ui/smooth';

import { ApiClient, pageQuery } from '../api';
import { languageName } from '../content/browser-model';
import { injectPersonName, injectPersonText } from '../history/history-model';
import { GuardDirective } from '../permissions/guard.directive';
import { UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { MaintenanceLines } from '../session/maintenance-lines';
import { MaintenanceActions } from './maintenance-actions';
import { ReleaseActions } from './release-actions';
import { ReleaseSource } from './release-source';
import {
  outputNames,
  type OutputTexts,
  progressKey,
  progressParams,
  releaseStateOf,
  STATE_BADGE,
  STATE_TEXT,
  type OutputProgress,
  type ReleaseItem,
  type ReleaseOutput,
} from './releases-model';

/** Files listed in the panel; the rest are on the release's page. */
const PANEL_FILES = 4;

/**
 * The release chosen in the list (screen 16's side panel): its name and state, who cut it and
 * when, the first files ready to download (named by the manual's title and the variant's label at
 * the release's tag, read through the page's `ReleaseSource`, as on the release's page) and how
 * far the rest are, its withdrawal (with the
 * reason) once withdrawn, a link to its page, the webhook deliveries (`webhook.manage`) and
 * "Withdraw release" (`release.publish`), which the page confirms with the reason.
 */
@Component({
  selector: 'of-release-panel',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    RefreshingDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    GuardDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowRight,
      lucideCircleCheck,
      lucideCircleSlash,
      lucideDownload,
      lucideHistory,
      lucideStar,
      lucideWebhook,
      lucideX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @let r = release();
    <div class="flex items-start gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 class="m-0 text-sm font-semibold break-words">{{ name() }}</h2>
        <p class="text-muted-foreground m-0 text-xs break-words">
          {{
            'editor.releases.panel.publishedBy'
              | transloco
                : {
                    name: person(r.attributes.publishedBy),
                    date: (r.attributes.publishedAt | ofDate),
                  }
          }}
        </p>
      </div>
      <span class="flex shrink-0 flex-col items-end gap-1">
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
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        type="button"
        class="-me-1 -mt-1"
        [attr.aria-label]="'editor.releases.panel.close' | transloco"
        (click)="closed.emit()"
      >
        <ng-icon name="lucideX" aria-hidden="true" />
      </button>
    </div>

    @if (r.attributes.withdrawal; as w) {
      <div
        role="note"
        class="bg-muted flex flex-col gap-1 rounded-md p-3 text-sm"
        data-slot="withdrawal"
      >
        <span class="font-medium">{{
          'editor.releases.panel.withdrawn'
            | transloco: { name: person(w.by), date: (w.at | ofDate) }
        }}</span>
        <span class="break-words whitespace-pre-line">{{ w.reason }}</span>
      </div>
    }

    <div class="flex flex-col gap-1.5">
      <h3 class="text-muted-foreground m-0 text-xs font-normal">
        {{ 'editor.releases.panel.files' | transloco }}
      </h3>
      <p class="m-0 text-sm break-words" data-slot="progress">
        {{ progressText() }}
      </p>
      @if (files(); as list) {
        <ul
          class="m-0 flex list-none flex-col gap-1.5 p-0"
          [ofRefreshing]="loading()"
        >
          @for (f of list; track f.id) {
            <li>
              <button
                type="button"
                class="bg-muted hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm outline-none focus-visible:ring-[3px]"
                [attr.aria-label]="
                  'editor.releases.files.downloadLabel'
                    | transloco: { name: fileName(f) }
                "
                (click)="download(f)"
              >
                <ng-icon
                  name="lucideDownload"
                  class="text-muted-foreground shrink-0"
                  aria-hidden="true"
                />
                <span class="min-w-0 break-words">{{ fileName(f) }}</span>
              </button>
            </li>
          }
        </ul>
      } @else if (loading()) {
        <div class="flex flex-col gap-1.5" aria-hidden="true">
          <z-skeleton class="h-9 w-full" />
          <z-skeleton class="h-9 w-full" />
        </div>
      }
      <a
        z-button
        zType="outline"
        class="mt-1 justify-between"
        data-slot="open-release"
        [routerLink]="['/releases', r.id]"
      >
        {{ 'editor.releases.panel.open' | transloco }}
        <ng-icon
          name="lucideArrowRight"
          data-icon="inline-end"
          aria-hidden="true"
        />
      </a>
    </div>

    <a
      z-button
      zType="ghost"
      class="justify-start"
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

    @if (canReadLines()) {
      <!-- Fixing this product version apart from the current content. -->
      <div class="flex flex-col gap-1.5" data-slot="maintenance">
        <h3 class="text-muted-foreground m-0 text-xs font-normal">
          {{ 'editor.releases.maintenance.title' | transloco }}
        </h3>
        @if (!linesKnown()) {
          <z-skeleton class="h-9 w-full" aria-hidden="true" />
        } @else if (line(); as l) {
          <p class="m-0 text-sm break-words" data-slot="maintenance-state">
            {{
              (l.attributes.state === 'open'
                ? 'editor.releases.maintenance.panelOpen'
                : 'editor.releases.maintenance.panelClosed'
              ) | transloco: { date: (l.attributes.createdAt | ofDate) }
            }}
          </p>
          <button
            z-button
            zType="ghost"
            type="button"
            class="justify-start"
            data-slot="show-maintenance"
            (click)="showMaintenance.emit()"
          >
            <ng-icon
              name="lucideArrowRight"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.maintenance.showLines' | transloco }}
          </button>
        } @else if (state() === 'published') {
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.releases.maintenance.startHint' | transloco }}
          </p>
          <button
            z-button
            zType="outline"
            type="button"
            class="w-full"
            data-slot="start-maintenance"
            [ofGuard]="{
              permission: 'release.publish',
              blockedReason: starting()
                ? 'editor.releases.maintenance.startingReason'
                : null,
            }"
            [attr.aria-busy]="starting() ? 'true' : null"
            (click)="startMaintenance.emit()"
          >
            <ng-icon
              name="lucideHistory"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.maintenance.start' | transloco }}
          </button>
        }
      </div>
    }

    @if (state() === 'published') {
      <button
        z-button
        zType="outline"
        type="button"
        class="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive w-full"
        data-slot="withdraw"
        [ofGuard]="{ permission: 'release.publish' }"
        (click)="withdraw.emit()"
      >
        {{ 'editor.releases.withdraw.action' | transloco }}
      </button>
    }
  `,
})
export class ReleasePanelComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly actions = inject(ReleaseActions);
  private readonly source = inject(ReleaseSource);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  /** Titles and variants in the interface language (#731), variants by the labels at `main`. */
  private readonly t = injectTranslate();
  private readonly shownTexts: OutputTexts = {
    title: (t) => this.texts.text(t),
    variant: (values, fallback) =>
      this.texts.variant(values, this.source.config(), fallback),
    offlinePackage: () => this.t('editor.releases.files.offlinePackage'),
    audience: (id) =>
      this.source.config()?.audiences.find((a) => a.id === id)?.label,
  };
  private readonly nameOf = injectPersonName();
  private readonly personText = injectPersonText();

  readonly release = input.required<ReleaseItem>();
  /** The release as people read it ("North 2.1"). */
  readonly name = input('');
  readonly progress = input<OutputProgress | undefined>(undefined);
  readonly closed = output<void>();
  readonly withdraw = output<void>();
  /** "Start maintenance": a line to fix this product version on (#250). */
  readonly startMaintenance = output<void>();
  /** The Maintenance tab, where its line is. */
  readonly showMaintenance = output<void>();

  protected readonly lines = inject(MaintenanceLines);
  private readonly maintenance = inject(MaintenanceActions);
  private readonly permissions = inject(PermissionService);
  /** Lines need `content.read.draft`. */
  protected readonly canReadLines = computed(
    () =>
      this.permissions.state({ permission: 'content.read.draft' }).kind ===
      'enabled',
  );
  /** The lines were read (asked for here: the skeleton reads nothing else that would ask). */
  protected readonly linesKnown = computed(() => {
    this.lines.ensure();
    return this.lines.known();
  });
  /** The line started at this release, if any (one per release). */
  protected readonly line = computed(() => {
    this.lines.ensure();
    const id = this.release().id;
    return (
      this.lines
        .all()
        .find((l) => l.relationships.baseRelease.data.id === id) ?? null
    );
  });
  protected readonly starting = computed(() =>
    this.maintenance.startingFrom(this.release().id),
  );

  protected readonly stateBadge = STATE_BADGE;
  protected readonly stateText = STATE_TEXT;
  protected readonly files = signal<readonly ReleaseOutput[] | null>(null);
  protected readonly loading = signal(false);
  private runs = 0;
  private shownFor: string | null = null;

  private readonly manualsById = computed(
    () => new Map(this.source.manualsAtTag().map((m) => [m.id, m])),
  );

  protected readonly state = computed(() => releaseStateOf(this.release()));

  protected readonly progressText = computed(() => {
    const progress = this.progress();
    if (!progress) return this.t('editor.releases.progress.counting');
    return this.t(progressKey(progress), progressParams(progress));
  });

  protected readonly person = (who: { kind: string; id: string }) =>
    this.personText(who, this.nameOf(who.kind, who.id));

  constructor() {
    effect(() => {
      const id = this.release().id;
      // Read again as files get done.
      void this.progress()?.done;
      this.me.me();
      untracked(() => void this.load(id));
    });
    // The manuals at the release's tag, for the files' titles and variant labels.
    effect(() => {
      const tag = this.release().attributes.tag;
      this.me.me();
      untracked(() => void this.source.readManualsAt(tag));
    });
  }

  protected fileName(f: ReleaseOutput): string {
    const names = outputNames(this.manualsById(), f, this.shownTexts);
    const language = languageName(this.language.locale(), f.attributes.lang);
    // An offline package with no audience levels configured: "Offline package · English".
    if (names.variant === '') {
      return this.t('editor.releases.files.name', {
        variant: names.manual,
        language,
      });
    }
    return this.t('editor.releases.panel.file', {
      manual: names.manual,
      variant: names.variant,
      language,
    });
  }

  protected download(f: ReleaseOutput): void {
    void this.actions.download(this.release().id, f.id, this.fileName(f));
  }

  private async load(releaseId: string): Promise<void> {
    const run = ++this.runs;
    // Another release: its own files, not the last one's, dimmed.
    if (this.shownFor !== releaseId) this.files.set(null);
    this.shownFor = releaseId;
    this.loading.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.get('/releases/{releaseId}/outputs', {
          path: { releaseId },
          query: {
            'filter[state]': 'done',
            ...pageQuery({ number: 1, size: PANEL_FILES }),
          },
        }),
      );
      if (run !== this.runs) return;
      this.files.set(doc.data);
    } catch {
      // The progress line and the release's page still say how the files are.
      if (run === this.runs) this.files.set([]);
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
