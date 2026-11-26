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
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleDot, lucideCircleSlash } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  DatePipe,
  injectTranslate,
  RelativeTimePipe,
} from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardTableImports } from '@openfolia/ui/table';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { injectPersonName } from '../history/history-model';
import { PersonNameComponent } from '../session/person-name.component';
import { apiErrorText } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import type { MaintenanceLine } from '../session/maintenance-lines';
import { frameOffset } from './frame-offset';
import { MaintenanceActions } from './maintenance-actions';
import { ReleaseSource } from './release-source';
import { RELEASE_PAGE_SIZES } from './releases-model';

interface LineDoc {
  readonly data: readonly MaintenanceLine[];
  readonly meta: {
    readonly page: {
      readonly currentPage: number;
      readonly lastPage: number;
      readonly perPage: number;
      readonly total: number;
    };
  };
}

/** Space kept below the frame: the page's bottom padding. */
const BELOW_FRAME_PX = 32;

/**
 * The Releases page's Maintenance tab (#250): the maintenance lines, newest first, paged on the
 * server (`GET /maintenance-lines`): product, product version, the release it started at (a link
 * to its page), open or closed (a badge with an icon and a word), and who started it when.
 * "Close" (`release.publish`) asks first (closing is final: no new revision starts on the line;
 * those on it may still be merged and releases still cut), shows the line closed at once and puts
 * it back if the API refuses. A line is never named by its branch.
 */
@Component({
  selector: 'of-maintenance-tab',
  imports: [
    PersonNameComponent,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    RelativeTimePipe,
    RouterLink,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardTableImports,
    GuardDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCircleDot, lucideCircleSlash })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      data-testid="maintenance-lines"
      [label]="'editor.releases.maintenance.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="'editor.releases.maintenance.empty.title' | transloco"
      [emptyDescription]="
        'editor.releases.maintenance.empty.description' | transloco
      "
      (pageChange)="pageChange.emit($event)"
      (pageSizeChange)="sizeChange.emit($event)"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <table z-table class="min-w-[44rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[22%]">
                {{ 'editor.releases.table.product' | transloco }}
              </th>
              <th z-table-head class="w-[15%]">
                {{ 'editor.releases.table.version' | transloco }}
              </th>
              <th z-table-head class="w-[20%]">
                {{ 'editor.releases.maintenance.table.base' | transloco }}
              </th>
              <th z-table-head class="w-28">
                {{ 'editor.releases.table.state' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.releases.maintenance.table.started' | transloco }}
              </th>
              <th z-table-head class="w-28">
                <span class="sr-only">{{
                  'editor.releases.maintenance.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (l of asLines(items); track l.id) {
              @let open = stateOf(l) === 'open';
              <tr z-table-row [ofListItem]="l" data-slot="line-row">
                <td
                  z-table-cell
                  class="align-top font-medium whitespace-normal [overflow-wrap:anywhere]"
                >
                  {{ source.productLabel(l.attributes.product) }}
                </td>
                <td
                  z-table-cell
                  class="align-top whitespace-normal [overflow-wrap:anywhere]"
                >
                  {{ l.attributes.revision }}
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <a
                    class="text-foreground focus-visible:ring-ring/50 rounded-sm [overflow-wrap:anywhere] underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
                    [routerLink]="[
                      '/releases',
                      l.relationships.baseRelease.data.id,
                    ]"
                    >{{ name(l) }}</a
                  >
                </td>
                <td z-table-cell class="align-top">
                  <z-badge
                    class="gap-1"
                    [zType]="open ? 'info' : 'secondary'"
                    data-slot="line-state"
                  >
                    <ng-icon
                      [name]="open ? 'lucideCircleDot' : 'lucideCircleSlash'"
                      aria-hidden="true"
                    />
                    {{
                      (open
                        ? 'editor.releases.maintenance.state.open'
                        : 'editor.releases.maintenance.state.closed'
                      ) | transloco
                    }}
                  </z-badge>
                </td>
                <td
                  z-table-cell
                  class="text-muted-foreground align-top text-sm whitespace-normal"
                >
                  <span
                    class="block"
                    [attr.title]="l.attributes.createdAt | ofDate: dateTime"
                    >{{ l.attributes.createdAt | ofRelativeTime }}</span
                  >
                  <of-person-name
                    class="block text-xs"
                    [who]="l.attributes.createdBy"
                    [name]="person(l.attributes.createdBy)"
                  />
                </td>
                <td z-table-cell class="align-top text-end">
                  @if (open) {
                    <button
                      z-button
                      zType="outline"
                      zSize="sm"
                      type="button"
                      data-slot="close-line"
                      [ofGuard]="{
                        permission: 'release.publish',
                        blockedReason: closing().has(l.id)
                          ? 'editor.releases.maintenance.closingReason'
                          : null,
                      }"
                      [attr.aria-label]="
                        'editor.releases.maintenance.closeLabel'
                          | transloco: { name: name(l) }
                      "
                      (click)="askClose(l)"
                    >
                      {{ 'editor.releases.maintenance.close' | transloco }}
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>
  `,
})
export class MaintenanceTabComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly actions = inject(MaintenanceActions);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly t = injectTranslate();
  private readonly nameOf = injectPersonName();
  protected readonly source = inject(ReleaseSource);

  /** The page and its size (the address's `linesPage`, `linesSize`). */
  readonly page = input(1);
  readonly size = input<number>(RELEASE_PAGE_SIZES[0]);
  /** Read again from outside (a line started from a release's panel). */
  readonly version = input(0);
  readonly pageChange = output<number>();
  readonly sizeChange = output<number>();

  protected readonly pageSizes = RELEASE_PAGE_SIZES;
  protected readonly dateTime: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  protected readonly doc = signal<LineDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** Lines shown closed while the close is on its way. */
  protected readonly closing = signal<ReadonlySet<string>>(new Set());
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
      const page = this.page();
      const size = this.size();
      this.version();
      this.reloads();
      // Whoever acts now: what was read for someone else is read anew.
      void this.me.me().id;
      untracked(() => void this.load(page, size));
    });
    inject(DestroyRef).onDestroy(() => this.runs++);
  }

  protected asLines(items: readonly unknown[]): readonly MaintenanceLine[] {
    return items as readonly MaintenanceLine[];
  }

  /** Open, closed, or closed already on screen while the close is on its way. */
  protected stateOf(line: MaintenanceLine): 'open' | 'closed' {
    return this.closing().has(line.id) ? 'closed' : line.attributes.state;
  }

  /** "North 2.1": the line as people read it, its product and product version. */
  protected name(line: MaintenanceLine): string {
    return this.t('editor.releases.name', {
      product: this.source.productLabel(line.attributes.product),
      version: line.attributes.revision,
    });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected askClose(line: MaintenanceLine): void {
    const name = this.name(line);
    this.dialogs.confirm({
      zTitle: this.t('editor.releases.maintenance.closeTitle', { name }),
      zDescription: this.t('editor.releases.maintenance.closeText', { name }),
      zOkText: this.t('editor.releases.maintenance.closeConfirm'),
      zOkDestructive: true,
      zOnOk: () => void this.close(line, name),
    });
  }

  private async close(line: MaintenanceLine, name: string): Promise<void> {
    if (this.closing().has(line.id)) return;
    // Shown closed at once; put back if the API refuses.
    this.closing.update((s) => new Set(s).add(line.id));
    const closed = await this.actions.close(line, name, () =>
      this.close(line, name),
    );
    if (closed) this.replace(closed);
    this.closing.update((s) => {
      const next = new Set(s);
      next.delete(line.id);
      return next;
    });
    // Closed elsewhere meanwhile, say: what the API knows now.
    if (!closed) this.reload();
  }

  private replace(line: MaintenanceLine): void {
    const doc = this.doc();
    if (!doc) return;
    this.doc.set({
      ...doc,
      data: doc.data.map((l) => (l.id === line.id ? line : l)),
    });
  }

  private async load(page: number, size: number): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/maintenance-lines', {
          query: pageQuery({ number: page, size }),
        }),
      );
      if (run !== this.runs) return;
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && page > last) {
        this.pageChange.emit(last);
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
