import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBan,
  lucideCircleMinus,
  lucideCirclePlus,
  lucideRefreshCw,
} from '@ng-icons/lucide';

import {
  ZardBadgeComponent,
  type ZardBadgeTypeVariants,
} from '@openfolia/ui/badge';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardTableImports } from '@openfolia/ui/table';

import { languageName } from '../../content/browser-model';
import { frameOffset } from '../../releases/frame-offset';
import {
  ITEM_RESULTS,
  itemKey,
  itemsShowing,
  KIND_TEXT,
  notesFor,
  pageOf,
  REPORT_PAGE_SIZES,
  RESULT_TEXT,
  type ConverterNote,
  type ImportReport,
  type ItemResult,
  type ReportIssue,
  type ReportItem,
} from './import-model';

/** Room kept below the frame: the page's actions and its bottom padding. */
const BELOW_FRAME_PX = 104;

/** A result's badge: its colour, always with its icon and word. */
const RESULT_BADGE: Readonly<
  Record<ItemResult, { type: ZardBadgeTypeVariants; icon: string }>
> = {
  create: { type: 'success', icon: 'lucideCirclePlus' },
  update: { type: 'info', icon: 'lucideRefreshCw' },
  skip: { type: 'outline', icon: 'lucideCircleMinus' },
  refuse: { type: 'destructive', icon: 'lucideBan' },
};

/** Reasons and findings with a text of their own; any other shows the server's message. */
const ISSUE_TEXT: Readonly<Record<string, string>> = {
  exists: 'editor.admin.import.reason.exists',
  unchanged: 'editor.admin.import.reason.unchanged',
  unused: 'editor.admin.import.reason.unused',
  'outside-scope': 'editor.admin.import.reason.outsideScope',
  'too-large': 'editor.admin.import.reason.tooLarge',
  'unsupported-image-type': 'editor.admin.import.reason.unsupportedImage',
  'unsupported-attachment-type':
    'editor.admin.import.reason.unsupportedAttachment',
  'missing-asset': 'editor.admin.import.reason.missingAsset',
  'unknown-module-type': 'editor.admin.import.reason.unknownModuleType',
};

/** One line under an item: a reason, another finding or a converter's note. */
interface DetailLine {
  readonly kind: 'reason' | 'issue' | 'note';
  readonly code: string | null;
  readonly text: string;
}

/**
 * The dry run's items (#93): filterable by result (the segmented control, with counts), in a
 * paged table in the list frame, so the rows scroll inside it with the pagination below, always
 * in view. Each row: the result (icon and word), the kind, the new ID with its language, the ID
 * in the source system beside it, and the reasons, the other findings and the converter's notes.
 * Long IDs and paths wrap. The whole report is in the import, so paging and the filter are done
 * here, without a request.
 */
@Component({
  selector: 'of-import-items',
  imports: [
    NgIcon,
    TranslocoPipe,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    SegmentedComponent,
    ZardBadgeComponent,
    ZardTableImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBan,
      lucideCircleMinus,
      lucideCirclePlus,
      lucideRefreshCw,
    }),
  ],
  host: { class: 'flex min-h-0 min-w-0 flex-col gap-3' },
  template: `
    <of-segmented
      data-slot="result-filter"
      [options]="filterOptions()"
      [value]="result() ?? 'all'"
      (valueChange)="filter($event)"
      [label]="'editor.admin.import.report.filter' | transloco"
    />
    <of-list-frame
      #frame
      class="min-h-48 min-w-0"
      [label]="'editor.admin.import.report.label' | transloco"
      [items]="shown().items"
      [trackBy]="key"
      [page]="shown().page"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (result()
          ? 'editor.admin.import.report.emptyFiltered'
          : 'editor.admin.import.report.empty'
        ) | transloco
      "
      (pageChange)="pageChange.emit($event)"
      (pageSizeChange)="pageSizeChange.emit($event)"
    >
      <ng-template ofListTable let-items>
        <!-- Fits the frame from a 1024 px window up; narrower, the frame scrolls it sideways. -->
        <table z-table class="min-w-[44rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-32">
                {{ 'editor.admin.import.report.result' | transloco }}
              </th>
              <th z-table-head class="w-24">
                {{ 'editor.admin.import.report.kind' | transloco }}
              </th>
              <th z-table-head class="w-[24%]">
                {{ 'editor.admin.import.report.id' | transloco }}
              </th>
              <th z-table-head class="w-[18%]">
                {{ 'editor.admin.import.report.sourceId' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.admin.import.report.details' | transloco }}
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (item of asItems(items); track key(item)) {
              @let badge = badgeOf(item.action);
              @let lines = detailsOf(item);
              <tr
                z-table-row
                [ofListItem]="item"
                data-slot="report-item"
                [attr.data-id]="item.id"
                [attr.data-result]="item.action"
              >
                <td z-table-cell class="align-top">
                  <z-badge [zType]="badge.type" data-slot="result">
                    <ng-icon [name]="badge.icon" aria-hidden="true" />
                    {{ resultText[item.action] | transloco }}
                  </z-badge>
                </td>
                <td z-table-cell class="align-top text-sm break-words">
                  {{ kindText[item.kind] | transloco }}
                </td>
                <td z-table-cell class="align-top">
                  <span class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <code
                      class="min-w-0 font-mono text-xs [overflow-wrap:anywhere] whitespace-normal"
                      data-slot="item-id"
                      >{{ item.id }}</code
                    >
                    @if (item.lang) {
                      <z-badge
                        zType="outline"
                        class="font-semibold uppercase"
                        [attr.title]="languageLabel(item.lang)"
                        >{{ item.lang
                        }}<span class="sr-only">
                          {{ languageLabel(item.lang) }}</span
                        ></z-badge
                      >
                    }
                  </span>
                </td>
                <td z-table-cell class="align-top">
                  @if (item.sourceId) {
                    <code
                      class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere] whitespace-normal"
                      data-slot="source-id"
                      >{{ item.sourceId }}</code
                    >
                  } @else {
                    <span class="text-muted-foreground text-xs">{{
                      'editor.admin.import.report.noSource' | transloco
                    }}</span>
                  }
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  @if (lines.length === 0 && !item.passthrough) {
                    <span class="text-muted-foreground text-xs">{{
                      'editor.admin.import.report.noDetails' | transloco
                    }}</span>
                  } @else {
                    <ul
                      class="m-0 flex list-none flex-col gap-1 p-0 text-xs"
                      data-slot="details"
                    >
                      @for (line of lines; track $index) {
                        <li
                          class="min-w-0 break-words [overflow-wrap:anywhere]"
                          [attr.data-detail]="line.kind"
                        >
                          <span
                            class="font-medium"
                            [class.text-destructive]="
                              line.kind === 'reason' && item.action === 'refuse'
                            "
                            >{{ detailLabel[line.kind] | transloco }}:</span
                          >
                          {{ line.text }}
                          @if (line.code) {
                            <code
                              class="text-muted-foreground font-mono text-[0.6875rem]"
                              >({{ line.code }})</code
                            >
                          }
                        </li>
                      }
                      @if (item.passthrough) {
                        <li
                          class="text-muted-foreground"
                          data-detail="passthrough"
                        >
                          {{
                            'editor.admin.import.report.passthrough'
                              | transloco: { count: item.passthrough }
                          }}
                        </li>
                      }
                      @if (
                        item.issueCount >
                        item.reasons.length + item.issues.length
                      ) {
                        <li class="text-muted-foreground">
                          {{
                            'editor.admin.import.report.more'
                              | transloco
                                : {
                                    count:
                                      item.issueCount -
                                      item.reasons.length -
                                      item.issues.length,
                                  }
                          }}
                        </li>
                      }
                    </ul>
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
export class ImportItemsComponent {
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  readonly report = input.required<ImportReport>();
  readonly result = input<ItemResult | undefined>(undefined);
  readonly page = input(1);
  readonly size = input(REPORT_PAGE_SIZES[0] ?? 25);

  readonly resultChange = output<ItemResult | undefined>();
  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();

  protected readonly pageSizes = REPORT_PAGE_SIZES;
  protected readonly resultText = RESULT_TEXT;
  protected readonly kindText = KIND_TEXT;
  protected readonly detailLabel: Readonly<Record<DetailLine['kind'], string>> =
    {
      reason: 'editor.admin.import.report.reason',
      issue: 'editor.admin.import.report.finding',
      note: 'editor.admin.import.report.note',
    };
  protected readonly key = (item: unknown) => itemKey(item as ReportItem);

  protected readonly shown = computed(() =>
    pageOf(
      itemsShowing(this.report().items, this.result()),
      this.page(),
      this.size(),
    ),
  );

  protected readonly filterOptions = computed((): SegmentedOption[] => {
    const report = this.report();
    const shown = this.result();
    return [
      {
        value: 'all',
        label: this.t('editor.admin.import.report.all'),
        count: report.items.length,
      },
      ...ITEM_RESULTS.filter(
        (r) => r === shown || report.items.some((i) => i.action === r),
      ).map((r) => ({
        value: r,
        label: this.t(RESULT_TEXT[r]),
        count: report.items.filter((i) => i.action === r).length,
      })),
    ];
  });

  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.shown(),
  );

  protected asItems(items: unknown): readonly ReportItem[] {
    return items as readonly ReportItem[];
  }

  protected badgeOf(result: ItemResult) {
    return RESULT_BADGE[result];
  }

  protected filter(value: string): void {
    this.resultChange.emit(ITEM_RESULTS.find((r) => r === value));
  }

  protected detailsOf(item: ReportItem): readonly DetailLine[] {
    const line =
      (kind: 'reason' | 'issue') =>
      (issue: ReportIssue): DetailLine => ({
        kind,
        code: issue.code,
        text: this.issueText(issue),
      });
    return [
      ...item.reasons.map(line('reason')),
      ...item.issues.map(line('issue')),
      ...notesFor(this.report(), item).map(
        (note: ConverterNote): DetailLine => ({
          kind: 'note',
          code: null,
          text: note.message,
        }),
      ),
    ];
  }

  private issueText(issue: ReportIssue): string {
    return Object.hasOwn(ISSUE_TEXT, issue.code)
      ? this.t(ISSUE_TEXT[issue.code] ?? '')
      : issue.message;
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }
}
