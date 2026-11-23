import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { LanguageService } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFrameError,
  type ListFramePage,
} from '@openfolia/ui/list-frame';

import { languageName } from '../content/browser-model';
import { frameOffset } from '../releases/frame-offset';
import { ImportUnitComponent } from './import-unit.component';
import {
  decisionOf,
  moduleKey,
  REPORT_PAGE_SIZES,
  unitKey,
  type Decision,
  type Decisions,
  type ReportModule,
} from './import-model';

/** Room kept below the frame: the page's actions and its bottom padding. */
const BELOW_FRAME_PX = 104;

/** A decision on one unit of the report. */
export interface UnitDecision {
  readonly key: string;
  readonly decision: Decision;
}

/**
 * The report of a translation import, one page of it: a card per module and target language
 * with its units (`of-import-unit`), in the list frame, so the cards scroll inside it with the
 * pagination below, always in view, and room under it for the page's actions.
 */
@Component({
  selector: 'of-import-report',
  imports: [
    TranslocoPipe,
    ListFrameComponent,
    ListRowDirective,
    ZardBadgeComponent,
    ImportUnitComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 min-w-0 flex-col' },
  template: `
    <of-list-frame
      #frame
      cards
      class="min-h-48 min-w-0"
      [label]="'editor.translations.importScreen.report.label' | transloco"
      [items]="modules()"
      [trackBy]="key"
      [page]="page()"
      [loading]="loading()"
      [error]="error()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [skeletonRows]="4"
      [emptyTitle]="
        (filtered()
          ? 'editor.translations.importScreen.report.emptyFiltered'
          : 'editor.translations.importScreen.report.empty'
        ) | transloco
      "
      (pageChange)="pageChange.emit($event)"
      (pageSizeChange)="pageSizeChange.emit($event)"
      (retry)="retry.emit()"
    >
      <ng-template ofListRow let-item>
        @let m = asModule(item);
        <article
          class="border-border bg-card flex min-w-0 flex-col rounded-lg border"
          data-slot="report-module"
          [attr.data-module]="m.moduleId"
          [attr.data-lang]="m.lang"
          [attr.aria-label]="titleOf(m)"
        >
          <header
            class="border-border flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
          >
            <h3 class="m-0 min-w-0 text-sm font-semibold break-words">
              {{ titleOf(m) }}
            </h3>
            <z-badge
              zType="outline"
              class="font-semibold uppercase"
              [attr.title]="languageLabel(m.lang)"
              >{{ m.lang
              }}<span class="sr-only">
                {{ languageLabel(m.lang) }}</span
              ></z-badge
            >
            @if (m.title) {
              <code
                class="text-muted-foreground min-w-0 font-mono text-xs [overflow-wrap:anywhere]"
                >{{
                  m.designId
                    ? ('editor.translations.matrix.design' | transloco) +
                      ' · ' +
                      m.designId
                    : m.manualId
                      ? ('editor.translations.matrix.manual' | transloco) +
                        ' · ' +
                        m.manualId
                      : m.moduleId
                }}</code
              >
            }
          </header>
          <ul class="m-0 flex list-none flex-col p-0">
            @for (u of m.units; track u.blockId) {
              @let k = unitKeyOf(m, u.blockId);
              <li class="border-border border-b px-4 py-3 last:border-b-0">
                <of-import-unit
                  [unit]="u"
                  [lang]="m.lang"
                  [sourceLang]="sourceLang()"
                  [sourceLanguage]="languageLabel(sourceLang())"
                  [targetLanguage]="languageLabel(m.lang)"
                  [decision]="decisionFor(k)"
                  (decide)="decide.emit({ key: k, decision: $event })"
                />
              </li>
            }
          </ul>
        </article>
      </ng-template>
    </of-list-frame>
  `,
})
export class ImportReportComponent {
  private readonly language = inject(LanguageService);

  readonly modules = input.required<readonly ReportModule[]>();
  readonly page = input<ListFramePage | null>(null);
  readonly loading = input(false);
  readonly error = input<ListFrameError | null>(null);
  /** A state filter is on: the empty state says so. */
  readonly filtered = input(false);
  readonly decisions = input.required<Decisions>();
  readonly sourceLang = input('');

  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();
  readonly retry = output<void>();
  readonly decide = output<UnitDecision>();

  protected readonly pageSizes = REPORT_PAGE_SIZES;
  protected readonly key = (item: unknown) => moduleKey(item as ReportModule);

  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = frameOffset(this.frame, BELOW_FRAME_PX, () =>
    this.modules(),
  );

  protected asModule(item: unknown): ReportModule {
    return item as ReportModule;
  }

  protected titleOf(m: ReportModule): string {
    return m.title ?? m.moduleId;
  }

  protected unitKeyOf(m: ReportModule, blockId: string): string {
    return unitKey(m.lang, m.moduleId, blockId);
  }

  protected decisionFor(key: string): Decision {
    return decisionOf(this.decisions(), key);
  }

  protected languageLabel(lang: string): string {
    return lang ? languageName(this.language.locale(), lang) : '';
  }
}
