import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { plainTextOf } from '@openfolia/content-model/core';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import {
  ListFrameComponent,
  type ListFramePage,
  ListRowDirective,
} from '@openfolia/ui/list-frame';

import { ApiClient, pageQuery, toApiError } from '../api';
import { ReadRef } from '../api/read-ref';
import type { TermChoice } from '../doc-editor/writing/writing-aids';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { isReadable } from '../terminology/terms-model';

/** What the picker is opened for: the document's language. */
export interface TermPickRequest {
  readonly lang: string;
}

/** A term as the picker lists it. */
export interface TermRow {
  readonly id: string;
  /** Its preferred variant in the document's language. */
  readonly preferred: string;
  readonly domain: string | null;
  /** The start of its definition, as plain text; empty for none. */
  readonly definition: string;
}

/** Terms per page. */
export const TERM_PICKER_PAGE = 20;
/** Waits this long after the last key before it searches. */
export const TERM_SEARCH_MS = 250;
/** The longest search (the API's `filter[q]` takes up to 200 characters). */
const QUERY_MAX = 200;
/** The most of a definition a row shows. */
const DEFINITION_SHOWN = 160;

const cut = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/**
 * The term picker (#247): "/" Term and the Insert menu's Term open it. It searches the approved
 * terms of the document's language (`GET /terms` with `filter[q]`, at the change set's branch,
 * as the person may read them), a page at a time, and lists each with its preferred variant, its
 * domain and the start of its definition (as text). Choosing one inserts its preferred variant,
 * linked to it; Escape, Cancel or a click outside cancels. The rows scroll inside the list, the
 * pagination below it.
 */
@Component({
  selector: 'of-term-picker-dialog',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ListFrameComponent,
    ListRowDirective,
  ],
  viewProviders: [provideIcons({ lucideSearch })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="open()"
      (zVisibleChange)="visibleChange($event)"
      class="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-[36rem]"
    >
      <z-dialog-header class="border-border border-b px-6 py-5">
        <z-dialog-title class="text-lg">{{
          'editor.termPicker.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description class="text-muted-foreground text-sm">{{
          'editor.termPicker.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <div class="flex min-h-0 flex-col gap-3 p-4 md:p-5">
          <z-input-group class="w-full">
            <z-input-group-addon>
              <ng-icon name="lucideSearch" aria-hidden="true" />
            </z-input-group-addon>
            <input
              z-input
              cdkFocusInitial
              type="search"
              autocomplete="off"
              data-term-search
              [attr.maxlength]="queryMax"
              [attr.aria-label]="'editor.termPicker.search' | transloco"
              [placeholder]="'editor.termPicker.search' | transloco"
              [value]="typed()"
              (input)="type($any($event.target).value)"
            />
          </z-input-group>
          <of-list-frame
            class="min-h-0 flex-1"
            cards
            offset="16rem"
            [label]="'editor.termPicker.list' | transloco"
            [items]="rows()"
            [page]="page()"
            [loading]="list.isLoading()"
            [error]="error()"
            [skeletonRows]="5"
            [emptyTitle]="'editor.termPicker.emptyTitle' | transloco"
            [emptyDescription]="
              'editor.termPicker.emptyDescription' | transloco
            "
            (pageChange)="pageNumber.set($event)"
            (retry)="list.reload()"
          >
            <ng-template ofListRow let-item>
              @let row = asRow(item);
              <button
                type="button"
                data-term-row
                class="hover:bg-muted focus-visible:ring-ring flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2.5 text-start outline-none focus-visible:ring-2"
                [attr.data-term]="row.id"
                (click)="choose(row)"
              >
                <span class="text-sm font-medium break-words">{{
                  row.preferred
                }}</span>
                @if (row.domain) {
                  <span class="text-muted-foreground text-xs break-words">{{
                    row.domain
                  }}</span>
                }
                @if (row.definition) {
                  <span class="text-muted-foreground text-xs break-words">{{
                    row.definition
                  }}</span>
                }
              </button>
            </ng-template>
          </of-list-frame>
        </div>
        <z-dialog-footer class="border-border m-0 border-t px-6 py-4">
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.termPicker.cancel' | transloco }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class TermPickerDialogComponent {
  /** Open while there is a request; null: closed. */
  readonly request = input<TermPickRequest | null>(null);
  /** The term chosen, or null: cancelled. */
  readonly done = output<TermChoice | null>();

  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService).me;
  private readonly t = injectTranslate();

  protected readonly queryMax = QUERY_MAX;
  protected readonly open = computed(() => this.request() !== null);
  protected readonly typed = signal('');
  /** The search, once typing paused. */
  private readonly query = signal('');
  protected readonly pageNumber = signal(1);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly list = resource({
    params: () => {
      const request = this.request();
      if (!request) return undefined;
      return {
        lang: request.lang,
        q: this.query(),
        page: this.pageNumber(),
        ref: this.readRef.ref(),
        user: this.me().id,
      };
    },
    loader: async ({ params }) => {
      const doc = await firstValueFrom(
        this.api.get('/terms', {
          query: {
            'filter[lang]': params.lang,
            'filter[status]': 'approved',
            ...(params.q ? { 'filter[q]': params.q } : {}),
            ...pageQuery({ number: params.page, size: TERM_PICKER_PAGE }),
          },
        }),
      );
      const rows: TermRow[] = [];
      for (const item of doc.data) {
        if (!isReadable(item)) continue;
        const entry = item.attributes.languages[params.lang];
        if (!entry) continue;
        rows.push({
          id: item.id,
          preferred: entry.preferred,
          domain: item.attributes.domain ?? null,
          definition: entry.definition
            ? cut(plainTextOf(entry.definition).text, DEFINITION_SHOWN)
            : '',
        });
      }
      return { rows, page: doc.meta.page as ListFramePage };
    },
  });

  protected readonly rows = computed(() =>
    this.list.hasValue() ? this.list.value().rows : [],
  );
  protected readonly page = computed(() =>
    this.list.hasValue() ? this.list.value().page : null,
  );
  protected readonly error = computed(() => {
    if (this.list.status() !== 'error') return null;
    const error = toApiError(this.list.error());
    const text = apiErrorText(error);
    return { kind: error.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    // A new opening starts with an empty search on the first page.
    effect(() => {
      if (!this.request()) return;
      untracked(() => {
        this.typed.set('');
        this.query.set('');
        this.pageNumber.set(1);
      });
    });
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  protected type(value: string): void {
    this.typed.set(value);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.query.set(value.trim().slice(0, QUERY_MAX));
      this.pageNumber.set(1);
    }, TERM_SEARCH_MS);
  }

  protected asRow(item: unknown): TermRow {
    return item as TermRow;
  }

  protected choose(row: TermRow): void {
    if (!this.request()) return;
    this.clearTimer();
    this.done.emit({ termId: row.id, text: row.preferred });
  }

  protected cancel(): void {
    if (!this.request()) return;
    this.clearTimer();
    this.done.emit(null);
  }

  /** Escape, the close button or a click outside closes the dialog: a cancel. */
  protected visibleChange(visible: boolean): void {
    if (!visible) this.cancel();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
