import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
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
import { lucideChevronRight, lucideDownload, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { DatePipe, injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ReservedSlotDirective } from '@openfolia/ui/smooth';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import { apiErrorText } from '../../i18n';
import { saveResponse } from '../../reports/report-download';
import { PersonNameComponent } from '../../session/person-name.component';
import {
  idParam,
  injectQueryState,
  intParam,
  textParam,
} from '../../view-state';
import { type KnownActor, loadActors } from './actor-sources';
import {
  ACTION_TEXTS,
  AUDIT_PAGE_SIZES,
  type AuditActor,
  type AuditEventItem,
  type AuditSubject,
  type AuditKind,
  dataEntries,
  dayRangeFilter,
  type DataEntry,
  readFacts,
  type ReadFacts,
  SUBJECT_ID_MAX,
  SUBJECT_TYPE_TEXTS,
  subjectFilter,
  subjectLink,
  type SubjectLink,
  validAction,
  validActor,
  validDay,
  validKind,
  validSubjectType,
} from './audit-model';

type AuditDoc = Response<'/audit-events'>;

/** Space kept below the frame: the note under it and the page's bottom padding. */
const BELOW_FRAME_PX = 72;

/** The formats the log exports to, as `GET /audit-events/export` names them. */
type ExportFormat = 'csv' | 'jsonl';

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * The Audit log tab of Admin (#269): the append-only log, newest first, each event with its time,
 * who acted (by name where the person or service account is known, else the ID), what happened
 * (in words for a known action, else its key), what it happened to (a link to the module, the
 * manual or the change set's review) and the comment. A row opens to show its details (`data`).
 * Filters: the kind of event (#877: changes, or the reads of service accounts, one per request
 * their tokens make, each with the route, the client and the status), actor (a kind or one person
 * or service account), subject (a type, and an ID within it), action and a range of days (both included, in the browser's time zone); they, the page and its
 * size are in the address, so the review and the module editor link here with the subject set.
 * Export (#379) downloads every event the filters select, as CSV or JSON Lines; the API records
 * each export in the log itself.
 */
@Component({
  selector: 'of-audit-log-page',
  imports: [
    PersonNameComponent,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    DatePipe,
    CollapseComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    SegmentedComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDropdownImports,
    ZardInputComponent,
    ZardSelectImports,
    ZardTableImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideChevronRight, lucideDownload, lucideX }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="flex flex-wrap items-center gap-3"
      role="group"
      [attr.aria-label]="'editor.admin.audit.filter.label' | transloco"
    >
      <of-segmented
        class="w-full sm:w-auto"
        data-filter="kind"
        [label]="'editor.admin.audit.filter.kind' | transloco"
        [options]="kindOptions()"
        [value]="kind() ?? ''"
        (valueChange)="setKind($event)"
      />
      <z-select
        class="w-full sm:w-60"
        zSearchable
        data-filter="actor"
        [zPrefix]="'editor.admin.audit.filter.actor' | transloco"
        [zAriaLabel]="'editor.admin.audit.filter.actor' | transloco"
        [zValue]="actor() ?? ''"
        (zSelectionChange)="setActor($event)"
      >
        @for (o of actorOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <z-select
        class="w-full sm:w-56"
        data-filter="subject-type"
        [zPrefix]="'editor.admin.audit.filter.subject' | transloco"
        [zAriaLabel]="'editor.admin.audit.filter.subject' | transloco"
        [zValue]="subjectType() ?? ''"
        (zSelectionChange)="setSubjectType($event)"
      >
        @for (o of subjectOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <input
        z-input
        type="search"
        autocomplete="off"
        class="w-full sm:w-56"
        data-filter="subject-id"
        [maxLength]="subjectIdMax"
        [disabled]="!subjectType()"
        [attr.aria-label]="'editor.admin.audit.filter.subjectId' | transloco"
        [placeholder]="'editor.admin.audit.filter.subjectId' | transloco"
        [value]="subjectId()"
        (input)="view.set({ id: $any($event.target).value, page: 1 })"
      />
      <z-select
        class="w-full sm:w-64"
        zSearchable
        data-filter="action"
        [zPrefix]="'editor.admin.audit.filter.action' | transloco"
        [zAriaLabel]="'editor.admin.audit.filter.action' | transloco"
        [zValue]="action() ?? ''"
        (zSelectionChange)="setAction($event)"
      >
        @for (o of actionOptions(); track o.value) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
      <div class="flex w-full flex-wrap items-center gap-3 sm:w-auto">
        <label class="flex w-full items-center gap-2 sm:w-auto">
          <span class="text-muted-foreground shrink-0 text-sm">{{
            'editor.admin.audit.filter.from' | transloco
          }}</span>
          <input
            z-input
            type="date"
            class="w-full sm:w-40"
            data-filter="from"
            [max]="to() ?? ''"
            [value]="from() ?? ''"
            (change)="setDay('from', $any($event.target).value)"
          />
        </label>
        <label class="flex w-full items-center gap-2 sm:w-auto">
          <span class="text-muted-foreground shrink-0 text-sm">{{
            'editor.admin.audit.filter.to' | transloco
          }}</span>
          <input
            z-input
            type="date"
            class="w-full sm:w-40"
            data-filter="to"
            [min]="from() ?? ''"
            [value]="to() ?? ''"
            (change)="setDay('to', $any($event.target).value)"
          />
        </label>
      </div>
      <button
        z-button
        zType="ghost"
        type="button"
        data-slot="audit-clear"
        [ofReservedSlot]="filtered()"
        (click)="view.reset()"
      >
        <ng-icon name="lucideX" data-icon="inline-start" aria-hidden="true" />
        {{ 'editor.admin.audit.filter.clear' | transloco }}
      </button>
      <button
        z-button
        zType="outline"
        type="button"
        class="sm:ms-auto"
        data-slot="audit-export"
        z-dropdown
        [zDropdownMenu]="exportMenu"
        [zDisabled]="exporting()"
        [attr.aria-busy]="exporting()"
      >
        <ng-icon
          name="lucideDownload"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.admin.audit.export.label' | transloco }}
      </button>
      <z-dropdown-menu-content #exportMenu class="w-56">
        <z-dropdown-menu-item
          data-action="export-csv"
          (click)="download('csv')"
        >
          {{ 'editor.admin.audit.export.csv' | transloco }}
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          data-action="export-jsonl"
          (click)="download('jsonl')"
        >
          {{ 'editor.admin.audit.export.jsonl' | transloco }}
        </z-dropdown-menu-item>
      </z-dropdown-menu-content>
    </div>

    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      [label]="'editor.admin.audit.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="emptyTexts().title | transloco"
      [emptyDescription]="emptyTexts().description | transloco"
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <!-- Fits the frame from a 1024 px window up; narrower, the frame scrolls it sideways. -->
        <table z-table class="min-w-[40rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-10">
                <span class="sr-only">{{
                  'editor.admin.audit.table.details' | transloco
                }}</span>
              </th>
              <th z-table-head class="w-36 xl:w-44">
                {{ 'editor.admin.audit.table.time' | transloco }}
              </th>
              <th z-table-head class="w-[18%]">
                {{ 'editor.admin.audit.table.actor' | transloco }}
              </th>
              <th z-table-head class="w-[20%]">
                {{ 'editor.admin.audit.table.action' | transloco }}
              </th>
              <th z-table-head class="w-[22%]">
                {{ 'editor.admin.audit.table.subject' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.admin.audit.table.comment' | transloco }}
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (event of asEvents(items); track event.id) {
              @let a = event.attributes;
              @let open = isOpen(event.id);
              @let link = linkOf(a.subject);
              @let read = readOf(event);
              <tr
                z-table-row
                [ofListItem]="event"
                class="border-b-0!"
                data-slot="audit-row"
                [attr.data-event]="event.id"
              >
                <td z-table-cell class="align-top">
                  <button
                    z-button
                    zType="ghost"
                    zSize="icon-sm"
                    type="button"
                    data-slot="audit-toggle"
                    [attr.aria-expanded]="open"
                    [attr.aria-controls]="'audit-details-' + event.id"
                    [attr.aria-label]="
                      (open
                        ? 'editor.admin.audit.table.hideDetails'
                        : 'editor.admin.audit.table.showDetails'
                      ) | transloco
                    "
                    (click)="toggle(event.id)"
                  >
                    <ng-icon
                      name="lucideChevronRight"
                      aria-hidden="true"
                      class="transition-transform duration-200 ease-out motion-reduce:transition-none"
                      [class.rotate-90]="open"
                    />
                  </button>
                </td>
                <td
                  z-table-cell
                  class="text-muted-foreground align-top whitespace-normal tabular-nums"
                >
                  <time [attr.datetime]="a.at">{{
                    a.at | ofDate: dateFormat
                  }}</time>
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  @let name = nameOf(a.actor);
                  @if (name) {
                    <of-person-name
                      class="block font-medium"
                      [who]="a.actor"
                      [name]="name"
                    />
                    <span
                      class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                      >{{ a.actor.id }}</span
                    >
                  } @else {
                    <of-person-name
                      class="block font-mono text-xs [overflow-wrap:anywhere]"
                      [who]="a.actor"
                      [name]="a.actor.id"
                    />
                  }
                  @if (a.actor.kind === 'service') {
                    <z-badge zType="outline" class="mt-1 h-auto">{{
                      'editor.admin.audit.actor.service' | transloco
                    }}</z-badge>
                  }
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  @let text = actionText(a.action);
                  @if (text) {
                    <span class="block break-words">{{
                      text | transloco
                    }}</span>
                    <span
                      class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                      >{{ a.action }}</span
                    >
                  } @else {
                    <span
                      class="block font-mono text-xs [overflow-wrap:anywhere]"
                      >{{ a.action }}</span
                    >
                  }
                  @if (read) {
                    <span
                      class="mt-1 flex flex-wrap gap-1"
                      data-slot="audit-read-facts"
                    >
                      @if (read.client) {
                        <z-badge
                          zType="info"
                          class="h-auto max-w-full font-mono font-normal whitespace-normal [overflow-wrap:anywhere]"
                          data-slot="audit-read-client"
                          [attr.title]="
                            'editor.admin.audit.read.client'
                              | transloco: { client: read.client }
                          "
                          ><span class="sr-only">{{
                            'editor.admin.audit.read.clientLabel' | transloco
                          }}</span
                          >{{ read.client }}</z-badge
                        >
                      }
                      @if (read.failedStatus) {
                        <z-badge
                          class="h-auto whitespace-normal tabular-nums"
                          data-slot="audit-read-status"
                          [zType]="
                            read.failedStatus >= 500 ? 'destructive' : 'warning'
                          "
                          >{{
                            'editor.admin.audit.read.status'
                              | transloco: { status: read.failedStatus }
                          }}</z-badge
                        >
                      }
                      @if (read.unrecorded !== undefined) {
                        <z-badge
                          zType="warning"
                          class="h-auto whitespace-normal tabular-nums"
                          data-slot="audit-read-gap"
                          >{{
                            'editor.admin.audit.read.unrecorded'
                              | transloco: { count: read.unrecorded }
                          }}</z-badge
                        >
                      }
                      @if (read.aborted) {
                        <z-badge
                          zType="secondary"
                          class="h-auto whitespace-normal"
                          >{{
                            'editor.admin.audit.read.aborted' | transloco
                          }}</z-badge
                        >
                      }
                    </span>
                  }
                  @if (a.data['self'] === true) {
                    <z-badge
                      zType="secondary"
                      class="mt-1 h-auto whitespace-normal"
                      data-slot="audit-self"
                      >{{ 'editor.admin.audit.self' | transloco }}</z-badge
                    >
                  }
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="text-muted-foreground block text-xs">{{
                    subjectTypeLabel(a.subject.type)
                  }}</span>
                  @if (link) {
                    <a
                      class="text-foreground block font-mono text-xs [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:underline"
                      data-slot="audit-subject-link"
                      [routerLink]="link.commands"
                      [queryParams]="link.queryParams"
                      >{{ a.subject.id }}</a
                    >
                  } @else {
                    <span
                      class="block font-mono text-xs [overflow-wrap:anywhere]"
                      >{{ a.subject.id }}</span
                    >
                  }
                  @if (read?.ref; as ref) {
                    <span
                      class="text-muted-foreground mt-0.5 block text-xs [overflow-wrap:anywhere]"
                      data-slot="audit-read-ref"
                      >{{
                        'editor.admin.audit.read.ref' | transloco: { ref }
                      }}</span
                    >
                  }
                </td>
                <td
                  z-table-cell
                  class="align-top break-words whitespace-pre-line"
                  [class.text-muted-foreground]="!a.comment"
                >
                  {{
                    a.comment ||
                      ('editor.admin.audit.table.noComment' | transloco)
                  }}
                </td>
              </tr>
              <tr
                z-table-row
                [ofListItem]="event"
                class="hover:bg-transparent! hover:[clip-path:none]!"
                data-slot="audit-details-row"
              >
                <td z-table-cell colspan="6" class="p-0!">
                  <of-collapse
                    [open]="open"
                    [attr.id]="'audit-details-' + event.id"
                  >
                    @if (open || wasOpened(event.id)) {
                      @let entries = entriesOf(event);
                      <div class="ps-12 pe-2 pb-3">
                        @if (entries.length > 0) {
                          <dl
                            class="bg-muted/40 m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md p-3 text-xs sm:grid-cols-[minmax(8rem,max-content)_1fr]"
                            data-slot="audit-details"
                          >
                            @for (entry of entries; track entry.key) {
                              <dt
                                class="text-muted-foreground font-mono [overflow-wrap:anywhere]"
                              >
                                {{ entry.key }}
                              </dt>
                              <dd
                                class="m-0 mb-1 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap sm:mb-0"
                                [class.text-muted-foreground]="
                                  entry.value === null
                                "
                              >
                                {{
                                  entry.value ??
                                    ('editor.admin.audit.details.none'
                                      | transloco)
                                }}
                              </dd>
                            }
                          </dl>
                        } @else {
                          <p
                            class="text-muted-foreground bg-muted/40 m-0 rounded-md p-3 text-xs"
                          >
                            {{ 'editor.admin.audit.details.empty' | transloco }}
                          </p>
                        }
                      </div>
                    }
                  </of-collapse>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>

    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.audit.note' | transloco }}
    </p>
  `,
})
export class AuditLogPage {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    kind: idParam(validKind),
    actor: idParam(validActor),
    type: idParam(validSubjectType),
    id: textParam({ max: SUBJECT_ID_MAX }),
    action: idParam(validAction),
    from: idParam(validDay),
    to: idParam(validDay),
    page: intParam(1),
    size: intParam(AUDIT_PAGE_SIZES[0], { only: AUDIT_PAGE_SIZES }),
  });
  protected readonly kind = this.view.get('kind');
  protected readonly actor = this.view.get('actor');
  protected readonly subjectType = this.view.get('type');
  protected readonly subjectId = this.view.get('id');
  protected readonly action = this.view.get('action');
  protected readonly from = this.view.get('from');
  protected readonly to = this.view.get('to');
  protected readonly pageSizes = AUDIT_PAGE_SIZES;
  protected readonly subjectIdMax = SUBJECT_ID_MAX;
  protected readonly dateFormat: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'medium',
  };

  protected readonly doc = signal<AuditDoc | null>(null);
  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly actors = signal<readonly KnownActor[]>([]);
  /** The events whose details are open. */
  private readonly opened = signal<ReadonlySet<string>>(new Set());
  /** The events whose details were ever opened: kept drawn, so closing animates. */
  private readonly drawn = signal<ReadonlySet<string>>(new Set());
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly filtered = computed(
    () =>
      this.kind() !== undefined ||
      this.actor() !== undefined ||
      this.subjectType() !== undefined ||
      this.subjectId() !== '' ||
      this.action() !== undefined ||
      this.from() !== undefined ||
      this.to() !== undefined,
  );

  /** The filters as the API takes them, on the list and the export alike. */
  private readonly filterQuery = computed(
    (): Readonly<Record<string, string | undefined>> => ({
      'filter[kind]': this.kind(),
      'filter[actor]': this.actor(),
      'filter[subject]': subjectFilter(this.subjectType(), this.subjectId()),
      'filter[action]': this.action(),
      ...dayRangeFilter(this.from(), this.to()),
    }),
  );

  /** Changes, reads or both (#877). */
  protected readonly kindOptions = computed((): SegmentedOption[] => [
    { value: '', label: this.t('editor.admin.audit.filter.kindAll') },
    { value: 'write', label: this.t('editor.admin.audit.filter.kindWrite') },
    { value: 'read', label: this.t('editor.admin.audit.filter.kindRead') },
  ]);

  /** What an empty list says: about reads when only they are asked for. */
  protected readonly emptyTexts = computed(() => {
    const onlyReads =
      this.kind() === 'read' &&
      this.actor() === undefined &&
      this.subjectType() === undefined &&
      this.action() === undefined &&
      this.from() === undefined &&
      this.to() === undefined;
    if (onlyReads) {
      return {
        title: 'editor.admin.audit.empty.readsTitle',
        description: 'editor.admin.audit.empty.readsDescription',
      };
    }
    return this.filtered()
      ? {
          title: 'editor.admin.audit.empty.filteredTitle',
          description: 'editor.admin.audit.empty.filteredDescription',
        }
      : {
          title: 'editor.admin.audit.empty.title',
          description: 'editor.admin.audit.empty.description',
        };
  });

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  private readonly names = computed(
    () =>
      new Map(this.actors().map((a) => [`${a.kind}/${a.id}`, a.name] as const)),
  );

  protected readonly actorOptions = computed((): Option[] => {
    const known = this.actors();
    const byName = (a: KnownActor, b: KnownActor) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    const people = known.filter((a) => a.kind === 'user').sort(byName);
    const services = known.filter((a) => a.kind === 'service').sort(byName);
    const options: Option[] = [
      { value: '', label: this.t('editor.admin.audit.filter.anyone') },
      { value: 'user', label: this.t('editor.admin.audit.filter.anyPerson') },
      {
        value: 'service',
        label: this.t('editor.admin.audit.filter.anyService'),
      },
      ...people.map((a) => ({
        value: `user/${a.id}`,
        label: this.t('editor.admin.audit.filter.person', {
          name: a.name,
          id: a.id,
        }),
      })),
      ...services.map((a) => ({
        value: `service/${a.id}`,
        label: this.t('editor.admin.audit.filter.service', {
          name: a.name,
          id: a.id,
        }),
      })),
    ];
    return withCurrent(options, this.actor());
  });

  protected readonly subjectOptions = computed((): Option[] => {
    const options: Option[] = [
      { value: '', label: this.t('editor.admin.audit.filter.anySubject') },
      ...Object.entries(SUBJECT_TYPE_TEXTS)
        .map(([value, key]) => ({ value, label: this.t(key) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    return withCurrent(options, this.subjectType());
  });

  protected readonly actionOptions = computed((): Option[] => {
    const options: Option[] = [
      { value: '', label: this.t('editor.admin.audit.filter.anyAction') },
      ...Object.entries(ACTION_TEXTS)
        .map(([value, key]) => ({ value, label: this.t(key) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    return withCurrent(options, this.action());
  });

  constructor() {
    effect(() => {
      const query = {
        filters: this.filterQuery(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });
    void this.loadActors();

    const destroyRef = inject(DestroyRef);
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.doc();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected asEvents(items: readonly unknown[]): readonly AuditEventItem[] {
    return items as readonly AuditEventItem[];
  }

  /** The actor's name, when the person or service account is known. */
  protected nameOf(actor: AuditActor): string | undefined {
    return this.names().get(`${actor.kind}/${actor.id}`);
  }

  protected actionText(action: string): string | undefined {
    return ACTION_TEXTS[action];
  }

  protected subjectTypeLabel(type: string): string {
    const key = SUBJECT_TYPE_TEXTS[type];
    return key ? this.t(key) : type;
  }

  protected linkOf(subject: AuditSubject): SubjectLink | null {
    return subjectLink(subject);
  }

  protected readOf(event: AuditEventItem): ReadFacts | null {
    return readFacts(event);
  }

  protected entriesOf(event: AuditEventItem): DataEntry[] {
    return dataEntries(event.attributes.data);
  }

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  protected wasOpened(id: string): boolean {
    return this.drawn().has(id);
  }

  protected toggle(id: string): void {
    this.drawn.update((drawn) =>
      drawn.has(id) ? drawn : new Set(drawn).add(id),
    );
    this.opened.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected setKind(value: string): void {
    const kind = validKind(value) ? (value as AuditKind) : undefined;
    this.view.set({ kind, page: 1 });
  }

  protected setActor(value: string | string[]): void {
    const actor = typeof value === 'string' && value ? value : undefined;
    this.view.set({ actor, page: 1 });
  }

  protected setSubjectType(value: string | string[]): void {
    const type = typeof value === 'string' && value ? value : undefined;
    if (type === this.subjectType()) return;
    // An ID belongs to its type: another type starts without one.
    this.view.set({ type, id: '', page: 1 });
  }

  protected setAction(value: string | string[]): void {
    const action = typeof value === 'string' && value ? value : undefined;
    this.view.set({ action, page: 1 });
  }

  protected setDay(which: 'from' | 'to', value: string): void {
    const day = value && validDay(value) ? value : undefined;
    this.view.set({ [which]: day, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  /** Saves every event the filters select as a file; a toast says when that failed. */
  protected async download(format: ExportFormat): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      const response = await firstValueFrom(
        this.api.auditExport(format, this.filterQuery()),
      );
      saveResponse(this.document, response, `audit-log.${format}`);
    } catch {
      this.toast.error(translated('editor.admin.audit.export.failed'));
    } finally {
      this.exporting.set(false);
    }
  }

  private async loadActors(): Promise<void> {
    try {
      this.actors.set(await loadActors(this.api));
    } catch {
      // Actors are shown by their IDs.
    }
  }

  private async load(query: {
    filters: Readonly<Record<string, string | undefined>>;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/audit-events', {
          query: {
            ...definedOnly(query.filters),
            ...pageQuery({ number: query.page, size: query.size }),
          },
        }),
      );
      if (run !== this.runs) return;
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}

/** The options, with the address's value added (as itself) when none of them is it. */
function withCurrent(options: Option[], current: string | undefined): Option[] {
  if (current === undefined || options.some((o) => o.value === current)) {
    return options;
  }
  return [...options, { value: current, label: current }];
}

/** The entries whose value is set. */
function definedOnly(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value) out[key] = value;
  }
  return out;
}
