import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideQrCode } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';

import { ApiClient, pageQuery, toApiError, type ApiError } from '../api';
import { languageName } from '../content/browser-model';
import { apiErrorText } from '../i18n';
import { StableAddressDialogComponent } from './stable-address-dialog.component';
import {
  settingsOf,
  type ShownAddress,
  type StableAddressDoc,
  type StableAddressItem,
} from './stable-addresses';

/** Addresses per page: a side card, so a few. */
export const ADDRESS_PAGE_SIZE = 5;

/**
 * The manual's stable addresses (#450) in the chosen language, on the manual's screen: one per
 * product (its latest release) and variant, each opening the address dialog (Copy, Download QR).
 * Paged; the rows scroll inside the frame and the pagination stays below it. Empty until a
 * release holds the manual.
 */
@Component({
  selector: 'of-stable-addresses-card',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    ListFrameComponent,
    ListRowDirective,
    StableAddressDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideQrCode })],
  host: {
    class:
      'flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5',
  },
  template: `
    <h2 class="m-0 text-sm font-medium" id="addresses-heading">
      {{ 'editor.addresses.heading' | transloco }}
    </h2>
    <of-list-frame
      class="min-h-24 min-w-0"
      offset="calc(100dvh - 22rem)"
      [label]="'editor.addresses.heading' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [skeletonRows]="2"
      [emptyTitle]="'editor.addresses.empty.title' | transloco"
      [emptyDescription]="'editor.addresses.empty.description' | transloco"
      (pageChange)="page.set($event)"
      (retry)="reload()"
    >
      <ng-template ofListRow let-row>
        @let a = item(row);
        <div
          class="flex min-w-0 items-center justify-between gap-2 px-2 py-1.5"
          [attr.data-address-row]="
            a.attributes.product + '/' + a.attributes.variant
          "
        >
          <span class="min-w-0 text-[0.8125rem] break-words">{{
            rowLabel(a)
          }}</span>
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            class="shrink-0"
            [attr.aria-label]="
              'editor.addresses.openLabel' | transloco: { name: rowLabel(a) }
            "
            (click)="show(a)"
          >
            <ng-icon
              name="lucideQrCode"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.addresses.open' | transloco }}
          </button>
        </div>
      </ng-template>
    </of-list-frame>
    <of-stable-address-dialog
      [(open)]="open"
      [name]="shownName()"
      [address]="shown()"
    />
  `,
})
export class StableAddressesCardComponent {
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  readonly manualId = input.required<string>();
  readonly lang = input.required<string>();
  /** The manual's title, for the dialog's heading. */
  readonly title = input('');
  /** A variant's label by its slug; the slug when it has none. */
  readonly variantLabel = input<(slug: string) => string>((slug) => slug);
  /** A product's label by its ID (the product facet's value); the ID when it has none. */
  readonly productLabel = input<(id: string) => string>((id) => id);

  protected readonly page = signal(1);
  protected readonly doc = signal<StableAddressDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly open = signal(false);
  protected readonly shown = signal<ShownAddress | null>(null);
  protected readonly shownName = signal('');
  private runs = 0;

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    // Another manual or language starts on the first page.
    effect(() => {
      this.manualId();
      this.lang();
      untracked(() => this.page.set(1));
    });
    effect(() => {
      const request = {
        manual: this.manualId(),
        lang: this.lang(),
        page: this.page(),
      };
      this.reloads();
      untracked(() => void this.load(request));
    });
  }

  protected item(row: unknown): StableAddressItem {
    return row as StableAddressItem;
  }

  /** "North · Large · English". */
  protected rowLabel(a: StableAddressItem): string {
    return [
      this.productLabel()(a.attributes.product),
      this.variantLabel()(a.attributes.variant),
      languageName(this.language.locale(), a.attributes.lang),
    ].join(' · ');
  }

  protected show(a: StableAddressItem): void {
    const doc = this.doc();
    if (!doc) return;
    this.shown.set({ item: a, settings: settingsOf(doc) });
    this.shownName.set(
      this.title() ? `${this.title()}, ${this.rowLabel(a)}` : this.rowLabel(a),
    );
    this.open.set(true);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  private async load(request: {
    manual: string;
    lang: string;
    page: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/stable-addresses', {
          query: {
            'filter[manual]': request.manual,
            'filter[lang]': request.lang,
            ...pageQuery({ number: request.page, size: ADDRESS_PAGE_SIZE }),
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
