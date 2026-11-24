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
import { lucideSearch } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import { KbdComponent } from '@openfolia/ui/kbd';
import {
  ListFrameComponent,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { SearchShortcutDirective } from '@openfolia/ui/search-shortcut';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardTableImports } from '@openfolia/ui/table';
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
  injectQueryState,
  intParam,
  oneOfParam,
  textParam,
} from '../view-state';
import { injectAdminActions } from './admin-actions';
import type { RoleItem } from './admin-model';
import { loadAllRoles } from './roles-source';
import { ServiceAccountDialogComponent } from './service-account-dialog.component';
import {
  SERVICE_ACCOUNT_PAGE_SIZES,
  SERVICE_ACCOUNT_STATUSES,
  type ServiceAccountDraft,
  type ServiceAccountItem,
  type ServiceAccountStatus,
} from './service-accounts-model';
import { ServiceTokensSheetComponent } from './service-tokens-sheet.component';
import { SandboxSession } from '../sandbox/sandbox-session';

type AccountDoc = Response<'/service-accounts'>;

/** Space kept below the frame: the note under it and the page's bottom padding. */
const BELOW_FRAME_PX = 72;

/**
 * The Service accounts tab of Admin (#289): machine clients (a portal build, a pipeline, an
 * agent) with their description, roles and status; a search (ID, name) and a status filter.
 * "New service account" (the header's action) and Edit open the dialog; Tokens opens the
 * account's tokens (issue, shown once, and revoke); Deactivate asks first, then stops every
 * token of it from its next request on; Reactivate lets them act again. Search, status, page and
 * size are in the address, never a token.
 */
@Component({
  selector: 'of-service-accounts-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    ListFrameComponent,
    ListTableDirective,
    SegmentedComponent,
    SearchShortcutDirective,
    KbdComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardTableImports,
    ServiceAccountDialogComponent,
    ServiceTokensSheetComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSearch })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex flex-wrap items-center gap-3">
      <of-segmented
        [label]="'editor.admin.serviceAccounts.filter.label' | transloco"
        [options]="statusOptions()"
        [value]="status() ?? ''"
        (valueChange)="setStatus($event)"
      />
      <z-input-group class="w-full sm:ms-auto sm:w-72">
        <z-input-group-addon>
          <ng-icon name="lucideSearch" aria-hidden="true" />
        </z-input-group-addon>
        <input
          z-input
          ofSearchShortcut
          type="search"
          autocomplete="off"
          maxlength="200"
          [attr.aria-label]="
            'editor.admin.serviceAccounts.filter.search' | transloco
          "
          [placeholder]="
            'editor.admin.serviceAccounts.filter.search' | transloco
          "
          [value]="search()"
          (input)="view.set({ q: $any($event.target).value, page: 1 })"
        />
        <z-input-group-addon zAlign="inline-end">
          <kbd
            of-kbd
            aria-hidden="true"
            class="transition-opacity duration-150 group-focus-within/input-group:opacity-0 motion-reduce:transition-none"
            [class.opacity-0]="search() !== ''"
            >/</kbd
          >
        </z-input-group-addon>
      </z-input-group>
    </div>

    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      [label]="'editor.admin.serviceAccounts.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (filtered()
          ? 'editor.admin.serviceAccounts.empty.filteredTitle'
          : 'editor.admin.serviceAccounts.empty.title'
        ) | transloco
      "
      [emptyDescription]="
        (filtered()
          ? 'editor.admin.serviceAccounts.empty.filteredDescription'
          : sandbox.on()
            ? 'editor.sandbox.serviceAccountsOff'
            : 'editor.admin.serviceAccounts.empty.description'
        ) | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <!-- Fits the frame from a 1024 px window up; narrower, the frame scrolls it sideways. -->
        <table z-table class="min-w-[40rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[22%]">
                {{ 'editor.admin.serviceAccounts.table.name' | transloco }}
              </th>
              <th z-table-head class="w-[22%]">
                {{
                  'editor.admin.serviceAccounts.table.description' | transloco
                }}
              </th>
              <th z-table-head>
                {{ 'editor.admin.serviceAccounts.table.roles' | transloco }}
              </th>
              <th z-table-head class="w-28">
                {{ 'editor.admin.serviceAccounts.table.status' | transloco }}
              </th>
              <th z-table-head class="w-44 xl:w-60">
                <span class="sr-only">{{
                  'editor.admin.serviceAccounts.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (account of asAccounts(items); track account.id) {
              <tr z-table-row>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="block font-medium break-words">{{
                    account.attributes.name
                  }}</span>
                  <span
                    class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                    >{{ account.id }}</span
                  >
                </td>
                <td
                  z-table-cell
                  class="text-muted-foreground align-top whitespace-normal [overflow-wrap:anywhere]"
                >
                  {{
                    account.attributes.description ??
                      ('editor.admin.serviceAccounts.table.noDescription'
                        | transloco)
                  }}
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="flex flex-wrap gap-1">
                    @for (r of account.relationships.roles.data; track r.id) {
                      <z-badge
                        zType="outline"
                        class="h-auto max-w-full break-words whitespace-normal"
                        >{{ roleName(r.id) }}</z-badge
                      >
                    } @empty {
                      <span class="text-muted-foreground text-sm">{{
                        'editor.admin.serviceAccounts.table.noRoles' | transloco
                      }}</span>
                    }
                  </span>
                </td>
                <td z-table-cell class="align-top">
                  @if (account.attributes.deactivatedAt) {
                    <z-badge zType="secondary">{{
                      'editor.admin.serviceAccounts.status.deactivated'
                        | transloco
                    }}</z-badge>
                  } @else {
                    <z-badge zType="success">{{
                      'editor.admin.serviceAccounts.status.active' | transloco
                    }}</z-badge>
                  }
                </td>
                <td z-table-cell class="text-end align-top">
                  <!-- A label longer than the column wraps inside its button. -->
                  <span
                    class="inline-flex max-w-full flex-wrap justify-end gap-2 [&>button]:h-auto [&>button]:min-h-7 [&>button]:max-w-full [&>button]:py-1 [&>button]:whitespace-normal"
                  >
                    <button
                      z-button
                      zType="outline"
                      zSize="sm"
                      type="button"
                      [attr.aria-label]="
                        'editor.admin.serviceAccounts.actions.tokensLabel'
                          | transloco: { name: account.attributes.name }
                      "
                      (click)="showTokens(account)"
                    >
                      {{
                        'editor.admin.serviceAccounts.actions.tokens'
                          | transloco
                      }}
                    </button>
                    <button
                      z-button
                      zType="outline"
                      zSize="sm"
                      type="button"
                      [attr.aria-label]="
                        'editor.admin.serviceAccounts.actions.editLabel'
                          | transloco: { name: account.attributes.name }
                      "
                      (click)="edit(account)"
                    >
                      {{
                        'editor.admin.serviceAccounts.actions.edit' | transloco
                      }}
                    </button>
                    @if (account.attributes.deactivatedAt) {
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        [zLoading]="acting() === account.id"
                        [zDisabled]="acting() !== null"
                        [attr.aria-label]="
                          'editor.admin.serviceAccounts.actions.reactivateLabel'
                            | transloco: { name: account.attributes.name }
                        "
                        (click)="reactivate(account)"
                      >
                        {{
                          'editor.admin.serviceAccounts.actions.reactivate'
                            | transloco
                        }}
                      </button>
                    } @else {
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        [zLoading]="acting() === account.id"
                        [zDisabled]="acting() !== null"
                        [attr.aria-label]="
                          'editor.admin.serviceAccounts.actions.deactivateLabel'
                            | transloco: { name: account.attributes.name }
                        "
                        (click)="deactivate(account)"
                      >
                        {{
                          'editor.admin.serviceAccounts.actions.deactivate'
                            | transloco
                        }}
                      </button>
                    }
                  </span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>

    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.note' | transloco }}
    </p>

    <of-service-account-dialog
      [(open)]="dialogOpen"
      [account]="editing()"
      [roles]="roles()"
      [busy]="saving()"
      [error]="saveError()"
      (save)="save($event)"
    />

    <of-service-tokens-sheet [(open)]="tokensOpen" [account]="tokensOf()" />
  `,
})
export class ServiceAccountsPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    q: textParam(),
    status: oneOfParam(SERVICE_ACCOUNT_STATUSES),
    page: intParam(1),
    size: intParam(SERVICE_ACCOUNT_PAGE_SIZES[0], {
      only: SERVICE_ACCOUNT_PAGE_SIZES,
    }),
  });
  protected readonly search = this.view.get('q');
  protected readonly status = this.view.get('status');
  protected readonly pageSizes = SERVICE_ACCOUNT_PAGE_SIZES;

  protected readonly doc = signal<AccountDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly roles = signal<readonly RoleItem[]>([]);
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<ServiceAccountItem | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly tokensOpen = signal(false);
  /** The account whose tokens the sheet shows, as last read. */
  protected readonly tokensOf = signal<ServiceAccountItem | null>(null);
  /** The account a deactivation or reactivation is under way for. */
  protected readonly acting = signal<string | null>(null);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly filtered = computed(
    () => this.search() !== '' || this.status() !== undefined,
  );

  protected readonly statusOptions = computed((): SegmentedOption[] => [
    { value: '', label: this.t('editor.admin.serviceAccounts.filter.all') },
    {
      value: 'active',
      label: this.t('editor.admin.serviceAccounts.filter.active'),
    },
    {
      value: 'deactivated',
      label: this.t('editor.admin.serviceAccounts.filter.deactivated'),
    },
  ]);

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  private readonly roleNames = computed(
    () => new Map(this.roles().map((r) => [r.id, r.attributes.name])),
  );

  constructor() {
    effect(() => {
      const query = {
        q: this.search(),
        status: this.status(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });
    void this.loadRoles();
    injectAdminActions()?.on('service-accounts', () => this.add());

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

  protected asAccounts(
    items: readonly unknown[],
  ): readonly ServiceAccountItem[] {
    return items as readonly ServiceAccountItem[];
  }

  protected roleName(id: string): string {
    return this.roleNames().get(id) ?? id;
  }

  protected setStatus(value: string): void {
    const status = SERVICE_ACCOUNT_STATUSES.find((s) => s === value);
    this.view.set({ status, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected add(): void {
    this.editing.set(null);
    this.saveError.set('');
    this.dialogOpen.set(true);
  }

  protected edit(account: ServiceAccountItem): void {
    this.editing.set(account);
    this.saveError.set('');
    this.dialogOpen.set(true);
  }

  protected showTokens(account: ServiceAccountItem): void {
    this.tokensOf.set(account);
    this.tokensOpen.set(true);
  }

  protected async save(draft: ServiceAccountDraft): Promise<void> {
    const editing = this.editing();
    this.saving.set(true);
    this.saveError.set('');
    const roles = {
      data: draft.roleIds.map((id) => ({ type: 'Role' as const, id })),
    };
    const description = draft.description === '' ? null : draft.description;
    try {
      if (editing) {
        await firstValueFrom(
          this.api.patch(
            '/service-accounts/{serviceAccountId}',
            { path: { serviceAccountId: editing.id } },
            {
              data: {
                type: 'ServiceAccount',
                id: editing.id,
                attributes: { name: draft.name, description },
                // Only a changed selection is sent: an unchanged one, read earlier, would put
                // back a role another admin took away meanwhile.
                ...(!sameRoles(editing, draft.roleIds) && {
                  relationships: { roles },
                }),
              },
            },
          ),
        );
        this.toast.success(
          translated('editor.admin.serviceAccounts.saved', {
            name: draft.name,
          }),
        );
      } else {
        await firstValueFrom(
          this.api.post('/service-accounts', {
            data: {
              type: 'ServiceAccount',
              id: draft.id,
              attributes: { name: draft.name, description },
              relationships: { roles },
            },
          }),
        );
        this.toast.success(
          translated('editor.admin.serviceAccounts.created', {
            name: draft.name,
          }),
        );
      }
      this.dialogOpen.set(false);
      this.reload();
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.saveError.set(this.t(text.key, text.params));
    } finally {
      this.saving.set(false);
    }
  }

  protected deactivate(account: ServiceAccountItem): void {
    const name = account.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.serviceAccounts.deactivate.title', {
        name,
      }),
      zDescription: this.t(
        'editor.admin.serviceAccounts.deactivate.description',
      ),
      zOkText: this.t('editor.admin.serviceAccounts.actions.deactivate'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runDeactivate(account),
    });
  }

  private async runDeactivate(account: ServiceAccountItem): Promise<void> {
    this.acting.set(account.id);
    try {
      const doc = await firstValueFrom(
        this.api.act('/service-accounts/{serviceAccountId}/deactivate', {
          path: { serviceAccountId: account.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.serviceAccounts.deactivate.done', {
          name: account.attributes.name,
          locks: doc.meta.locksReleased,
        }),
      );
      this.refreshed(doc.data);
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  protected async reactivate(account: ServiceAccountItem): Promise<void> {
    this.acting.set(account.id);
    try {
      const doc = await firstValueFrom(
        this.api.act('/service-accounts/{serviceAccountId}/reactivate', {
          path: { serviceAccountId: account.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.serviceAccounts.reactivated', {
          name: account.attributes.name,
        }),
      );
      this.refreshed(doc.data);
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  /** The sheet follows a change of the account it shows (deactivated: no new tokens). */
  private refreshed(account: ServiceAccountItem): void {
    if (this.tokensOf()?.id === account.id) this.tokensOf.set(account);
  }

  private async loadRoles(): Promise<void> {
    try {
      this.roles.set(await loadAllRoles(this.api));
    } catch {
      // Role names fall back to their IDs; the dialog offers none until a reload.
    }
  }

  private async load(query: {
    q: string;
    status: ServiceAccountStatus | undefined;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/service-accounts', {
          query: {
            ...(query.q ? { 'filter[q]': query.q } : {}),
            ...(query.status ? { 'filter[status]': query.status } : {}),
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

/** Whether the account holds exactly these roles, as last read. */
function sameRoles(
  account: ServiceAccountItem,
  roleIds: readonly string[],
): boolean {
  const held = new Set(account.relationships.roles.data.map((r) => r.id));
  return held.size === roleIds.length && roleIds.every((id) => held.has(id));
}
