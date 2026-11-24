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
import { lucideHistory } from '@ng-icons/lucide';

import { injectTranslate } from '@openfolia/ui/i18n';
import { type ListFrameError } from '@openfolia/ui/list-frame';

import { ApiClient, ReadRef, toApiError, type ApiError } from '../api';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { ChangeSetUrl } from '../session/change-set-url';
import { HistoryListComponent, type RowLink } from './history-list.component';
import {
  injectPersonName,
  loadHistory,
  pageOf,
  type ModuleVersionPage,
} from './history-model';

/**
 * The module editor's History tab: the module's versions (the same list as the history page,
 * paged in its frame), each opening the full-width history page on that version, compared with
 * the one before it; "Open history" opens it on the newest.
 */
@Component({
  selector: 'of-history-panel',
  imports: [RouterLink, TranslocoPipe, NgIcon, HistoryListComponent],
  viewProviders: [provideIcons({ lucideHistory })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <of-history-list
      compact
      [doc]="doc()"
      [loading]="loading()"
      [error]="error()"
      offset="calc(20rem + var(--of-sandbox-h, 0px))"
      [rowLink]="rowLink"
      [pageLink]="choosePage"
      [retry]="reload"
      [nameOf]="nameOf"
    />
    <a
      class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex w-fit items-center gap-1.5 rounded-sm text-sm outline-none focus-visible:ring-2"
      [routerLink]="historyPath()"
      [queryParams]="csLink.params()"
      data-slot="history-open"
    >
      <ng-icon name="lucideHistory" aria-hidden="true" />
      {{ 'editor.history.open' | transloco }}
    </a>
  `,
})
export class HistoryPanelComponent {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly t = injectTranslate();
  protected readonly csLink = inject(ChangeSetUrl);
  protected readonly nameOf = injectPersonName();

  readonly lang = input.required<string>();
  readonly moduleId = input.required<string>();
  /** The page of versions shown (the editor keeps it in the address). */
  readonly page = input(1);
  readonly pageChange = output<number>();
  /** Counts the module's save points: the list is read again after each. */
  readonly revision = input<unknown>(null);

  protected readonly doc = signal<ModuleVersionPage | null>(null);
  protected readonly loading = signal(true);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);

  protected readonly error = computed((): ListFrameError | null => {
    const f = this.failure();
    if (!f) return null;
    const text = apiErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  });

  protected readonly historyPath = computed(() => [
    '/content',
    this.lang(),
    this.moduleId(),
    'history',
  ]);

  protected readonly rowLink: RowLink = (version, index) => ({
    path: this.historyPath(),
    query: {
      ...this.csLink.params(),
      version: version.attributes.commit,
      ...(pageOf(index) > 1 ? { page: pageOf(index) } : {}),
    },
    merge: false,
  });
  protected readonly choosePage = (page: number): void =>
    this.pageChange.emit(page);
  protected readonly reload = (): void => this.reloads.update((n) => n + 1);

  constructor() {
    effect(() => {
      const lang = this.lang();
      const moduleId = this.moduleId();
      const page = this.page();
      this.revision();
      this.readRef.ref();
      this.readRef.moves();
      this.me.me();
      this.reloads();
      untracked(() => void this.load(lang, moduleId, page));
    });
  }

  private runs = 0;
  private async load(
    lang: string,
    moduleId: string,
    page: number,
  ): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await loadHistory(
        this.api,
        { type: 'module', lang, moduleId },
        page,
      );
      if (run !== this.runs) return;
      if (page > Math.max(1, doc.meta.page.lastPage)) {
        this.pageChange.emit(Math.max(1, doc.meta.page.lastPage));
        return;
      }
      this.doc.set(doc);
    } catch (error) {
      if (run !== this.runs) return;
      this.doc.set(null);
      this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
