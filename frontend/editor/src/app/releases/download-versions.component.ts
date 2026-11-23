import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
  lucideCircleSlash,
  lucideDownload,
  lucideHistory,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { DatePipe, injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import {
  type DownloadItem,
  type DownloadVersionDoc,
  type DownloadVersionItem,
  shortHash,
  VERSION_PAGE_SIZE,
  VERSION_STATE_BADGE,
  VERSION_STATE_TEXT,
} from './downloads-model';
import { frameOffset } from './frame-offset';
import { ReleaseActions } from './release-actions';

/** Space kept below the versions: the panel's padding and the page's. */
const BELOW_FRAME_PX = 48;

/**
 * The download chosen in the download centre (#139), in the panel beside the list: its name and
 * file, and its versions across the product's releases, newest first (one where the file
 * changed), each with its state (current, superseded, withdrawn), the release it came with and
 * when, its checksum and size, the release's notes and the file's description, and a button that
 * saves that version. The versions are paged; they scroll inside the panel.
 */
@Component({
  selector: 'of-download-versions',
  imports: [
    TranslocoPipe,
    NgIcon,
    DatePipe,
    ZardBadgeComponent,
    ZardButtonComponent,
    ListFrameComponent,
    ListRowDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleSlash,
      lucideDownload,
      lucideHistory,
      lucideX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @let d = download();
    <div class="flex items-start gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 class="m-0 text-sm font-semibold break-words">
          {{ d.attributes.name }}
        </h2>
        <p
          class="text-muted-foreground m-0 text-xs [overflow-wrap:anywhere]"
          data-slot="file-name"
        >
          {{ d.attributes.fileName }}
        </p>
      </div>
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        type="button"
        class="-me-1 -mt-1"
        [attr.aria-label]="'editor.releases.downloads.panel.close' | transloco"
        (click)="closed.emit()"
      >
        <ng-icon name="lucideX" aria-hidden="true" />
      </button>
    </div>

    @if (d.attributes.description; as description) {
      <p class="m-0 text-sm break-words whitespace-pre-line">
        {{ description }}
      </p>
    }

    <h3
      class="text-muted-foreground m-0 flex items-center gap-1.5 text-xs font-normal"
    >
      <ng-icon name="lucideHistory" aria-hidden="true" />
      {{ 'editor.releases.downloads.panel.versions' | transloco }}
    </h3>
    @if (doc()?.meta?.truncated) {
      <p class="text-muted-foreground m-0 text-xs break-words" role="note">
        {{ 'editor.releases.downloads.panel.truncated' | transloco }}
      </p>
    }

    <of-list-frame
      #frame
      class="min-h-48 min-w-0"
      data-slot="download-versions"
      [label]="'editor.releases.downloads.panel.versions' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [skeletonRows]="3"
      [emptyTitle]="'editor.releases.downloads.panel.emptyTitle' | transloco"
      [emptyDescription]="
        'editor.releases.downloads.panel.emptyDescription' | transloco
      "
      (pageChange)="page.set($event)"
      (retry)="reload()"
    >
      <ng-template ofListRow let-item>
        @let v = asVersion(item);
        @let a = v.attributes;
        <div
          class="flex flex-col gap-1.5 px-3 py-2.5"
          data-slot="download-version"
          [attr.data-state]="a.state"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="me-auto min-w-0 text-sm font-medium break-words">{{
              'editor.releases.downloads.panel.release'
                | transloco: { version: a.release.revision }
            }}</span>
            <z-badge [zType]="stateBadge[a.state]" class="gap-1">
              <ng-icon
                [name]="
                  a.state === 'withdrawn'
                    ? 'lucideCircleSlash'
                    : 'lucideCircleCheck'
                "
                aria-hidden="true"
              />
              {{ stateText[a.state] | transloco }}
            </z-badge>
          </div>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ a.release.publishedAt | ofDate }} · {{ size(a.size) }}
          </p>
          <p
            class="text-muted-foreground m-0 font-mono text-xs [overflow-wrap:anywhere]"
            data-slot="checksum"
            [attr.title]="a.sha256"
          >
            {{
              'editor.releases.downloads.panel.checksum'
                | transloco: { hash: short(a.sha256) }
            }}
          </p>
          @if (a.changeNote.notes; as notes) {
            <p
              class="m-0 text-sm break-words whitespace-pre-line"
              data-slot="notes"
            >
              {{ notes }}
            </p>
          }
          @if (
            a.changeNote.description &&
            a.changeNote.description !== d.attributes.description
          ) {
            <p
              class="text-muted-foreground m-0 text-xs break-words whitespace-pre-line"
              data-slot="description"
            >
              {{ a.changeNote.description }}
            </p>
          }
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            class="self-start"
            data-slot="download-version-file"
            [attr.aria-label]="
              'editor.releases.downloads.saveVersion'
                | transloco
                  : { name: d.attributes.name, version: a.release.revision }
            "
            (click)="save(v)"
          >
            <ng-icon
              name="lucideDownload"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.downloads.save' | transloco }}
          </button>
        </div>
      </ng-template>
    </of-list-frame>
  `,
})
export class DownloadVersionsComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly actions = inject(ReleaseActions);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  readonly download = input.required<DownloadItem>();
  readonly closed = output<void>();

  protected readonly stateText = VERSION_STATE_TEXT;
  protected readonly stateBadge = VERSION_STATE_BADGE;
  protected readonly short = shortHash;
  protected readonly page = signal(1);
  protected readonly doc = signal<DownloadVersionDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.doc(),
  );
  private runs = 0;
  private shownId: string | null = null;

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    effect(() => {
      const id = this.download().id;
      const page = this.page();
      this.me.me();
      this.reloads();
      untracked(() => {
        // Another download: its versions from their first page, the last one's not shown.
        if (id !== this.shownId) {
          this.shownId = id;
          this.doc.set(null);
          if (page !== 1) {
            // A read for the download before never lands.
            this.runs++;
            this.page.set(1);
            return;
          }
        }
        void this.load(id, page);
      });
    });
  }

  protected asVersion(item: unknown): DownloadVersionItem {
    return item as DownloadVersionItem;
  }

  protected size(bytes: number): string {
    return formatFileSize(bytes, this.language.locale());
  }

  protected save(version: DownloadVersionItem): void {
    const d = this.download();
    void this.actions.saveDownload(
      d.id,
      version.id,
      this.t('editor.releases.downloads.versionName', {
        name: d.attributes.name,
        version: version.attributes.release.revision,
      }),
    );
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  private async load(id: string, page: number): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/downloads/{id}/versions', {
          path: { id },
          query: pageQuery({ number: page, size: VERSION_PAGE_SIZE }),
        }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        this.page.set(last);
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
