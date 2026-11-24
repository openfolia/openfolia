import {
  afterRenderEffect,
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
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { formatFileSize } from '@openfolia/content-model/core';
import { DatePipe, injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { MeterBarComponent } from '@openfolia/ui/meter-bar';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import {
  ErrorStateComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ZardTableImports } from '@openfolia/ui/table';

import { AboutService } from '../../about/about.service';
import { HelpService } from '../../help/help.service';
import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import { apiErrorText } from '../../i18n';
import { PermissionService } from '../../permissions/permission.service';
import { type BackupStatusMeta, statusSummary } from '../backups/backups-model';
import { injectQueryState, intParam } from '../../view-state';
import { SystemMailComponent } from './system-mail.component';
import {
  FILE_PAGE_SIZES,
  fileLabel,
  formatShare,
  formatWait,
  LEVEL_NOTICES,
  LEVEL_TONES,
  mediaLink,
  percentUsed,
  type StorageUsage,
  type StoredFileItem,
  UNUSED_FILES_LINK,
} from './storage-model';
import { SandboxSession } from '../../sandbox/sandbox-session';

type FilesDoc = Response<'/storage-usage/files'>;
type SecretKeyItem = Response<'/secret-key'>['data'];
type JobsStatusItem = Response<'/jobs/status'>['data'];
type OutboxStatusItem = Response<'/outbox/status'>['data'];

/** The outbox consumers' names (`GET /outbox/status`) as the Background work card names them. */
const HELD_CONSUMERS: Readonly<Record<string, string>> = {
  notifications: 'editor.admin.system.jobs.held.consumer.notifications',
  webhooks: 'editor.admin.system.jobs.held.consumer.webhooks',
  'change-feed': 'editor.admin.system.jobs.held.consumer.changeFeed',
};

/** Space kept below the list's frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * The System tab of Admin (#404): the instance (licence and source, as `GET /about` names them,
 * and where the secret key is, `GET /secret-key`, #470, never the key) and the storage it uses (`GET /storage-usage`): used against the limit, if one is set, with a
 * warning from 80 % of it; media and archived PDFs, which count, and the Git content and the
 * database for information; then the largest uploaded files, paged, each linking to the media
 * library. The page of that list and its size are in the address. The Background work card
 * (`GET /jobs/status`) also says when a restore onto another database server holds the outbox's
 * consumers (`GET /outbox/status`, #619), linking to the guide's page on finishing it.
 */
@Component({
  selector: 'of-system-page',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    ErrorStateComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    MeterBarComponent,
    SkeletonRowsComponent,
    ZardSkeletonComponent,
    ZardTableImports,
    SystemMailComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleCheck, lucideCircleX, lucideTriangleAlert }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start"
    >
      <section
        class="bg-card flex min-h-56 min-w-0 flex-col gap-4 rounded-xl border p-4"
        data-slot="storage-card"
        aria-labelledby="storage-heading"
        [attr.data-level]="usage()?.meta?.level ?? null"
      >
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="storage-heading" class="m-0 text-base font-semibold">
            {{ 'editor.admin.system.storage.title' | transloco }}
          </h2>
          @if (usage(); as u) {
            <span
              class="text-muted-foreground text-xs break-words"
              data-slot="storage-recounted"
            >
              @if (u.attributes.recountedAt) {
                {{
                  'editor.admin.system.storage.recountedAt'
                    | transloco
                      : {
                          at: u.attributes.recountedAt | ofDate: dateFormat,
                        }
                }}
              } @else {
                {{ 'editor.admin.system.storage.notRecounted' | transloco }}
              }
            </span>
          }
        </div>

        @if (usageError(); as e) {
          <of-error-state
            [kind]="e.kind"
            [heading]="'editor.admin.system.storage.loadFailed' | transloco"
            [message]="e.message"
            (retry)="reloadUsage()"
          />
        } @else if (usage(); as u) {
          <div class="flex min-w-0 flex-col gap-2" data-slot="storage-used">
            <p class="m-0 text-2xl font-semibold tabular-nums break-words">
              @if (u.attributes.limitBytes !== null) {
                {{
                  'editor.admin.system.storage.usedOf'
                    | transloco
                      : {
                          used: bytes(u.meta.usedBytes),
                          limit: bytes(u.attributes.limitBytes),
                        }
                }}
              } @else {
                {{
                  'editor.admin.system.storage.used'
                    | transloco: { used: bytes(u.meta.usedBytes) }
                }}
              }
            </p>
            @if (u.attributes.limitBytes !== null) {
              <of-meter-bar
                class="h-2"
                [value]="percent()"
                [tone]="tone()"
                [label]="'editor.admin.system.storage.meter' | transloco"
                [valueText]="shareText()"
              />
              <p class="text-muted-foreground m-0 text-xs tabular-nums">
                {{
                  'editor.admin.system.storage.share'
                    | transloco: { share: shareText() }
                }}
              </p>
            } @else {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.system.storage.noLimit' | transloco }}
              </p>
            }
          </div>

          @if (notice(); as n) {
            <div
              role="status"
              class="flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
              [class.border-warning]="u.meta.level === 'warning'"
              [class.bg-warning-muted]="u.meta.level === 'warning'"
              [class.border-destructive]="u.meta.level === 'reached'"
              [class.bg-destructive/10]="u.meta.level === 'reached'"
              data-slot="storage-notice"
            >
              <ng-icon
                name="lucideTriangleAlert"
                aria-hidden="true"
                class="mt-0.5 shrink-0"
                [class.text-warning]="u.meta.level === 'warning'"
                [class.text-destructive]="u.meta.level === 'reached'"
              />
              <div class="flex min-w-0 flex-col gap-1">
                <p class="m-0 font-medium break-words">
                  {{ n.title | transloco: { share: shareText() } }}
                </p>
                <p class="text-muted-foreground m-0 break-words">
                  {{ n.text | transloco }}
                </p>
                <a
                  class="text-foreground w-fit underline underline-offset-4 hover:no-underline focus-visible:no-underline"
                  data-slot="storage-unused-link"
                  [routerLink]="unusedLink.commands"
                  [queryParams]="unusedLink.queryParams"
                  >{{ 'editor.admin.system.storage.unusedLink' | transloco }}</a
                >
              </div>
            </div>
          }

          <dl
            class="m-0 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
            data-slot="storage-categories"
          >
            <div class="min-w-0 rounded-lg border p-3" data-category="media">
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.storage.media' | transloco }}
              </dt>
              <dd class="m-0 font-medium tabular-nums">
                {{ bytes(u.attributes.media.bytes) }}
              </dd>
              <dd class="text-muted-foreground m-0 text-xs tabular-nums">
                {{
                  'editor.admin.system.storage.files'
                    | transloco: { count: u.attributes.media.files }
                }}
              </dd>
            </div>
            <div class="min-w-0 rounded-lg border p-3" data-category="pdfs">
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.storage.pdfs' | transloco }}
              </dt>
              <dd class="m-0 font-medium tabular-nums">
                {{ bytes(u.attributes.archivedPdfs.bytes) }}
              </dd>
              <dd class="text-muted-foreground m-0 text-xs tabular-nums">
                {{
                  'editor.admin.system.storage.files'
                    | transloco: { count: u.attributes.archivedPdfs.files }
                }}
              </dd>
            </div>
            <div class="bg-muted/40 min-w-0 rounded-lg p-3" data-category="git">
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.storage.git' | transloco }}
              </dt>
              <dd class="m-0 tabular-nums">
                {{ optionalBytes(u.attributes.gitContent.bytes) }}
              </dd>
            </div>
            <div
              class="bg-muted/40 min-w-0 rounded-lg p-3"
              data-category="database"
            >
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.storage.database' | transloco }}
              </dt>
              <dd class="m-0 tabular-nums">
                {{ optionalBytes(u.attributes.database.bytes) }}
              </dd>
            </div>
          </dl>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.admin.system.storage.note' | transloco }}
          </p>
        } @else {
          <of-skeleton-rows
            [count]="4"
            [label]="'editor.admin.system.storage.loading' | transloco"
          />
        }
      </section>

      <section
        class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
        data-slot="instance-card"
        aria-labelledby="instance-heading"
      >
        <h2 id="instance-heading" class="m-0 text-base font-semibold">
          {{ 'editor.admin.system.instance.title' | transloco }}
        </h2>
        <dl class="m-0 flex min-h-16 min-w-0 flex-col gap-3 text-sm">
          @if (about.about(); as a) {
            <div class="min-w-0">
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.instance.licence' | transloco }}
              </dt>
              <dd class="m-0">
                <a
                  class="underline underline-offset-4 hover:no-underline focus-visible:no-underline"
                  [href]="a.licenseUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-slot="instance-licence"
                  >{{ a.license }}</a
                >
              </dd>
            </div>
            <div class="min-w-0">
              <dt class="text-muted-foreground text-xs">
                {{ 'editor.admin.system.instance.source' | transloco }}
              </dt>
              <dd class="m-0 [overflow-wrap:anywhere]">
                @if (a.sourceUrl) {
                  <a
                    class="underline underline-offset-4 hover:no-underline focus-visible:no-underline"
                    [href]="a.sourceUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-slot="instance-source"
                    >{{ a.sourceUrl }}</a
                  >
                } @else {
                  <span
                    class="text-muted-foreground"
                    data-slot="instance-source-missing"
                    >{{
                      'editor.admin.system.instance.sourceMissing' | transloco
                    }}</span
                  >
                }
              </dd>
            </div>
          }
          <div
            id="system-secret-key"
            tabindex="-1"
            class="min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-slot="instance-secret-key"
          >
            <dt class="text-muted-foreground text-xs">
              {{ 'editor.admin.system.instance.secretKey' | transloco }}
            </dt>
            @if (secretKey(); as k) {
              <dd
                class="m-0 flex min-w-0 flex-col gap-1"
                [attr.data-origin]="k.attributes.origin"
              >
                @switch (k.attributes.origin) {
                  @case ('file') {
                    <span>{{
                      'editor.admin.system.instance.secretKeyFile' | transloco
                    }}</span>
                    <code
                      class="bg-muted w-fit max-w-full rounded px-1 py-0.5 font-mono text-xs [overflow-wrap:anywhere]"
                      data-slot="secret-key-file"
                      >{{ k.attributes.file }}</code
                    >
                    <span
                      class="text-muted-foreground text-xs break-words"
                      data-slot="secret-key-backup"
                      >{{
                        'editor.admin.system.instance.secretKeyBackup'
                          | transloco
                      }}</span
                    >
                  }
                  @case ('environment') {
                    <span class="break-words">{{
                      'editor.admin.system.instance.secretKeyEnvironment'
                        | transloco: { variable: k.attributes.variable }
                    }}</span>
                    @if (k.attributes.variable === 'CCMS_WEBHOOKS_SECRET_KEY') {
                      <span
                        class="text-muted-foreground text-xs break-words"
                        data-slot="secret-key-old-name"
                        >{{
                          'editor.admin.system.instance.secretKeyOldName'
                            | transloco
                        }}</span
                      >
                    }
                  }
                  @default {
                    <span
                      class="flex min-w-0 items-start gap-2"
                      data-slot="secret-key-none"
                    >
                      <ng-icon
                        name="lucideTriangleAlert"
                        aria-hidden="true"
                        class="text-warning mt-0.5 shrink-0"
                      />
                      <span class="break-words">{{
                        'editor.admin.system.instance.secretKeyNone' | transloco
                      }}</span>
                    </span>
                  }
                }
              </dd>
            } @else if (secretKeyError(); as message) {
              <dd
                class="text-muted-foreground m-0 break-words"
                data-slot="secret-key-error"
              >
                {{ message }}
              </dd>
            } @else {
              <dd class="m-0">
                <z-skeleton class="h-4 w-40" />
              </dd>
            }
          </div>
        </dl>
        @if (showsBackups()) {
          <div
            class="flex min-w-0 flex-col gap-1 border-t pt-3"
            data-slot="system-backups"
            [attr.data-tone]="backupSummary()?.tone ?? null"
          >
            <h3 class="text-muted-foreground m-0 text-xs font-normal">
              {{ 'editor.admin.system.backups.title' | transloco }}
            </h3>
            @if (backupSummary(); as b) {
              <p class="m-0 flex min-w-0 items-start gap-2 text-sm">
                <ng-icon
                  aria-hidden="true"
                  class="mt-0.5 shrink-0"
                  [name]="
                    b.tone === 'ok'
                      ? 'lucideCircleCheck'
                      : b.tone === 'destructive'
                        ? 'lucideCircleX'
                        : 'lucideTriangleAlert'
                  "
                  [class.text-success]="b.tone === 'ok'"
                  [class.text-warning]="b.tone === 'warning'"
                  [class.text-destructive]="b.tone === 'destructive'"
                  [class.text-muted-foreground]="b.tone === 'muted'"
                />
                <span class="min-w-0 break-words">{{
                  b.title.key | transloco: b.title.params
                }}</span>
              </p>
              @if (b.detail; as d) {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ d.key | transloco: d.params }}
                </p>
              }
            } @else if (backupFailed()) {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.system.backups.loadFailed' | transloco }}
              </p>
            } @else {
              <z-skeleton class="h-4 w-48" />
            }
            <a
              class="w-fit text-sm underline underline-offset-4 hover:no-underline focus-visible:no-underline"
              routerLink="/admin/backups"
              data-slot="system-backups-link"
              >{{ 'editor.admin.system.backups.open' | transloco }}</a
            >
          </div>
        }
      </section>
    </div>

    <of-system-mail (secretKey)="showSecretKey()" />

    <section
      class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4"
      data-slot="jobs-card"
      aria-labelledby="jobs-heading"
      [attr.data-level]="jobs()?.meta?.level ?? null"
    >
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="jobs-heading" class="m-0 text-base font-semibold">
          {{ 'editor.admin.system.jobs.title' | transloco }}
        </h2>
        @if (jobs(); as j) {
          <span
            class="text-muted-foreground text-xs break-words"
            data-slot="jobs-last-consumed"
          >
            @if (j.attributes.lastConsumedAt) {
              {{
                'editor.admin.system.jobs.lastConsumed'
                  | transloco
                    : {
                        at: j.attributes.lastConsumedAt | ofDate: dateFormat,
                      }
              }}
            } @else {
              {{ 'editor.admin.system.jobs.neverConsumed' | transloco }}
            }
          </span>
        }
      </div>
      @if (jobsError(); as e) {
        <of-error-state
          [kind]="e.kind"
          [heading]="'editor.admin.system.jobs.loadFailed' | transloco"
          [message]="e.message"
          (retry)="reloadJobs()"
        />
      } @else if (jobs(); as j) {
        @if (heldText(); as held) {
          <div
            role="alert"
            class="border-destructive bg-destructive-muted flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
            data-slot="outbox-held"
          >
            <ng-icon
              name="lucideCircleX"
              aria-hidden="true"
              class="text-destructive mt-0.5 shrink-0"
            />
            <div class="flex min-w-0 flex-col gap-1">
              <p class="m-0 font-medium break-words">
                {{ 'editor.admin.system.jobs.held.title' | transloco }}
              </p>
              <p class="text-muted-foreground m-0 break-words">
                {{
                  'editor.admin.system.jobs.held.text'
                    | transloco: { consumers: held }
                }}
              </p>
              @if (restoreGuide(); as guide) {
                <a
                  class="hover:text-foreground focus-visible:ring-ring w-fit rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2"
                  [href]="guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-slot="outbox-held-link"
                  >{{ 'editor.admin.system.jobs.held.link' | transloco }}</a
                >
              }
            </div>
          </div>
        }
        @if (j.meta.level === 'warning') {
          <div
            role="status"
            class="border-warning bg-warning-muted flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
            data-slot="jobs-warning"
          >
            <ng-icon
              name="lucideTriangleAlert"
              aria-hidden="true"
              class="text-warning mt-0.5 shrink-0"
            />
            <div class="flex min-w-0 flex-col gap-1">
              <p class="m-0 font-medium break-words">
                {{ 'editor.admin.system.jobs.warning.title' | transloco }}
              </p>
              <p class="text-muted-foreground m-0 break-words">
                {{ 'editor.admin.system.jobs.warning.text' | transloco }}
              </p>
            </div>
          </div>
        } @else if (j.attributes.consumers === 0) {
          <p
            class="text-muted-foreground m-0 text-sm break-words"
            data-slot="jobs-no-consumers"
          >
            {{ 'editor.admin.system.jobs.noConsumers' | transloco }}
          </p>
        }
        <dl
          class="m-0 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4"
          [attr.aria-label]="'editor.admin.system.jobs.label' | transloco"
        >
          <div class="min-w-0 rounded-lg border p-3" data-stat="consumers">
            <dt class="text-muted-foreground text-xs">
              {{ 'editor.admin.system.jobs.consumers' | transloco }}
            </dt>
            <dd class="m-0 font-medium tabular-nums break-words">
              {{
                'editor.admin.system.jobs.consumersValue'
                  | transloco: { count: j.attributes.consumers }
              }}
            </dd>
          </div>
          <div class="min-w-0 rounded-lg border p-3" data-stat="ready">
            <dt class="text-muted-foreground text-xs">
              {{ 'editor.admin.system.jobs.ready' | transloco }}
            </dt>
            <dd class="m-0 font-medium tabular-nums">
              {{ count(j.attributes.ready) }}
            </dd>
          </div>
          <div class="min-w-0 rounded-lg border p-3" data-stat="running">
            <dt class="text-muted-foreground text-xs">
              {{ 'editor.admin.system.jobs.running' | transloco }}
            </dt>
            <dd class="m-0 font-medium tabular-nums">
              {{ count(j.attributes.running) }}
            </dd>
          </div>
          <div class="min-w-0 rounded-lg border p-3" data-stat="lag">
            <dt class="text-muted-foreground text-xs">
              {{ 'editor.admin.system.jobs.lag' | transloco }}
            </dt>
            <dd class="m-0 font-medium tabular-nums break-words">
              @if (j.attributes.ready > 0) {
                {{ duration(j.meta.lagSeconds) }}
              } @else {
                {{ 'editor.admin.system.jobs.lagNone' | transloco }}
              }
            </dd>
          </div>
        </dl>
      } @else {
        <of-skeleton-rows
          [count]="2"
          [label]="'editor.admin.system.jobs.loading' | transloco"
        />
      }
    </section>

    <section
      class="flex min-w-0 flex-col gap-2"
      aria-labelledby="largest-heading"
    >
      <h2 id="largest-heading" class="m-0 text-base font-semibold">
        {{ 'editor.admin.system.files.title' | transloco }}
      </h2>
      <of-list-frame
        #frame
        class="min-h-64 min-w-0"
        [label]="'editor.admin.system.files.label' | transloco"
        [items]="files()?.data ?? []"
        [page]="files()?.meta?.page ?? null"
        [loading]="filesLoading()"
        [error]="filesError()"
        [offset]="offset()"
        [pageSizes]="pageSizes"
        [emptyTitle]="'editor.admin.system.files.emptyTitle' | transloco"
        [emptyDescription]="
          'editor.admin.system.files.emptyDescription' | transloco
        "
        (pageChange)="view.set({ page: $event })"
        (pageSizeChange)="view.set({ size: $event, page: 1 })"
        (retry)="reloadFiles()"
      >
        <ng-template ofListTable let-items>
          <table z-table class="min-w-[36rem] table-fixed">
            <thead z-table-header class="bg-background sticky top-0 z-10">
              <tr z-table-row>
                <th z-table-head>
                  {{ 'editor.admin.system.files.name' | transloco }}
                </th>
                <th z-table-head class="w-40">
                  {{ 'editor.admin.system.files.type' | transloco }}
                </th>
                <th z-table-head class="w-28 text-end">
                  {{ 'editor.admin.system.files.size' | transloco }}
                </th>
                <th z-table-head class="w-44">
                  {{ 'editor.admin.system.files.lastUploaded' | transloco }}
                </th>
              </tr>
            </thead>
            <tbody z-table-body>
              @for (file of asFiles(items); track file.id) {
                @let link = linkOf(file);
                <tr
                  z-table-row
                  [ofListItem]="file"
                  data-slot="stored-file"
                  [attr.data-file]="file.id"
                >
                  <td z-table-cell class="whitespace-normal">
                    <a
                      class="text-foreground block font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:underline"
                      data-slot="stored-file-link"
                      [routerLink]="link.commands"
                      [queryParams]="link.queryParams"
                      >{{ label(file) }}</a
                    >
                  </td>
                  <td
                    z-table-cell
                    class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere] whitespace-normal"
                  >
                    {{ file.attributes.contentType }}
                  </td>
                  <td z-table-cell class="text-end tabular-nums">
                    {{ bytes(file.attributes.size) }}
                  </td>
                  <td
                    z-table-cell
                    class="text-muted-foreground whitespace-normal tabular-nums"
                  >
                    <time [attr.datetime]="file.attributes.lastUploadedAt">{{
                      file.attributes.lastUploadedAt | ofDate: dateFormat
                    }}</time>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </ng-template>
      </of-list-frame>
    </section>
  `,
})
export class SystemPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  protected readonly about = inject(AboutService);
  private readonly help = inject(HelpService);
  private readonly permissions = inject(PermissionService);

  /**
   * The backup status (#529), for those holding `admin.backups` only, as its route needs; never
   * in a public sandbox (#826), which keeps nothing to back up.
   */
  protected readonly showsBackups = computed(
    () =>
      !this.sandbox.on() &&
      this.permissions.state({ permission: 'admin.backups' }).kind !== 'hidden',
  );
  private readonly backupStatus = signal<BackupStatusMeta | null>(null);
  protected readonly backupFailed = signal(false);
  protected readonly backupSummary = computed(() => {
    const status = this.backupStatus();
    return status
      ? statusSummary(status, new Date(), this.language.locale())
      : null;
  });

  protected readonly view = injectQueryState({
    page: intParam(1),
    size: intParam(FILE_PAGE_SIZES[0], { only: FILE_PAGE_SIZES }),
  });
  protected readonly pageSizes = FILE_PAGE_SIZES;
  protected readonly unusedLink = UNUSED_FILES_LINK;
  protected readonly dateFormat: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };

  protected readonly usage = signal<StorageUsage | null>(null);
  protected readonly secretKey = signal<SecretKeyItem | null>(null);
  protected readonly jobs = signal<JobsStatusItem | null>(null);
  /** Which outbox consumers a restore holds (#619); null until read, or when it could not be. */
  protected readonly outbox = signal<OutboxStatusItem | null>(null);
  private readonly jobsFailure = signal<ApiError | null>(null);
  private readonly secretKeyFailure = signal<ApiError | null>(null);
  private readonly usageFailure = signal<ApiError | null>(null);
  protected readonly files = signal<FilesDoc | null>(null);
  protected readonly filesLoading = signal(false);
  private readonly filesFailure = signal<ApiError | null>(null);
  private readonly fileReloads = signal(0);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly percent = computed(() => {
    const u = this.usage();
    return u ? percentUsed(u) : 0;
  });

  protected readonly tone = computed(
    () => LEVEL_TONES[this.usage()?.meta.level ?? 'ok'],
  );

  protected readonly notice = computed(() => {
    const level = this.usage()?.meta.level;
    return level ? (LEVEL_NOTICES[level] ?? null) : null;
  });

  protected readonly shareText = computed(() =>
    formatShare(this.usage()?.meta.usedShare ?? 0, this.language.locale()),
  );

  protected readonly usageError = computed(() =>
    this.errorOf(this.usageFailure()),
  );
  protected readonly filesError = computed(() =>
    this.errorOf(this.filesFailure()),
  );
  /** The held consumers as one list in the interface's language; null when none is held. */
  protected readonly heldText = computed(() => {
    const held = this.outbox()?.attributes.blockedConsumers ?? [];
    if (held.length === 0) return null;
    const names = held.map((name) => {
      const key = HELD_CONSUMERS[name];
      return key ? this.t(key) : name;
    });
    return new Intl.ListFormat(this.language.locale(), {
      type: 'conjunction',
    }).format(names);
  });
  /** The guide's page on finishing a restore; null when the operator turned the links off. */
  protected readonly restoreGuide = computed(() =>
    this.help.href('guide.self-hosting.after-a-restore'),
  );

  protected readonly jobsError = computed(() =>
    this.errorOf(this.jobsFailure()),
  );
  protected readonly secretKeyError = computed(
    () => this.errorOf(this.secretKeyFailure())?.message ?? null,
  );

  constructor() {
    this.help.load();
    void this.loadUsage();
    void this.loadSecretKey();
    void this.loadJobs();
    effect(() => {
      if (this.showsBackups()) untracked(() => void this.loadBackupStatus());
    });
    effect(() => {
      const page = {
        number: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.fileReloads();
      untracked(() => void this.loadFiles(page));
    });

    const destroyRef = inject(DestroyRef);
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.usage();
      this.jobs();
      this.files();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected bytes(value: number): string {
    return formatFileSize(value, this.language.locale());
  }

  protected optionalBytes(value: number | null): string {
    return value === null
      ? this.t('editor.admin.system.storage.unknown')
      : this.bytes(value);
  }

  protected asFiles(items: readonly unknown[]): readonly StoredFileItem[] {
    return items as readonly StoredFileItem[];
  }

  protected label(file: StoredFileItem): string {
    return fileLabel(file);
  }

  protected linkOf(file: StoredFileItem) {
    return mediaLink(file);
  }

  protected reloadUsage(): void {
    void this.loadUsage();
    if (this.secretKeyFailure()) void this.loadSecretKey();
  }

  protected reloadJobs(): void {
    void this.loadJobs();
  }

  protected count(value: number): string {
    return new Intl.NumberFormat(this.language.locale()).format(value);
  }

  /** A wait in the largest whole unit that fits (seconds, minutes, hours, days), in the interface's language. */
  protected duration(seconds: number): string {
    return formatWait(seconds, this.language.locale());
  }

  /** Brings the secret key's entry into view and focus (from the Email section, #609). */
  protected showSecretKey(): void {
    const entry = document.getElementById('system-secret-key');
    if (!entry) return;
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    entry.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'center',
    });
    entry.focus({ preventScroll: true });
  }

  protected reloadFiles(): void {
    this.fileReloads.update((n) => n + 1);
  }

  private errorOf(failure: ApiError | null) {
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  }

  private async loadUsage(): Promise<void> {
    this.usageFailure.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/storage-usage'));
      this.usage.set(doc.data);
    } catch (error) {
      this.usageFailure.set(toApiError(error));
    }
  }

  private async loadJobs(): Promise<void> {
    this.jobsFailure.set(null);
    const outbox = this.loadOutbox();
    try {
      const doc = await firstValueFrom(this.api.get('/jobs/status'));
      this.jobs.set(doc.data);
    } catch (error) {
      this.jobsFailure.set(toApiError(error));
    }
    await outbox;
  }

  /** Read beside the jobs; a failure shows nothing (the jobs' own state says whether the server answers). */
  private async loadOutbox(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/outbox/status'));
      this.outbox.set(doc.data);
    } catch {
      this.outbox.set(null);
    }
  }

  private async loadSecretKey(): Promise<void> {
    this.secretKeyFailure.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/secret-key'));
      this.secretKey.set(doc.data);
    } catch (error) {
      this.secretKeyFailure.set(toApiError(error));
    }
  }

  private async loadBackupStatus(): Promise<void> {
    this.backupFailed.set(false);
    try {
      const doc = await firstValueFrom(this.api.get('/backup-status'));
      this.backupStatus.set(doc.data.meta);
    } catch {
      this.backupFailed.set(true);
    }
  }

  private async loadFiles(page: {
    number: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.filesLoading.set(true);
    this.filesFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/storage-usage/files', { query: pageQuery(page) }),
      );
      if (run !== this.runs) return;
      this.files.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.filesFailure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.filesLoading.set(false);
    }
  }
}
