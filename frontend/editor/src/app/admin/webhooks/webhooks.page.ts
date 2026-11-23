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
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideKeyRound,
  lucidePause,
  lucidePencil,
  lucidePlay,
  lucideTrash2,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import {
  injectTranslate,
  RelativeTimePipe,
  translated,
} from '@openfolia/ui/i18n';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import type { StoredConfig } from '../../content/browser-model';
import { labelsInUi } from '../../i18n';
import { MeService } from '../../permissions/me';
import {
  idParam,
  injectQueryState,
  intParam,
  oneOfParam,
} from '../../view-state';
import { injectAdminActions } from '../admin-actions';
import {
  type AudienceOption,
  WebhookDialogComponent,
} from './webhook-dialog.component';
import {
  type DeliveryView,
  WebhookDeliveriesComponent,
} from './webhook-deliveries.component';
import { WebhookDeletion } from './webhook-deletion';
import {
  type ShownSecret,
  WebhookSecretDialogComponent,
} from './webhook-secret-dialog.component';
import {
  audiencesUpTo,
  DELIVERY_EVENTS,
  DELIVERY_STATUSES,
  deliveryTone,
  headerApiErrors,
  type HeaderApiError,
  headersBody,
  headersChanged,
  mayReshape,
  mayRotate,
  owns,
  STATUS_TEXT,
  urlProblemText,
  type WebhookDraft,
  type WebhookItem,
  webhookName,
  WEBHOOK_PAGE_SIZES,
  webhookState,
  webhookErrorText,
} from './webhooks-model';

type WebhookDoc = Response<'/webhooks'>;

/** Space kept below the list frame: the note under it and the page's bottom padding. */
const BELOW_FRAME_PX = 72;

/** A subscriber's ID is a UUID (version 7). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Webhooks tab of Admin (#254, screen 22): the systems that hear of releases, deprecations
 * and imports. On the left the subscribers, paged, as cards: name, URL (wrapping), events, the
 * audience limit, the state (Active, Paused, Failing: a badge with its word, never by colour
 * alone) and the last delivery's result; on the right the chosen one's delivery log with "Send
 * test event" and Retry (`WebhookDeliveriesComponent`). "Add subscriber" (the header's action)
 * and Edit open the form; a new subscriber's secret, and a rotated one, is shown once
 * (`WebhookSecretDialogComponent`). Pause and resume at once; a subscriber turned off after
 * failing offers Re-enable. Rotation cannot be undone, so it asks first; Delete does not ask,
 * it offers Undo (`WebhookDeletion`). The page, the chosen subscriber and the log's filters and
 * page are in the address; a secret never is.
 *
 * Only the API decides who sees what: a subscriber the actor may not see is not in the list.
 * What the actor may change of another's subscriber (`mayReshape`, `mayRotate`) only decides
 * what is offered; the API checks again.
 */
@Component({
  selector: 'of-webhooks-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListRowDirective,
    RelativeTimePipe,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDropdownImports,
    WebhookDialogComponent,
    WebhookDeliveriesComponent,
    WebhookSecretDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideEllipsis,
      lucideKeyRound,
      lucidePause,
      lucidePencil,
      lucidePlay,
      lucideTrash2,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start"
    >
      <of-list-frame
        #frame
        cards
        class="min-h-64 min-w-0"
        [label]="'editor.admin.webhooks.list.label' | transloco"
        [items]="items()"
        [page]="doc()?.meta?.page ?? null"
        [loading]="loading()"
        [error]="frameError()"
        [offset]="offset()"
        [skeletonRows]="3"
        [pageSizes]="pageSizes"
        [emptyTitle]="'editor.admin.webhooks.list.empty' | transloco"
        [emptyDescription]="
          'editor.admin.webhooks.list.emptyDescription' | transloco
        "
        (pageChange)="view.set({ page: $event })"
        (pageSizeChange)="view.set({ size: $event, page: 1 })"
        (retry)="reload()"
      >
        <ng-template ofListRow let-item>
          @let w = asWebhook(item);
          @let state = stateOf(w);
          @let chosen = selected()?.id === w.id;
          <article
            data-slot="webhook-card"
            class="bg-card relative flex min-w-0 flex-col gap-2 rounded-xl border p-4 transition-colors duration-150 motion-reduce:transition-none"
            [class.border-foreground]="chosen"
            [class.border-border]="!chosen"
            [attr.aria-current]="chosen ? 'true' : null"
          >
            <div class="flex min-w-0 items-start gap-2">
              <h3 class="m-0 min-w-0 flex-1 text-sm leading-6 font-medium">
                <button
                  type="button"
                  class="focus-visible:ring-ring/50 max-w-full rounded-sm text-start break-words outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:ring-[3px]"
                  (click)="select(w.id)"
                >
                  {{ nameOf(w) }}
                </button>
              </h3>
              @switch (state) {
                @case ('failing') {
                  <z-badge zType="destructive" class="shrink-0">{{
                    'editor.admin.webhooks.state.failing' | transloco
                  }}</z-badge>
                }
                @case ('paused') {
                  <z-badge zType="secondary" class="shrink-0">{{
                    'editor.admin.webhooks.state.paused' | transloco
                  }}</z-badge>
                }
                @default {
                  <z-badge zType="success" class="shrink-0">{{
                    'editor.admin.webhooks.state.active' | transloco
                  }}</z-badge>
                }
              }
              <button
                z-button
                zType="ghost"
                zSize="icon-sm"
                type="button"
                class="relative z-10 -my-1 shrink-0"
                z-dropdown
                [zDropdownMenu]="menu"
                [attr.aria-label]="
                  'editor.admin.webhooks.actions.menu'
                    | transloco: { name: nameOf(w) }
                "
              >
                <ng-icon name="lucideEllipsis" aria-hidden="true" />
              </button>
              <z-dropdown-menu-content #menu class="w-56">
                <z-dropdown-menu-item data-action="edit" (click)="edit(w)">
                  <ng-icon name="lucidePencil" aria-hidden="true" />
                  {{ 'editor.admin.webhooks.actions.edit' | transloco }}
                </z-dropdown-menu-item>
                @if (state === 'active') {
                  <z-dropdown-menu-item
                    data-action="pause"
                    (click)="setActive(w, false)"
                  >
                    <ng-icon name="lucidePause" aria-hidden="true" />
                    {{ 'editor.admin.webhooks.actions.pause' | transloco }}
                  </z-dropdown-menu-item>
                } @else {
                  <z-dropdown-menu-item
                    data-action="resume"
                    (click)="setActive(w, true)"
                  >
                    <ng-icon name="lucidePlay" aria-hidden="true" />
                    {{
                      (state === 'failing'
                        ? 'editor.admin.webhooks.actions.reenable'
                        : 'editor.admin.webhooks.actions.resume'
                      ) | transloco
                    }}
                  </z-dropdown-menu-item>
                }
                @if (rotates(w)) {
                  <z-dropdown-menu-item
                    data-action="rotate"
                    (click)="rotate(w)"
                  >
                    <ng-icon name="lucideKeyRound" aria-hidden="true" />
                    {{ 'editor.admin.webhooks.actions.rotate' | transloco }}
                  </z-dropdown-menu-item>
                }
                <z-dropdown-menu-item
                  data-action="delete"
                  class="text-destructive"
                  (click)="remove(w)"
                >
                  <ng-icon name="lucideTrash2" aria-hidden="true" />
                  {{ 'editor.admin.webhooks.actions.delete' | transloco }}
                </z-dropdown-menu-item>
              </z-dropdown-menu-content>
            </div>
            <p
              class="text-muted-foreground m-0 font-mono text-xs [overflow-wrap:anywhere]"
            >
              {{ w.attributes.url }}
            </p>
            <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
              @for (e of w.attributes.events; track e) {
                <li>
                  <z-badge zType="secondary" class="font-normal">{{
                    e
                  }}</z-badge>
                </li>
              }
            </ul>
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{
                'editor.admin.webhooks.list.audience'
                  | transloco: { levels: audienceText(w) }
              }}
            </p>
            @if (w.meta.lastDelivery; as last) {
              <p
                data-slot="webhook-last"
                class="text-muted-foreground m-0 flex min-w-0 items-center gap-1.5 text-xs break-words"
              >
                <span
                  class="size-2 shrink-0 rounded-full"
                  [class.bg-success]="toneOf(last) === 'success'"
                  [class.bg-warning]="toneOf(last) === 'warning'"
                  [class.bg-destructive]="toneOf(last) === 'destructive'"
                  [class.bg-muted-foreground]="toneOf(last) === 'muted'"
                  aria-hidden="true"
                ></span>
                <span class="min-w-0">
                  {{
                    'editor.admin.webhooks.list.last'
                      | transloco
                        : {
                            event: last.event,
                            status: statusText[last.status] | transloco,
                            code: last.lastStatusCode ?? '-',
                            when: last.createdAt | ofRelativeTime,
                          }
                  }}
                </span>
              </p>
            } @else {
              <p class="text-muted-foreground m-0 text-xs">
                {{ 'editor.admin.webhooks.list.noDeliveries' | transloco }}
              </p>
            }
            @if (state === 'failing') {
              <div
                class="border-destructive/30 bg-destructive-muted relative z-10 flex min-w-0 flex-wrap items-center gap-2 rounded-md px-3 py-2"
              >
                <p class="m-0 min-w-0 flex-1 text-xs break-words">
                  {{
                    'editor.admin.webhooks.list.failingNote'
                      | transloco: { count: w.meta.consecutiveFailures }
                  }}
                </p>
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  data-slot="webhook-reenable"
                  [zLoading]="acting() === w.id"
                  [zDisabled]="acting() !== null"
                  (click)="setActive(w, true)"
                >
                  {{ 'editor.admin.webhooks.actions.reenable' | transloco }}
                </button>
              </div>
            }
          </article>
        </ng-template>
      </of-list-frame>

      @if (selected(); as w) {
        <of-webhook-deliveries
          class="animate-in fade-in-0 duration-200 motion-reduce:animate-none"
          [webhook]="w"
          [name]="nameOf(w)"
          [view]="logView()"
          [offset]="logOffset()"
          (viewChange)="setLog($event)"
          (changed)="reload()"
        />
      }
    </div>

    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.webhooks.note' | transloco }}
    </p>

    <of-webhook-dialog
      [(open)]="dialogOpen"
      [webhook]="editing()"
      [owned]="editingOwned()"
      [reshape]="editingReshape()"
      [editHeaders]="editingHeaders()"
      [audiences]="audiences()"
      [busy]="saving()"
      [error]="saveError()"
      [headerErrors]="saveHeaderErrors()"
      (save)="save($event)"
    />

    <of-webhook-secret-dialog [(open)]="secretOpen" [shown]="secret()" />
  `,
})
export class WebhooksPage {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly meService = inject(MeService);
  private readonly deletion = inject(WebhookDeletion);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    page: intParam(1),
    size: intParam(WEBHOOK_PAGE_SIZES[0], { only: WEBHOOK_PAGE_SIZES }),
    hook: idParam(UUID),
    status: oneOfParam(DELIVERY_STATUSES),
    event: oneOfParam(DELIVERY_EVENTS),
    log: intParam(1),
  });
  protected readonly pageSizes = WEBHOOK_PAGE_SIZES;
  protected readonly statusText = STATUS_TEXT;

  protected readonly doc = signal<WebhookDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  /** The configured audience levels as read; null until read (or when they could not be). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  private readonly shownConfig = labelsInUi(this.storedConfig);
  /** The audience levels, each by its label in the interface language (#731). */
  protected readonly audienceLevels = computed(
    (): readonly AudienceOption[] | null =>
      this.shownConfig()?.audiences.map((a) => ({
        id: a.id,
        label: a.label,
      })) ?? null,
  );
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<WebhookItem | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  /** The custom headers' problems of the last save, for their rows (#560). */
  protected readonly saveHeaderErrors = signal<readonly HeaderApiError[]>([]);
  protected readonly secretOpen = signal(false);
  /** The secret just made or rotated: kept here only while its dialog is open. */
  protected readonly secret = signal<ShownSecret | null>(null);
  /** The subscriber a pause, resume or rotation is under way for. */
  protected readonly acting = signal<string | null>(null);
  protected readonly offset = signal('16rem');
  protected readonly logOffset = signal('24rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  /** The page's subscribers, less those waiting for their delete. */
  protected readonly items = computed(() => {
    const hidden = this.deletion.hidden();
    return (this.doc()?.data ?? []).filter((w) => !hidden.has(w.id));
  });
  /** The chosen subscriber: the address's, else the first listed. */
  protected readonly selected = computed(() => {
    const items = this.items();
    const hook = this.view.get('hook')();
    return items.find((w) => w.id === hook) ?? items[0] ?? null;
  });
  protected readonly logView = computed((): DeliveryView => ({
    status: this.view.get('status')(),
    event: this.view.get('event')(),
    page: this.view.get('log')(),
  }));
  protected readonly audiences = computed(() => this.audienceLevels() ?? []);
  protected readonly editingOwned = computed(() => {
    const w = this.editing();
    return !w || owns(this.meService.me(), w);
  });
  /** Whether the actor may change the headers of the subscriber in the form (a new one: yes). */
  protected readonly editingHeaders = computed(() => {
    const w = this.editing();
    return !w || mayRotate(this.meService.me(), w);
  });
  protected readonly editingReshape = computed(() => {
    const w = this.editing();
    return !w || mayReshape(this.meService.me(), w);
  });
  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = webhookErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    effect(() => {
      const query = {
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      this.deletion.changed();
      untracked(() => void this.load(query));
    });
    void this.loadAudiences();
    injectAdminActions()?.on('webhooks', () => this.add());
    // The secret never outlives its dialog.
    effect(() => {
      if (!this.secretOpen()) untracked(() => this.secret.set(null));
    });

    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.secret.set(null));
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top));
      this.offset.set(`${top + BELOW_FRAME_PX}px`);
      // The log's frame sits under its header, test result and filters.
      this.logOffset.set(`${top + BELOW_FRAME_PX + 176}px`);
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

  protected asWebhook(item: unknown): WebhookItem {
    return item as WebhookItem;
  }

  protected nameOf(w: WebhookItem): string {
    return webhookName(w);
  }

  protected stateOf(w: WebhookItem) {
    return webhookState(w);
  }

  protected toneOf(last: Parameters<typeof deliveryTone>[0]) {
    return deliveryTone(last);
  }

  protected rotates(w: WebhookItem): boolean {
    return mayRotate(this.meService.me(), w);
  }

  /** The audience levels a subscriber hears of, in words. */
  protected audienceText(w: WebhookItem): string {
    const max = w.attributes.maxAudience;
    if (max === null) return this.t('editor.admin.webhooks.list.allAudiences');
    const levels = this.audienceLevels();
    // Unknown levels (no configuration read): the limit's ID.
    if (levels === null)
      return this.t('editor.admin.webhooks.list.upTo', { level: max });
    const through = audiencesUpTo(levels, max);
    return through.length === 0
      ? this.t('editor.admin.webhooks.list.unknownLevel', { level: max })
      : through.map((a) => a.label).join(', ');
  }

  protected select(id: string): void {
    if (this.selected()?.id === id) return;
    this.view.set({ hook: id, status: undefined, event: undefined, log: 1 });
  }

  protected setLog(change: Partial<DeliveryView>): void {
    this.view.set({
      ...('status' in change && { status: change.status }),
      ...('event' in change && { event: change.event }),
      ...(change.page !== undefined && { log: change.page }),
    });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected add(): void {
    this.editing.set(null);
    this.saveError.set('');
    this.saveHeaderErrors.set([]);
    this.dialogOpen.set(true);
  }

  protected edit(w: WebhookItem): void {
    this.editing.set(w);
    this.saveError.set('');
    this.saveHeaderErrors.set([]);
    this.dialogOpen.set(true);
  }

  protected async save(draft: WebhookDraft): Promise<void> {
    const editing = this.editing();
    this.saving.set(true);
    this.saveError.set('');
    this.saveHeaderErrors.set([]);
    const description = draft.description === '' ? null : draft.description;
    const maxAudience = draft.maxAudience === '' ? null : draft.maxAudience;
    try {
      if (editing) {
        const a = editing.attributes;
        const reshape = mayReshape(this.meService.me(), editing);
        const doc = await firstValueFrom(
          this.api.patch(
            '/webhooks/{webhookId}',
            { path: { webhookId: editing.id } },
            {
              data: {
                type: 'Webhook',
                id: editing.id,
                // Only what changed: an unchanged URL never takes it over, and a manager who
                // may not reshape it sends only its name.
                attributes: {
                  ...(description !== a.description && { description }),
                  ...(reshape && draft.url !== a.url && { url: draft.url }),
                  ...(reshape &&
                    !sameEvents(draft.events, a.events) && {
                      events: [...draft.events],
                    }),
                  ...(reshape &&
                    maxAudience !== a.maxAudience && { maxAudience }),
                  // All of them, only when they changed, or when a new URL needs the secret
                  // values again (the form asked for them).
                  ...((headersChanged(draft.headers, a.headers) ||
                    (reshape &&
                      draft.url !== a.url &&
                      a.headers.length > 0)) && {
                    headers: headersBody(draft.headers),
                  }),
                },
              },
            },
          ),
        );
        this.dialogOpen.set(false);
        this.toast.success(
          translated('editor.admin.webhooks.saved', {
            name: webhookName(doc.data),
          }),
        );
        const me = this.meService.me();
        // Taken over: the old owner's receiver still knows the secret.
        if (!owns(me, editing) && owns(me, doc.data)) {
          this.promptRotate(doc.data);
        }
      } else {
        const doc = await firstValueFrom(
          this.api.post('/webhooks', {
            data: {
              type: 'Webhook',
              attributes: {
                url: draft.url,
                events: [...draft.events],
                description,
                ...(maxAudience !== null && { maxAudience }),
                ...(draft.headers.length > 0 && {
                  headers: headersBody(draft.headers),
                }),
              },
            },
          }),
        );
        this.dialogOpen.set(false);
        this.showSecret({
          name: webhookName(doc.data),
          reason: 'created',
          secret: doc.meta.secret,
        });
        // On the list at once: until it is read again the log would fall back to the first
        // listed one and read its deliveries, which may be gone by then (#603).
        this.append(doc.data);
        this.view.set({ hook: doc.data.id, log: 1 });
      }
      this.reload();
    } catch (error) {
      const failure = toApiError(error);
      const headerErrors = headerApiErrors(failure.errors);
      if (failure.code === 'invalid-url') {
        this.saveError.set(
          this.t(urlProblemText(failure.errors[0]?.meta?.['problem'])),
        );
      } else if (headerErrors) {
        // Each on the row its pointer names, never at the top of the form.
        this.saveHeaderErrors.set(headerErrors);
      } else {
        const text = webhookErrorText(failure);
        this.saveError.set(this.t(text.key, text.params));
      }
    } finally {
      this.saving.set(false);
    }
  }

  protected async setActive(w: WebhookItem, active: boolean): Promise<void> {
    this.acting.set(w.id);
    try {
      const doc = await firstValueFrom(
        this.api.patch(
          '/webhooks/{webhookId}',
          { path: { webhookId: w.id } },
          { data: { type: 'Webhook', id: w.id, attributes: { active } } },
        ),
      );
      this.toast.success(
        translated(
          active
            ? 'editor.admin.webhooks.resumed'
            : 'editor.admin.webhooks.paused',
          { name: webhookName(doc.data) },
        ),
      );
      this.replace(doc.data);
      this.reload();
    } catch (error) {
      this.toast.error(webhookErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  protected rotate(w: WebhookItem): void {
    const name = webhookName(w);
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.webhooks.rotate.title', { name }),
      zDescription: this.t('editor.admin.webhooks.rotate.description'),
      zOkText: this.t('editor.admin.webhooks.actions.rotate'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runRotate(w),
    });
  }

  protected remove(w: WebhookItem): void {
    this.deletion.delete(w.id, webhookName(w));
  }

  /** After a takeover: the secret is still the old owner's, so offer a new one. */
  private promptRotate(w: WebhookItem): void {
    const name = webhookName(w);
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.webhooks.takeover.title', { name }),
      zDescription: this.t('editor.admin.webhooks.takeover.description'),
      zOkText: this.t('editor.admin.webhooks.actions.rotate'),
      zCancelText: this.t('editor.admin.webhooks.takeover.later'),
      zOnOk: () => void this.runRotate(w),
    });
  }

  private async runRotate(w: WebhookItem): Promise<void> {
    this.acting.set(w.id);
    try {
      const doc = await firstValueFrom(
        this.api.act('/webhooks/{webhookId}/secret', {
          path: { webhookId: w.id },
        }),
      );
      this.showSecret({
        name: webhookName(doc.data),
        reason: 'rotated',
        secret: doc.meta.secret,
      });
      this.replace(doc.data);
    } catch (error) {
      this.toast.error(webhookErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  private showSecret(shown: ShownSecret): void {
    this.secret.set(shown);
    this.secretOpen.set(true);
  }

  /** Shows a subscriber's new state at once (its last delivery as listed). */
  private replace(next: WebhookItem): void {
    const list = this.doc();
    if (!list) return;
    this.doc.set({
      ...list,
      data: list.data.map((w) =>
        w.id === next.id
          ? {
              ...next,
              meta: { ...next.meta, lastDelivery: w.meta.lastDelivery },
            }
          : w,
      ),
    });
  }

  /** Shows a subscriber just made at the end of the list (the oldest come first). */
  private append(made: WebhookItem): void {
    const list = this.doc();
    if (!list || list.data.some((w) => w.id === made.id)) return;
    this.doc.set({ ...list, data: [...list.data, made] });
  }

  private async loadAudiences(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      this.storedConfig.set(doc.data.attributes);
    } catch {
      // Levels show as their IDs; the form offers none to choose.
    }
  }

  private async load(query: { page: number; size: number }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/webhooks', {
          query: pageQuery({ number: query.page, size: query.size }),
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

const sameEvents = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((e) => b.includes(e));
