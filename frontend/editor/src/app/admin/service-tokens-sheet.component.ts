import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy, lucideTriangleAlert } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import {
  DatePipe,
  injectTranslate,
  RelativeTimePipe,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { apiErrorText } from '../i18n';
import {
  DEFAULT_TOKEN_LIFETIME,
  expiryOf,
  type ServiceAccountItem,
  type ServiceTokenItem,
  TOKEN_LIFETIMES,
  TOKEN_NAME_MAX,
  TOKEN_PAGE_SIZE,
  type TokenLifetime,
  tokenState,
} from './service-accounts-model';
import { SandboxSession } from '../sandbox/sandbox-session';
import { SandboxNoteComponent } from '../sandbox/sandbox-note.component';

type TokenDoc = Response<'/service-accounts/{serviceAccountId}/tokens'>;

/** A token just issued, shown this once. Lives only while the sheet is open. */
interface Issued {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string;
  readonly token: string;
}

/**
 * A service account's tokens, in a sheet: each one's name, ID (its public part), expiry, last
 * use and state, newest first, paged; "Issue token" (a name and how long it lasts) and Revoke.
 *
 * A new token is shown **once**: in this sheet, with Copy, until Done or the sheet closes. It is
 * kept in one signal of this component only, never in the address, storage, a log or a toast,
 * and cleared when the sheet closes or the component goes. The API cannot show it again, and a
 * revoked token cannot come back (no undo), so Revoke asks first.
 */
@Component({
  selector: 'of-service-tokens-sheet',
  imports: [
    SandboxNoteComponent,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    DatePipe,
    RelativeTimePipe,
    ListFrameComponent,
    ListRowDirective,
    SegmentedComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSheetImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCheck, lucideCopy, lucideTriangleAlert }),
  ],
  template: `
    <z-sheet
      zSide="right"
      zSize="lg"
      class="overflow-y-auto"
      [zMaskClosable]="!issued()"
      [zCloseOnNavigation]="false"
      [(zVisible)]="open"
    >
      <z-sheet-header>
        <z-sheet-title>{{
          'editor.admin.serviceAccounts.tokens.title'
            | transloco: { name: account()?.attributes?.name ?? '' }
        }}</z-sheet-title>
        <z-sheet-description>{{
          'editor.admin.serviceAccounts.tokens.description' | transloco
        }}</z-sheet-description>
      </z-sheet-header>

      <div class="flex min-w-0 flex-col gap-4 px-4 pb-6">
        @if (issued(); as once) {
          <section
            class="border-warning/40 bg-warning-muted animate-in fade-in-0 flex min-w-0 flex-col gap-3 rounded-xl border p-4 duration-300 motion-reduce:animate-none"
            aria-labelledby="issued-title"
          >
            <h3
              id="issued-title"
              class="text-foreground m-0 flex items-center gap-2 text-sm font-medium"
            >
              <ng-icon
                name="lucideTriangleAlert"
                class="text-warning shrink-0"
                aria-hidden="true"
              />
              {{ 'editor.admin.serviceAccounts.issued.title' | transloco }}
            </h3>
            <p class="text-foreground m-0 text-sm break-words">
              {{
                'editor.admin.serviceAccounts.issued.once'
                  | transloco
                    : {
                        name: once.name,
                        expires: once.expiresAt | ofDate,
                      }
              }}
            </p>
            <code
              id="issued-token"
              class="bg-background border-border block rounded-md border p-3 font-mono text-xs break-all select-all"
              [attr.aria-label]="
                'editor.admin.serviceAccounts.issued.tokenLabel' | transloco
              "
              >{{ once.token }}</code
            >
            <div class="flex flex-wrap items-center gap-2">
              <button z-button type="button" (click)="copy()">
                <ng-icon
                  [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {{
                  (copied()
                    ? 'editor.admin.serviceAccounts.issued.copied'
                    : 'editor.admin.serviceAccounts.issued.copy'
                  ) | transloco
                }}
              </button>
              <button
                z-button
                zType="outline"
                type="button"
                (click)="dismissIssued()"
              >
                {{ 'editor.admin.serviceAccounts.issued.done' | transloco }}
              </button>
              <span class="sr-only" aria-live="polite">{{
                copied()
                  ? ('editor.admin.serviceAccounts.issued.copied' | transloco)
                  : ''
              }}</span>
            </div>
          </section>
        }

        @if (sandbox.on()) {
          <!-- A public sandbox issues no tokens (issue 826): nothing outside may reach it. -->
          <of-sandbox-note [text]="'editor.sandbox.tokensOff' | transloco" />
        } @else {
          <div class="flex flex-wrap items-center gap-2">
            <button
              z-button
              zType="outline"
              type="button"
              [zDisabled]="!!deactivated() || formOpen()"
              [attr.aria-describedby]="
                deactivated() ? 'issue-blocked-reason' : null
              "
              (click)="openForm()"
            >
              {{ 'editor.admin.serviceAccounts.tokens.issue' | transloco }}
            </button>
            @if (deactivated()) {
              <span
                id="issue-blocked-reason"
                class="text-muted-foreground text-xs break-words"
                >{{
                  'editor.admin.serviceAccounts.tokens.deactivated' | transloco
                }}</span
              >
            }
          </div>
        }

        <of-collapse [open]="formOpen()">
          <form
            id="token-form"
            class="border-border flex min-w-0 flex-col gap-4 rounded-xl border p-4"
            novalidate
            (submit)="issue($event)"
          >
            <div class="flex flex-col gap-1.5">
              <label class="text-sm" for="token-name">{{
                'editor.admin.serviceAccounts.tokens.name' | transloco
              }}</label>
              <input
                id="token-name"
                z-input
                autocomplete="off"
                required
                [attr.maxlength]="tokenNameMax"
                [attr.aria-invalid]="nameProblem() ? 'true' : null"
                aria-describedby="token-name-hint"
                [value]="tokenName()"
                (input)="tokenName.set($any($event.target).value)"
              />
              <p
                id="token-name-hint"
                class="text-muted-foreground m-0 text-xs break-words"
                [class.text-destructive]="nameProblem()"
              >
                {{
                  (nameProblem()
                    ? 'editor.admin.serviceAccounts.tokens.nameProblem'
                    : 'editor.admin.serviceAccounts.tokens.nameHint'
                  ) | transloco
                }}
              </p>
            </div>
            <div class="flex flex-col gap-1.5">
              <of-segmented
                [label]="
                  'editor.admin.serviceAccounts.tokens.lifetime' | transloco
                "
                [options]="lifetimeOptions()"
                [value]="lifetime().toString()"
                (valueChange)="setLifetime($event)"
              />
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{
                  'editor.admin.serviceAccounts.tokens.expiresOn'
                    | transloco: { date: expiryPreview() | ofDate }
                }}
              </p>
            </div>
            @if (issueError(); as message) {
              <p
                class="text-destructive m-0 text-sm break-words"
                role="alert"
                aria-live="assertive"
              >
                {{ message }}
              </p>
            }
            <div class="flex justify-end gap-2">
              <button
                z-button
                zType="ghost"
                type="button"
                (click)="closeForm()"
              >
                {{ 'editor.admin.cancel' | transloco }}
              </button>
              <button
                z-button
                type="submit"
                [zDisabled]="issuing()"
                [zLoading]="issuing()"
              >
                {{ 'editor.admin.serviceAccounts.tokens.create' | transloco }}
              </button>
            </div>
          </form>
        </of-collapse>

        <of-list-frame
          class="min-w-0"
          [label]="'editor.admin.serviceAccounts.tokens.label' | transloco"
          [items]="doc()?.data ?? []"
          [page]="doc()?.meta?.page ?? null"
          [loading]="loading()"
          [error]="frameError()"
          [skeletonRows]="3"
          offset="16rem"
          [emptyTitle]="'editor.admin.serviceAccounts.tokens.empty' | transloco"
          [emptyDescription]="
            'editor.admin.serviceAccounts.tokens.emptyDescription' | transloco
          "
          (pageChange)="page.set($event)"
          (retry)="reload()"
        >
          <ng-template ofListRow let-item>
            @let token = asToken(item);
            @let state = stateOf(token);
            <div class="flex min-w-0 items-start gap-3 px-3 py-2.5">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex min-w-0 flex-wrap items-center gap-2">
                  <span class="text-sm font-medium break-words">{{
                    token.attributes.name
                  }}</span>
                  @switch (state) {
                    @case ('revoked') {
                      <z-badge zType="destructive">{{
                        'editor.admin.serviceAccounts.tokens.state.revoked'
                          | transloco
                      }}</z-badge>
                    }
                    @case ('expired') {
                      <z-badge zType="secondary">{{
                        'editor.admin.serviceAccounts.tokens.state.expired'
                          | transloco
                      }}</z-badge>
                    }
                    @default {
                      <z-badge zType="success">{{
                        'editor.admin.serviceAccounts.tokens.state.active'
                          | transloco
                      }}</z-badge>
                    }
                  }
                </span>
                <span
                  class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]"
                  >{{ token.id }}</span
                >
                <span class="text-muted-foreground text-xs break-words">
                  @if (token.attributes.revokedAt; as revokedAt) {
                    {{
                      'editor.admin.serviceAccounts.tokens.revokedOn'
                        | transloco: { date: revokedAt | ofDate }
                    }}
                  } @else {
                    {{
                      (state === 'expired'
                        ? 'editor.admin.serviceAccounts.tokens.expiredOn'
                        : 'editor.admin.serviceAccounts.tokens.expiresOn'
                      )
                        | transloco
                          : { date: token.attributes.expiresAt | ofDate }
                    }}
                  }
                  ·
                  @if (token.attributes.lastUsedAt; as lastUsedAt) {
                    {{
                      'editor.admin.serviceAccounts.tokens.lastUsed'
                        | transloco: { when: lastUsedAt | ofRelativeTime }
                    }}
                  } @else {
                    {{
                      'editor.admin.serviceAccounts.tokens.neverUsed'
                        | transloco
                    }}
                  }
                </span>
              </span>
              @if (state === 'active') {
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  class="text-destructive shrink-0"
                  [zLoading]="revoking() === token.id"
                  [zDisabled]="revoking() !== null"
                  [attr.aria-label]="
                    'editor.admin.serviceAccounts.tokens.revokeLabel'
                      | transloco: { name: token.attributes.name }
                  "
                  (click)="revoke(token)"
                >
                  {{ 'editor.admin.serviceAccounts.tokens.revoke' | transloco }}
                </button>
              }
            </div>
          </ng-template>
        </of-list-frame>
      </div>
    </z-sheet>
  `,
})
export class ServiceTokensSheetComponent {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly t = injectTranslate();

  readonly open = model(false);
  /** Whose tokens are shown. */
  readonly account = input<ServiceAccountItem | null>(null);

  protected readonly tokenNameMax = TOKEN_NAME_MAX;
  protected readonly doc = signal<TokenDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  protected readonly page = signal(1);
  private readonly reloads = signal(0);
  private runs = 0;

  protected readonly formOpen = signal(false);
  protected readonly tokenName = signal('');
  protected readonly lifetime = signal<TokenLifetime>(DEFAULT_TOKEN_LIFETIME);
  private readonly submitted = signal(false);
  protected readonly issuing = signal(false);
  protected readonly issueError = signal('');
  /** The token just issued; null once Done or the sheet closed. */
  protected readonly issued = signal<Issued | null>(null);
  protected readonly copied = signal(false);
  /** The token a revocation is under way for. */
  protected readonly revoking = signal<string | null>(null);

  /** The account's ID: a reread of the same account (a new object) is no change. */
  private readonly accountId = computed(() => this.account()?.id);
  protected readonly deactivated = computed(
    () => this.account()?.attributes.deactivatedAt ?? null,
  );
  protected readonly nameProblem = computed(
    () => this.submitted() && this.tokenName().trim() === '',
  );
  protected readonly expiryPreview = computed(() => expiryOf(this.lifetime()));
  protected readonly lifetimeOptions = computed((): SegmentedOption[] =>
    TOKEN_LIFETIMES.map((days) => ({
      value: days.toString(),
      label: this.t('editor.admin.serviceAccounts.tokens.days', { days }),
    })),
  );
  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    // Another account, or the sheet opened or closed: its first page, the form closed, and a
    // token just issued forgotten (never shown under another account, never kept past a close).
    effect(() => {
      const id = this.accountId();
      const open = this.open();
      untracked(() => {
        this.page.set(1);
        this.resetForm();
        this.forget();
        if (!open || !id) this.doc.set(null);
      });
    });
    effect(() => {
      const id = this.accountId();
      const page = this.page();
      this.reloads();
      if (!this.open() || !id) return;
      untracked(() => void this.load(id, page));
    });
    // The token never outlives the screen.
    inject(DestroyRef).onDestroy(() => this.forget());
  }

  protected asToken(item: unknown): ServiceTokenItem {
    return item as ServiceTokenItem;
  }

  protected stateOf(token: ServiceTokenItem) {
    return tokenState(token);
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected setLifetime(value: string): void {
    const days = TOKEN_LIFETIMES.find((d) => d.toString() === value);
    if (days) this.lifetime.set(days);
  }

  protected openForm(): void {
    this.resetForm();
    this.formOpen.set(true);
    queueMicrotask(() => document.getElementById('token-name')?.focus());
  }

  protected closeForm(): void {
    this.formOpen.set(false);
  }

  protected dismissIssued(): void {
    this.forget();
  }

  protected async copy(): Promise<void> {
    const once = this.issued();
    if (!once) return;
    try {
      await navigator.clipboard.writeText(once.token);
      this.copied.set(true);
    } catch {
      // No clipboard (an insecure origin, a refused permission): select it for copying by hand.
      const code = document.getElementById('issued-token');
      const selection = window.getSelection();
      if (code && selection) {
        selection.selectAllChildren(code);
      }
      this.toast.error(
        translated('editor.admin.serviceAccounts.issued.copyFailed'),
      );
    }
  }

  protected async issue(event: Event): Promise<void> {
    event.preventDefault();
    this.submitted.set(true);
    const account = this.account();
    const name = this.tokenName().trim().replace(/\s+/g, ' ');
    if (!account || !name || this.issuing()) return;
    this.issuing.set(true);
    this.issueError.set('');
    try {
      const doc = await firstValueFrom(
        this.api.post(
          '/service-accounts/{serviceAccountId}/tokens',
          {
            data: {
              type: 'ServiceToken',
              attributes: { name, expiresAt: expiryOf(this.lifetime()) },
            },
          },
          { path: { serviceAccountId: account.id } },
        ),
      );
      // The sheet may have closed (or moved to another account) meanwhile: then the token is
      // dropped, never shown for the wrong account. It stays listed and can be revoked.
      if (!this.open() || this.accountId() !== account.id) return;
      this.copied.set(false);
      this.issued.set({
        id: doc.data.id,
        name: doc.data.attributes.name,
        expiresAt: doc.data.attributes.expiresAt,
        token: doc.meta.token,
      });
      this.formOpen.set(false);
      this.page.set(1);
      this.reload();
    } catch (error) {
      if (!this.open() || this.accountId() !== account.id) return;
      const text = apiErrorText(toApiError(error));
      this.issueError.set(this.t(text.key, text.params));
    } finally {
      this.issuing.set(false);
    }
  }

  protected revoke(token: ServiceTokenItem): void {
    const name = token.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.serviceAccounts.revoke.title', { name }),
      zDescription: this.t('editor.admin.serviceAccounts.revoke.description'),
      zOkText: this.t('editor.admin.serviceAccounts.tokens.revoke'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runRevoke(token),
    });
  }

  private async runRevoke(token: ServiceTokenItem): Promise<void> {
    const account = this.account();
    if (!account) return;
    this.revoking.set(token.id);
    try {
      const doc = await firstValueFrom(
        this.api.act(
          '/service-accounts/{serviceAccountId}/tokens/{tokenId}/revoke',
          {
            path: { serviceAccountId: account.id, tokenId: token.id },
          },
        ),
      );
      // The token just shown is dead now: no reason to keep it on screen.
      if (this.issued()?.id === doc.data.id) this.forget();
      this.toast.success(
        translated('editor.admin.serviceAccounts.revoke.done', {
          name: token.attributes.name,
        }),
      );
      if (!this.current(account.id)) return;
      // Shown revoked at once, then read again.
      const list = this.doc();
      if (list) {
        this.doc.set({
          ...list,
          data: list.data.map((t) => (t.id === doc.data.id ? doc.data : t)),
        });
      }
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.revoking.set(null);
    }
  }

  /** Whether the sheet is open on this account. */
  private current(id: string): boolean {
    return this.open() && this.accountId() === id;
  }

  private resetForm(): void {
    this.formOpen.set(false);
    this.tokenName.set('');
    this.lifetime.set(DEFAULT_TOKEN_LIFETIME);
    this.submitted.set(false);
    this.issueError.set('');
  }

  /** Drops the token just issued: it is not kept past this. */
  private forget(): void {
    this.issued.set(null);
    this.copied.set(false);
  }

  private async load(id: string, page: number): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/service-accounts/{serviceAccountId}/tokens', {
          path: { serviceAccountId: id },
          query: pageQuery({ number: page, size: TOKEN_PAGE_SIZE }),
        }),
      );
      // A late answer for an account no longer shown is dropped.
      if (run === this.runs && this.current(id)) this.doc.set(doc);
    } catch (error) {
      if (run === this.runs && this.current(id))
        this.failure.set(toApiError(error));
    } finally {
      if (run === this.runs) this.loading.set(false);
    }
  }
}
