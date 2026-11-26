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
  lucideMail,
  lucideMailX,
  lucideSearch,
  lucideShieldCheck,
  lucideShieldOff,
  lucideUserCheck,
  lucideUsers,
  lucideUserX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
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
import { MeService } from '../permissions/me';
import {
  injectQueryState,
  intParam,
  oneOfParam,
  textParam,
} from '../view-state';
import { injectAdminActions } from './admin-actions';
import {
  directRoleIds,
  type RoleItem,
  USER_PAGE_SIZES,
  USER_STATUSES,
  type UserDraft,
  type UserItem,
  type UserStatus,
} from './admin-model';
import { loadAllRoles } from './roles-source';
import { UserDialogComponent } from './user-dialog.component';
import { SecondFactorSession } from '../second-factor/second-factor-session';
import { PasswordSession } from '../session/password-session';
import {
  type ShownSignInLink,
  SignInLinkDialogComponent,
} from './sign-in-link-dialog.component';
import { SandboxSession } from '../sandbox/sandbox-session';

type UserDoc = Response<'/users'>;

/** Space kept below the frame: the notes under it and the page's bottom padding. */
const BELOW_FRAME_PX = 96;

/**
 * The Users tab of Admin (#39): every person, deactivated ones too, with their email address,
 * roles and status; a search (ID, name, email) and a status filter. "New user" (the header's
 * action) and Edit open the user dialog; a row's menu has the rest. Deactivate asks first, then releases the user's locks;
 * Reactivate lets a person act again. Search, status, page and size are in the address.
 * With password sign-in on (#610), a column says how each person signs in, and Invite or Reset
 * link makes a one-time link shown once (a new person gets their invite right away); an open
 * invite can be withdrawn. A role held through a sign-in group (#592) is marked apart from one
 * given directly. Who has two-factor sign-in on says so, and an admin can reset it (#611).
 */
@Component({
  selector: 'of-users-page',
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
    ZardDropdownImports,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardTableImports,
    UserDialogComponent,
    SignInLinkDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideEllipsis,
      lucideKeyRound,
      lucideMail,
      lucideMailX,
      lucideSearch,
      lucideShieldCheck,
      lucideShieldOff,
      lucideUserCheck,
      lucideUsers,
      lucideUserX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex flex-wrap items-center gap-3">
      <of-segmented
        [label]="'editor.admin.users.filter.label' | transloco"
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
          [attr.aria-label]="'editor.admin.users.filter.search' | transloco"
          [placeholder]="'editor.admin.users.filter.search' | transloco"
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
      [label]="'editor.admin.users.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (filtered()
          ? 'editor.admin.users.empty.filteredTitle'
          : 'editor.admin.users.empty.title'
        ) | transloco
      "
      [emptyDescription]="
        (filtered()
          ? 'editor.admin.users.empty.filteredDescription'
          : 'editor.admin.users.empty.description'
        ) | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <!-- Fits the frame from a 1024 px window up: the email under the name, the
             actions wrapping; narrower, the frame scrolls it sideways. -->
        <table z-table class="min-w-[40rem] table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head class="w-[28%]">
                {{ 'editor.admin.users.table.name' | transloco }}
              </th>
              <th z-table-head>
                {{ 'editor.admin.users.table.roles' | transloco }}
              </th>
              <th z-table-head class="w-28">
                {{ 'editor.admin.users.table.status' | transloco }}
              </th>
              @if (passwordOn()) {
                <th z-table-head class="w-[15%]">
                  {{ 'editor.admin.users.table.signIn' | transloco }}
                </th>
              }
              <th z-table-head class="w-40">
                <span class="sr-only">{{
                  'editor.admin.users.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (user of asUsers(items); track user.id) {
              <tr z-table-row>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="block font-medium break-words">{{
                    user.attributes.name
                  }}</span>
                  <span
                    class="text-muted-foreground block text-sm [overflow-wrap:anywhere]"
                    data-slot="user-email"
                    >{{
                      user.attributes.email ??
                        ('editor.admin.users.table.noEmail' | transloco)
                    }}</span
                  >
                  <span
                    class="text-muted-foreground block font-mono text-xs [overflow-wrap:anywhere]"
                    >{{ user.id }}</span
                  >
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <span class="flex flex-wrap gap-1">
                    @for (r of user.relationships.roles.data; track r.id) {
                      @if (viaGroup(user, r.id)) {
                        <!-- Held through a sign-in group: marked, and followed by the mappings. -->
                        <z-badge
                          zType="secondary"
                          class="h-auto max-w-full gap-1 break-words whitespace-normal"
                          data-via="group"
                          [attr.title]="
                            'editor.admin.users.table.viaGroup'
                              | transloco: { role: roleName(r.id) }
                          "
                          ><ng-icon
                            name="lucideUsers"
                            class="shrink-0"
                            aria-hidden="true"
                          /><span aria-hidden="true">{{ roleName(r.id) }}</span
                          ><span class="sr-only">{{
                            'editor.admin.users.table.viaGroup'
                              | transloco: { role: roleName(r.id) }
                          }}</span></z-badge
                        >
                      } @else {
                        <z-badge
                          zType="outline"
                          class="h-auto max-w-full break-words whitespace-normal"
                          >{{ roleName(r.id) }}</z-badge
                        >
                      }
                    } @empty {
                      <span class="text-muted-foreground text-sm">{{
                        'editor.admin.users.table.noRoles' | transloco
                      }}</span>
                    }
                  </span>
                </td>
                <td z-table-cell class="align-top">
                  @if (user.attributes.deactivatedAt) {
                    <z-badge zType="secondary">{{
                      'editor.admin.users.status.deactivated' | transloco
                    }}</z-badge>
                  } @else {
                    <z-badge zType="success">{{
                      'editor.admin.users.status.active' | transloco
                    }}</z-badge>
                  }
                  @if (secondFactorOn(user)) {
                    <span
                      class="text-muted-foreground mt-1.5 flex items-start gap-1 text-xs break-words whitespace-normal"
                      data-slot="second-factor"
                    >
                      <ng-icon
                        name="lucideShieldCheck"
                        class="mt-px shrink-0"
                        aria-hidden="true"
                      />
                      {{ 'editor.admin.users.secondFactor.on' | transloco }}
                    </span>
                  }
                </td>
                @if (passwordOn()) {
                  <td
                    z-table-cell
                    class="text-muted-foreground align-top text-sm whitespace-normal break-words"
                    [attr.data-sign-in]="signInOf(user)"
                    [attr.title]="inviteUntil(user)"
                  >
                    {{ signInText[signInOf(user)] | transloco }}
                  </td>
                }
                <td z-table-cell class="text-end align-top">
                  <span class="inline-flex items-center justify-end gap-1">
                    <button
                      z-button
                      zType="outline"
                      zSize="sm"
                      type="button"
                      [attr.aria-label]="
                        'editor.admin.users.actions.editLabel'
                          | transloco: { name: user.attributes.name }
                      "
                      (click)="edit(user)"
                    >
                      {{ 'editor.admin.users.actions.edit' | transloco }}
                    </button>
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon-sm"
                      type="button"
                      class="shrink-0"
                      data-testid="user-menu"
                      z-dropdown
                      [zDropdownMenu]="menu"
                      [zLoading]="acting() === user.id || linking() === user.id"
                      [zDisabled]="acting() !== null || linking() !== null"
                      [attr.aria-label]="
                        'editor.admin.users.actions.menu'
                          | transloco: { name: user.attributes.name }
                      "
                    >
                      @if (acting() !== user.id && linking() !== user.id) {
                        <ng-icon name="lucideEllipsis" aria-hidden="true" />
                      }
                    </button>
                    <z-dropdown-menu-content #menu zAlign="end" class="w-60">
                      @if (passwordOn() && !user.attributes.deactivatedAt) {
                        @if (!user.attributes.email || sandbox.on()) {
                          <!-- No address to sign in with: no link to make (422 no-email-address);
                               a public sandbox makes none at all (issue 826, the header says why). -->
                        } @else if (
                          signInOf(user) === 'password' ||
                          signInOf(user) === 'both'
                        ) {
                          <z-dropdown-menu-item
                            data-action="reset-link"
                            (click)="makeLink(user, 'reset')"
                          >
                            <ng-icon name="lucideKeyRound" aria-hidden="true" />
                            {{
                              'editor.admin.users.actions.resetLink' | transloco
                            }}
                          </z-dropdown-menu-item>
                        } @else {
                          <z-dropdown-menu-item
                            data-action="invite"
                            (click)="makeLink(user, 'invite')"
                          >
                            <ng-icon name="lucideMail" aria-hidden="true" />
                            {{
                              'editor.admin.users.actions.invite' | transloco
                            }}
                          </z-dropdown-menu-item>
                        }
                        @if (signInOf(user) === 'invited') {
                          <z-dropdown-menu-item
                            data-action="withdraw"
                            (click)="afterMenu(() => withdraw(user))"
                          >
                            <ng-icon name="lucideMailX" aria-hidden="true" />
                            {{
                              'editor.admin.users.actions.withdraw' | transloco
                            }}
                          </z-dropdown-menu-item>
                        }
                      }
                      @if (secondFactorOn(user) && user.id !== me.me().id) {
                        <z-dropdown-menu-item
                          data-action="reset-second-factor"
                          (click)="afterMenu(() => resetSecondFactor(user))"
                        >
                          <ng-icon name="lucideShieldOff" aria-hidden="true" />
                          {{
                            'editor.admin.users.secondFactor.reset' | transloco
                          }}
                        </z-dropdown-menu-item>
                      }
                      @if (user.attributes.deactivatedAt) {
                        <z-dropdown-menu-item
                          data-action="reactivate"
                          (click)="reactivate(user)"
                        >
                          <ng-icon name="lucideUserCheck" aria-hidden="true" />
                          {{
                            'editor.admin.users.actions.reactivate' | transloco
                          }}
                        </z-dropdown-menu-item>
                      } @else {
                        <z-dropdown-menu-item
                          data-action="deactivate"
                          variant="destructive"
                          (click)="afterMenu(() => deactivate(user))"
                        >
                          <ng-icon name="lucideUserX" aria-hidden="true" />
                          {{
                            'editor.admin.users.actions.deactivate' | transloco
                          }}
                        </z-dropdown-menu-item>
                      }
                    </z-dropdown-menu-content>
                  </span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>

    @if (anyViaGroup()) {
      <p
        class="text-muted-foreground m-0 flex items-start gap-1.5 text-xs break-words"
        data-testid="group-legend"
      >
        <ng-icon name="lucideUsers" class="mt-px shrink-0" aria-hidden="true" />
        <span>{{ 'editor.admin.users.table.groupLegend' | transloco }}</span>
      </p>
    }
    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.note' | transloco }}
    </p>

    <of-user-dialog
      [(open)]="dialogOpen"
      [user]="editing()"
      [roles]="roles()"
      [busy]="saving()"
      [error]="saveError()"
      (save)="save($event)"
    />

    <of-sign-in-link-dialog [(open)]="linkOpen" [shown]="shownLink()" />
  `,
})
export class UsersPage {
  protected readonly sandbox = inject(SandboxSession);
  private readonly api = inject(ApiClient);
  protected readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    q: textParam(),
    status: oneOfParam(USER_STATUSES),
    page: intParam(1),
    size: intParam(USER_PAGE_SIZES[0], { only: USER_PAGE_SIZES }),
  });
  protected readonly search = this.view.get('q');
  protected readonly status = this.view.get('status');
  protected readonly pageSizes = USER_PAGE_SIZES;

  protected readonly doc = signal<UserDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly roles = signal<readonly RoleItem[]>([]);
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<UserItem | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  /** The user a deactivation or reactivation is under way for. */
  protected readonly acting = signal<string | null>(null);
  protected readonly offset = signal('20rem');
  private readonly passwords = inject(PasswordSession);
  private readonly secondFactor = inject(SecondFactorSession);
  /** Password sign-in is on (#610): the sign-in column, invites and reset links. */
  protected readonly passwordOn = computed(
    () => this.passwords.options()?.password === true,
  );
  /** The user a link is being made for. */
  protected readonly linking = signal<string | null>(null);
  protected readonly linkOpen = signal(false);
  protected readonly shownLink = signal<ShownSignInLink | null>(null);
  protected readonly signInText = SIGN_IN_TEXT;
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly filtered = computed(
    () => this.search() !== '' || this.status() !== undefined,
  );

  protected readonly statusOptions = computed((): SegmentedOption[] => [
    { value: '', label: this.t('editor.admin.users.filter.all') },
    { value: 'active', label: this.t('editor.admin.users.filter.active') },
    {
      value: 'deactivated',
      label: this.t('editor.admin.users.filter.deactivated'),
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
    void this.passwords.loadOptions();
    // The link lives only while its dialog is open.
    effect(() => {
      if (!this.linkOpen()) untracked(() => this.shownLink.set(null));
    });
    injectAdminActions()?.on('users', () => this.add());

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

  /** Whether `user` holds `roleId` only through a sign-in group (#37, `meta.groupRoleIds`). */
  protected viaGroup(user: UserItem, roleId: string): boolean {
    return user.meta?.groupRoleIds?.includes(roleId) ?? false;
  }

  /** Someone on this page holds a role through a group: the mark is explained under the list. */
  protected readonly anyViaGroup = computed(() =>
    (this.doc()?.data ?? []).some(
      (user) => (user.meta?.groupRoleIds?.length ?? 0) > 0,
    ),
  );

  protected asUsers(items: readonly unknown[]): readonly UserItem[] {
    return items as readonly UserItem[];
  }

  protected signInOf(user: UserItem): SignInWay {
    const signIn = user.meta?.signIn;
    if (!signIn) return 'none';
    if (signIn.password && signIn.provider) return 'both';
    if (signIn.password) return 'password';
    if (signIn.provider) return 'provider';
    if (signIn.inviteExpiresAt !== null) {
      return Date.parse(signIn.inviteExpiresAt) > Date.now()
        ? 'invited'
        : 'inviteExpired';
    }
    return 'none';
  }

  protected inviteUntil(user: UserItem): string | null {
    const at = user.meta?.signIn?.inviteExpiresAt;
    return at
      ? this.t('editor.admin.users.signIn.inviteUntil', {
          date: new Date(at).toLocaleString(),
        })
      : null;
  }

  /** An invite or a reset link for `user`, shown once in its dialog. */
  protected async makeLink(
    user: UserItem,
    kind: 'invite' | 'reset',
  ): Promise<void> {
    if (this.linking() !== null) return;
    this.linking.set(user.id);
    try {
      const made = await this.passwords.makeLink(user.id, kind);
      this.shownLink.set({
        name: user.attributes.name,
        email: user.attributes.email ?? null,
        kind,
        url: this.passwords.linkOf(made, location.origin),
        expiresAt: made.expiresAt,
        emailed: made.emailed,
      });
      this.linkOpen.set(true);
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.linking.set(null);
    }
  }

  protected withdraw(user: UserItem): void {
    const name = user.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.users.withdraw.title', { name }),
      zDescription: this.t('editor.admin.users.withdraw.description', { name }),
      zOkText: this.t('editor.admin.users.actions.withdraw'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runWithdraw(user),
    });
  }

  private async runWithdraw(user: UserItem): Promise<void> {
    this.acting.set(user.id);
    try {
      await this.passwords.withdrawInvite(user.id);
      this.toast.success(
        translated('editor.admin.users.withdraw.done', {
          name: user.attributes.name,
        }),
      );
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  protected secondFactorOn(user: UserItem): boolean {
    const signIn = user.meta?.signIn;
    return signIn ? signIn.secondFactor : false;
  }

  /** Removes a person's second factor (#611), once confirmed: for a lost phone. */
  protected resetSecondFactor(user: UserItem): void {
    const name = user.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.users.secondFactor.title', { name }),
      zDescription: this.t('editor.admin.users.secondFactor.description', {
        name,
      }),
      zOkText: this.t('editor.admin.users.secondFactor.reset'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runResetSecondFactor(user),
    });
  }

  private async runResetSecondFactor(user: UserItem): Promise<void> {
    this.acting.set(user.id);
    try {
      await this.secondFactor.reset(user.id);
      this.toast.success(
        translated('editor.admin.users.secondFactor.done', {
          name: user.attributes.name,
        }),
      );
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
      this.reload();
    }
  }

  protected roleName(id: string): string {
    return this.roleNames().get(id) ?? id;
  }

  protected setStatus(value: string): void {
    const status = USER_STATUSES.find((s) => s === value);
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

  protected edit(user: UserItem): void {
    this.editing.set(user);
    this.saveError.set('');
    this.dialogOpen.set(true);
  }

  protected async save(draft: UserDraft): Promise<void> {
    const editing = this.editing();
    this.saving.set(true);
    this.saveError.set('');
    const roles = {
      data: draft.roleIds.map((id) => ({ type: 'Role' as const, id })),
    };
    try {
      if (editing) {
        await firstValueFrom(
          this.api.patch(
            '/users/{userId}',
            { path: { userId: editing.id } },
            {
              data: {
                type: 'User',
                id: editing.id,
                attributes: {
                  name: draft.name,
                  email: draft.email === '' ? null : draft.email,
                },
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
          translated('editor.admin.users.saved', { name: draft.name }),
        );
        // One's own roles may have changed.
        if (editing.id === this.me.me().id)
          void this.me.refresh(true).catch(() => false);
      } else {
        await firstValueFrom(
          this.api.post('/users', {
            data: {
              type: 'User',
              id: draft.id,
              attributes: { name: draft.name, email: draft.email },
              relationships: { roles },
            },
          }),
        );
        this.toast.success(
          translated('editor.admin.users.created', { name: draft.name }),
        );
      }
      this.dialogOpen.set(false);
      this.reload();
      // A new person with password sign-in on (#610): their invite, to copy (emailed too).
      if (!editing && this.passwordOn()) {
        const created = {
          id: draft.id,
          attributes: { name: draft.name, email: draft.email },
        } as UserItem;
        void this.makeLink(created, 'invite');
      }
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.saveError.set(this.t(text.key, text.params));
    } finally {
      this.saving.set(false);
    }
  }

  /** A question opens once the menu has closed: the focus then goes back to its button. */
  protected afterMenu(ask: () => void): void {
    setTimeout(ask, 30);
  }

  protected deactivate(user: UserItem): void {
    const name = user.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.users.deactivate.title', { name }),
      zDescription: this.t('editor.admin.users.deactivate.description', {
        name,
      }),
      zOkText: this.t('editor.admin.users.actions.deactivate'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runDeactivate(user),
    });
  }

  private async runDeactivate(user: UserItem): Promise<void> {
    this.acting.set(user.id);
    try {
      const doc = await firstValueFrom(
        this.api.act('/users/{userId}/deactivate', {
          path: { userId: user.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.users.deactivate.done', {
          name: user.attributes.name,
          locks: doc.meta.locksReleased,
        }),
      );
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
  }

  protected async reactivate(user: UserItem): Promise<void> {
    this.acting.set(user.id);
    try {
      await firstValueFrom(
        this.api.act('/users/{userId}/reactivate', {
          path: { userId: user.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.users.reactivated', {
          name: user.attributes.name,
        }),
      );
      this.reload();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.acting.set(null);
    }
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
    status: UserStatus | undefined;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/users', {
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

/** How a person signs in (#610), as the sign-in column says it. */
type SignInWay =
  'password' | 'provider' | 'both' | 'invited' | 'inviteExpired' | 'none';

/** The text of each (a literal per key, so the translation check finds them). */
const SIGN_IN_TEXT: Record<SignInWay, string> = {
  password: 'editor.admin.users.signIn.password',
  provider: 'editor.admin.users.signIn.provider',
  both: 'editor.admin.users.signIn.both',
  invited: 'editor.admin.users.signIn.invited',
  inviteExpired: 'editor.admin.users.signIn.inviteExpired',
  none: 'editor.admin.users.signIn.none',
};

/** Whether the user holds exactly these roles, as last read. */
function sameRoles(user: UserItem, roleIds: readonly string[]): boolean {
  const held = new Set(directRoleIds(user));
  return held.size === roleIds.length && roleIds.every((id) => held.has(id));
}
