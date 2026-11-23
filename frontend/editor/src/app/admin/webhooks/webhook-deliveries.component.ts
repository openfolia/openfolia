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
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideRotateCcw,
  lucideSend,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  DatePipe,
  injectTranslate,
  RelativeTimePipe,
  translated,
} from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import {
  DELIVERY_EVENTS,
  DELIVERY_PAGE_SIZE,
  DELIVERY_STATUSES,
  type DeliveryError,
  type DeliveryEvent,
  type DeliveryItem,
  ERROR_TEXT,
  STATUS_TEXT,
  type DeliveryStatus,
  deliveryTone,
  prettyJson,
  type WebhookItem,
  webhookErrorText,
} from './webhooks-model';

type DeliveryDoc = Response<'/webhooks/{webhookId}/deliveries'>;

/** The log's filters and page, as the address holds them. */
export interface DeliveryView {
  readonly status: DeliveryStatus | undefined;
  readonly event: DeliveryEvent | undefined;
  readonly page: number;
}

/** What "Send test event" last did, shown under the header. */
type TestResult =
  | { readonly kind: 'sent'; readonly delivery: DeliveryItem }
  | { readonly kind: 'busy'; readonly seconds: number }
  | { readonly kind: 'error'; readonly message: string };

/** The select's value for "every event". */
const ALL = '*';

/**
 * A subscriber's delivery log (#254), beside the list: each delivery's event, result and time,
 * newest first, paged, filtered by event and result (in the address). A row opens to its
 * details: when, the status code, attempts, the error, the headers it was sent with (the
 * signature is made anew for every attempt and not kept, so it is described, never shown) and
 * its body, which the API gives only to the owner it was made for (or a reader covering any
 * owner's): to anyone else it says it is not shown to them. A failed delivery has Retry; "Send
 * test event" sends a signed `ping` at once and shows its result inline.
 */
@Component({
  selector: 'of-webhook-deliveries',
  imports: [
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    DatePipe,
    RelativeTimePipe,
    ListFrameComponent,
    ListRowDirective,
    SegmentedComponent,
    ZardButtonComponent,
    ZardSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideChevronDown, lucideRotateCcw, lucideSend }),
  ],
  host: {
    class:
      'border-border bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4',
  },
  template: `
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <h2
        id="webhook-log-title"
        class="m-0 min-w-0 flex-1 text-sm leading-6 font-medium break-words"
      >
        {{ 'editor.admin.webhooks.log.title' | transloco: { name: name() } }}
      </h2>
      <button
        z-button
        zType="ghost"
        zSize="sm"
        type="button"
        data-slot="webhook-test"
        [zLoading]="testing()"
        [zDisabled]="testing()"
        (click)="sendTest()"
      >
        <ng-icon
          name="lucideSend"
          data-icon="inline-start"
          strokeWidth="1.5"
          aria-hidden="true"
        />
        {{ 'editor.admin.webhooks.log.test' | transloco }}
      </button>
    </div>

    <div aria-live="polite" class="min-w-0">
      @if (testResult(); as r) {
        <p
          data-slot="webhook-test-result"
          class="animate-in fade-in-0 m-0 flex min-w-0 items-start gap-2 rounded-md px-2.5 py-2 text-xs break-words duration-200 motion-reduce:animate-none"
          [class.bg-success-muted]="
            r.kind === 'sent' && r.delivery.attributes.status === 'succeeded'
          "
          [class.bg-destructive-muted]="
            r.kind !== 'sent' || r.delivery.attributes.status !== 'succeeded'
          "
        >
          @switch (r.kind) {
            @case ('sent') {
              {{
                (r.delivery.attributes.status === 'succeeded'
                  ? 'editor.admin.webhooks.log.testSucceeded'
                  : 'editor.admin.webhooks.log.testFailed'
                )
                  | transloco
                    : {
                        code: r.delivery.attributes.lastStatusCode ?? '-',
                        error: errorText(r.delivery.attributes.lastError),
                      }
              }}
            }
            @case ('busy') {
              {{
                'editor.admin.webhooks.log.testBusy'
                  | transloco: { seconds: r.seconds }
              }}
            }
            @case ('error') {
              {{ r.message }}
            }
          }
        </p>
      }
    </div>

    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <of-segmented
        class="max-w-full overflow-x-auto"
        [label]="'editor.admin.webhooks.log.result' | transloco"
        [options]="statusOptions()"
        [value]="view().status ?? ''"
        (valueChange)="setStatus($event)"
      />
      <z-select
        class="w-full sm:w-52"
        zPosition="popper"
        [zAriaLabel]="'editor.admin.webhooks.log.event' | transloco"
        [zValue]="view().event ?? all"
        (zSelectionChange)="setEvent($event)"
      >
        <z-select-item [zValue]="all">{{
          'editor.admin.webhooks.log.allEvents' | transloco
        }}</z-select-item>
        @for (e of events; track e) {
          <z-select-item [zValue]="e">{{ e }}</z-select-item>
        }
      </z-select>
    </div>

    <of-list-frame
      class="min-w-0"
      [label]="'editor.admin.webhooks.log.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [skeletonRows]="5"
      [offset]="offset()"
      [emptyTitle]="
        (filtered()
          ? 'editor.admin.webhooks.log.emptyFiltered'
          : 'editor.admin.webhooks.log.empty'
        ) | transloco
      "
      [emptyDescription]="
        'editor.admin.webhooks.log.emptyDescription' | transloco
      "
      (pageChange)="viewChange.emit({ page: $event })"
      (retry)="reload()"
    >
      <ng-template ofListRow let-item>
        @let d = asDelivery(item);
        @let tone = toneOf(d);
        <div class="flex min-w-0 flex-col" data-slot="webhook-delivery">
          <button
            type="button"
            class="hover:bg-muted/60 focus-visible:ring-ring/50 -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start outline-none focus-visible:ring-[3px]"
            [attr.aria-expanded]="openRow() === d.id"
            [attr.aria-controls]="'delivery-' + d.id"
            (click)="toggle(d.id)"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              [class.bg-success]="tone === 'success'"
              [class.bg-warning]="tone === 'warning'"
              [class.bg-destructive]="tone === 'destructive'"
              [class.bg-muted-foreground]="tone === 'muted'"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 font-mono text-[0.8125rem] break-all">{{
              d.attributes.event
            }}</span>
            <span
              class="text-muted-foreground shrink-0 text-end text-xs whitespace-nowrap"
            >
              {{ statusText[d.attributes.status] | transloco }}
              @if (d.attributes.lastStatusCode !== null) {
                · {{ d.attributes.lastStatusCode }}
              }
              · {{ d.attributes.createdAt | ofRelativeTime }}
            </span>
            <ng-icon
              name="lucideChevronDown"
              class="text-muted-foreground shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              [class.rotate-180]="openRow() === d.id"
              aria-hidden="true"
            />
          </button>
          <of-collapse [open]="openRow() === d.id">
            <div
              [id]="'delivery-' + d.id"
              class="flex min-w-0 flex-col gap-2 pt-2 pb-1 text-xs"
            >
              <dl
                class="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
              >
                <dt class="text-muted-foreground">
                  {{ 'editor.admin.webhooks.log.time' | transloco }}
                </dt>
                <dd class="m-0 break-words">
                  {{ d.attributes.createdAt | ofDate: dateTime }}
                </dd>
                <dt class="text-muted-foreground">
                  {{ 'editor.admin.webhooks.log.statusCode' | transloco }}
                </dt>
                <dd class="m-0 break-words">
                  {{ d.attributes.lastStatusCode ?? '-' }}
                  @if (d.attributes.lastError) {
                    · {{ errorText(d.attributes.lastError) }}
                  }
                </dd>
                <dt class="text-muted-foreground">
                  {{ 'editor.admin.webhooks.log.attempts' | transloco }}
                </dt>
                <dd class="m-0 break-words">
                  {{ d.attributes.attempts }}
                  @if (d.attributes.lastAttemptAt; as at) {
                    ·
                    {{
                      'editor.admin.webhooks.log.lastAttempt'
                        | transloco: { when: at | ofDate: dateTime }
                    }}
                  }
                </dd>
                <dt class="text-muted-foreground">
                  {{ 'editor.admin.webhooks.log.next' | transloco }}
                </dt>
                <dd class="m-0 break-words">
                  {{ nextText(d) | transloco }}
                </dd>
              </dl>
              <div class="flex min-w-0 flex-col gap-1">
                <span class="text-muted-foreground">{{
                  'editor.admin.webhooks.log.headers' | transloco
                }}</span>
                <pre
                  class="bg-muted m-0 rounded-md p-2 font-mono text-[0.6875rem] leading-4 break-all whitespace-pre-wrap"
                  >{{ headersText(d) }}</pre>
                <span class="text-muted-foreground break-words">{{
                  'editor.admin.webhooks.log.signature' | transloco
                }}</span>
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <span class="text-muted-foreground">{{
                  'editor.admin.webhooks.log.payload' | transloco
                }}</span>
                @if (d.attributes.payload; as payload) {
                  <pre
                    data-slot="webhook-payload"
                    class="bg-muted m-0 max-h-64 overflow-auto rounded-md p-2 font-mono text-[0.6875rem] leading-4 break-all whitespace-pre-wrap"
                    >{{ json(payload) }}</pre>
                } @else {
                  <p
                    data-slot="webhook-payload-hidden"
                    class="text-muted-foreground m-0 break-words italic"
                  >
                    {{ 'editor.admin.webhooks.log.notShown' | transloco }}
                  </p>
                }
              </div>
              @if (
                d.attributes.status === 'failed' &&
                d.attributes.event !== 'ping'
              ) {
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    z-button
                    zType="outline"
                    zSize="sm"
                    type="button"
                    data-slot="webhook-retry"
                    [zLoading]="retrying() === d.id"
                    [zDisabled]="retrying() !== null"
                    (click)="retry(d)"
                  >
                    <ng-icon
                      name="lucideRotateCcw"
                      data-icon="inline-start"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    />
                    {{ 'editor.admin.webhooks.log.retry' | transloco }}
                  </button>
                </div>
              }
            </div>
          </of-collapse>
        </div>
      </ng-template>
    </of-list-frame>

    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.webhooks.log.note' | transloco }}
    </p>
  `,
})
export class WebhookDeliveriesComponent {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly t = injectTranslate();

  /** Whose log. */
  readonly webhook = input.required<WebhookItem>();
  /** Its name as the list shows it. */
  readonly name = input('');
  readonly view = input<DeliveryView>({
    status: undefined,
    event: undefined,
    page: 1,
  });
  /** The space above the log's frame (its height cap). */
  readonly offset = input('24rem');
  /** A change of the filters or the page, for the address. */
  readonly viewChange = output<Partial<DeliveryView>>();
  /** A delivery was made or changed here (a test event, a retry): the list's last result moved. */
  readonly changed = output<void>();

  protected readonly events = DELIVERY_EVENTS;
  protected readonly statusText = STATUS_TEXT;
  protected readonly dateTime: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'medium',
  };
  protected readonly all = ALL;
  protected readonly doc = signal<DeliveryDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly openRow = signal<string | null>(null);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<TestResult | null>(null);
  protected readonly retrying = signal<string | null>(null);
  private runs = 0;

  private readonly webhookId = computed(() => this.webhook().id);
  protected readonly filtered = computed(
    () => this.view().status !== undefined || this.view().event !== undefined,
  );
  protected readonly statusOptions = computed((): SegmentedOption[] => [
    { value: '', label: this.t('editor.admin.webhooks.log.all') },
    ...DELIVERY_STATUSES.map((s) => ({
      value: s,
      label: this.t(STATUS_TEXT[s]),
    })),
  ]);
  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = webhookErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    // Another subscriber: nothing of the last one's shows on it.
    effect(() => {
      this.webhookId();
      untracked(() => {
        this.doc.set(null);
        this.openRow.set(null);
        this.testResult.set(null);
        // A test still running for the last one does not hold this one's button.
        this.testing.set(false);
      });
    });
    effect(() => {
      const id = this.webhookId();
      const view = this.view();
      this.reloads();
      untracked(() => void this.load(id, view));
    });
  }

  protected asDelivery(item: unknown): DeliveryItem {
    return item as DeliveryItem;
  }

  protected toneOf(d: DeliveryItem) {
    return deliveryTone(d.attributes);
  }

  /** The headers a delivery is sent with; the signature only by its form (made anew per attempt). */
  protected headersText(d: DeliveryItem): string {
    return [
      `X-Ccms-Delivery: ${d.id}`,
      `X-Ccms-Event: ${d.attributes.event}`,
      `Idempotency-Key: ${d.attributes.idempotencyKey}`,
      'X-Ccms-Signature: t=…,v1=…',
    ].join('\n');
  }

  protected json(value: unknown): string {
    return prettyJson(value);
  }

  protected errorText(error: DeliveryError | null): string {
    return error ? this.t(ERROR_TEXT[error]) : '';
  }

  /** What follows for a delivery: another attempt, or nothing. */
  protected nextText(d: DeliveryItem): string {
    const { status, attempts, event } = d.attributes;
    if (status !== 'pending') {
      return status === 'failed' && event !== 'ping'
        ? 'editor.admin.webhooks.log.nextRetryByHand'
        : 'editor.admin.webhooks.log.nextNone';
    }
    return attempts > 0
      ? 'editor.admin.webhooks.log.nextRetrying'
      : 'editor.admin.webhooks.log.nextFirst';
  }

  protected toggle(id: string): void {
    this.openRow.update((open) => (open === id ? null : id));
  }

  protected setStatus(value: string): void {
    const status = DELIVERY_STATUSES.find((s) => s === value);
    this.viewChange.emit({ status, page: 1 });
  }

  protected setEvent(value: string | string[]): void {
    const raw = Array.isArray(value) ? value[0] : value;
    const event = DELIVERY_EVENTS.find((e) => e === raw);
    this.viewChange.emit({ event, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected async sendTest(): Promise<void> {
    const id = this.webhookId();
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.act('/webhooks/{webhookId}/test', {
          path: { webhookId: id },
        }),
      );
      if (this.webhookId() !== id) return;
      this.testResult.set({ kind: 'sent', delivery: doc.data });
      this.changed.emit();
      // The new delivery leads the first page.
      if (this.view().page === 1) this.reload();
      else this.viewChange.emit({ page: 1 });
    } catch (error) {
      if (this.webhookId() !== id) return;
      const failure = toApiError(error);
      if (failure.status === 429) {
        const seconds = failure.retryAfter ?? 0;
        this.testResult.set({
          kind: 'busy',
          seconds: seconds > 0 ? Math.ceil(seconds) : 30,
        });
      } else {
        const text = webhookErrorText(failure);
        this.testResult.set({
          kind: 'error',
          message: this.t(text.key, text.params),
        });
      }
    } finally {
      if (this.webhookId() === id) this.testing.set(false);
    }
  }

  protected async retry(delivery: DeliveryItem): Promise<void> {
    const id = this.webhookId();
    this.retrying.set(delivery.id);
    try {
      const doc = await firstValueFrom(
        this.api.act('/webhooks/{webhookId}/deliveries/{deliveryId}/retry', {
          path: { webhookId: id, deliveryId: delivery.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.webhooks.log.retried', {
          event: delivery.attributes.event,
        }),
      );
      if (this.webhookId() !== id) return;
      // Shown pending at once, then read again.
      const list = this.doc();
      if (list) {
        this.doc.set({
          ...list,
          data: list.data.map((d) => (d.id === doc.data.id ? doc.data : d)),
        });
      }
      this.changed.emit();
      this.reload();
    } catch (error) {
      this.toast.error(webhookErrorText(toApiError(error)));
    } finally {
      this.retrying.set(null);
    }
  }

  private async load(id: string, view: DeliveryView): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/webhooks/{webhookId}/deliveries', {
          path: { webhookId: id },
          query: {
            ...(view.status ? { 'filter[status]': view.status } : {}),
            ...(view.event ? { 'filter[event]': view.event } : {}),
            ...pageQuery({ number: view.page, size: DELIVERY_PAGE_SIZE }),
          },
        }),
      );
      if (run === this.runs && this.webhookId() === id) this.doc.set(doc);
    } catch (error) {
      if (run === this.runs && this.webhookId() === id)
        this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
