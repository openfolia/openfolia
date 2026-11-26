import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBot, lucideX } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import {
  languageName,
  languagesOf,
  type StoredConfig,
} from '../content/browser-model';
import { apiErrorText, labelsInUi } from '../i18n';
import { MeService, type ApiPermission } from '../permissions/me';
import { idParam, injectQueryState, intParam } from '../view-state';
import { injectAdminActions } from './admin-actions';
import {
  attributesOf,
  DESCRIPTION_MAX,
  draftOf,
  EMPTY_ROLE,
  HOLDER_PAGE_SIZE,
  ID_MAX,
  NAME_MAX,
  PERMISSION_TEXTS,
  PERMISSIONS,
  ROLE_ID,
  ROLE_PAGE_SIZE,
  roleIdOf,
  roleKind,
  roleProblems,
  sameRole,
  type RoleDraft,
  type RoleItem,
  type UserItem,
} from './admin-model';
import {
  assignableToService,
  type ServiceAccountItem,
} from './service-accounts-model';

type RoleDoc = Response<'/roles'>;
type UserDoc = Response<'/users'>;
type ServiceAccountDoc = Response<'/service-accounts'>;

/** How many people, and how many service accounts, the "Add" picker offers (active ones, by ID). */
const CANDIDATES = 200;
/** A picker value names the kind too: a user and a service account may share an ID. */
const USER_PICK = 'user:';
const SERVICE_PICK = 'service:';
/** Permissions a role's scope does not apply to. */
const GLOBAL: ReadonlySet<string> = new Set([
  'admin.roles',
  'admin.branding',
  'admin.backups',
  'webhook.manage',
  'scim.provision',
]);

/**
 * Screen 6, the Roles tab of Admin (#39): the roles on the left (paged), the chosen one in the
 * middle (name, description, permissions with what each allows, and the scope: facets, module
 * types, audience and languages, "All" when left empty), and on the right who holds it (people,
 * then service accounts, marked as such: #289), with "Add" and remove; a role with `admin.roles`
 * is never offered to a service account. "New role" (the header's action) starts an empty one. Changes apply at
 * once and are audited; the API keeps the last admin. The chosen role and the list's page are in
 * the address.
 */
@Component({
  selector: 'of-roles-page',
  imports: [
    FormsModule,
    TranslocoPipe,
    NgIcon,
    FadeInDirective,
    RefreshingDirective,
    ListFrameComponent,
    ListRowDirective,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBot, lucideX })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div
      class="grid min-w-0 items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_17rem]"
    >
      <of-list-frame
        class="min-w-0"
        [label]="'editor.admin.roles.list.label' | transloco"
        [items]="rolesDoc()?.data ?? []"
        [page]="rolesDoc()?.meta?.page ?? null"
        [loading]="rolesLoading()"
        [error]="errorOf(rolesFailure())"
        [skeletonRows]="6"
        offset="calc(14rem + var(--of-sandbox-h, 0px))"
        [emptyTitle]="'editor.admin.roles.list.empty' | transloco"
        (pageChange)="view.set({ page: $event })"
        (retry)="reloadRoles()"
      >
        <ng-template ofListRow let-item>
          @let role = asRole(item);
          <button
            type="button"
            class="hover:bg-muted focus-visible:ring-ring flex w-full min-w-0 items-baseline justify-between gap-3 rounded-md px-3 py-2 text-start text-sm transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
            [class.bg-muted]="role.id === shownId()"
            [class.font-medium]="role.id === shownId()"
            [attr.aria-current]="role.id === shownId() ? 'true' : null"
            (click)="select(role.id)"
          >
            <span class="min-w-0 break-words">{{ role.attributes.name }}</span>
            <span class="text-muted-foreground shrink-0 text-xs">{{
              (roleKind(role.attributes.permissions) === 'reading'
                ? 'editor.admin.roles.kind.reading'
                : 'editor.admin.roles.kind.editing'
              ) | transloco
            }}</span>
          </button>
        </ng-template>
      </of-list-frame>

      <section
        class="border-border bg-background flex min-w-0 flex-col gap-5 rounded-xl border p-4 sm:p-5"
        [attr.aria-label]="'editor.admin.roles.editor.label' | transloco"
      >
        @if (editorState() === 'loading') {
          <div
            ofFadeIn="delayed"
            class="flex flex-col gap-4"
            aria-hidden="true"
          >
            <z-skeleton class="h-9 w-full" />
            <z-skeleton class="h-40 w-full" />
            <z-skeleton class="h-24 w-full" />
          </div>
        } @else if (editorState() === 'none') {
          <p class="text-muted-foreground m-0 text-sm">
            {{ 'editor.admin.roles.editor.none' | transloco }}
          </p>
        } @else {
          <form
            ofFadeIn
            class="flex flex-col gap-5"
            novalidate
            [ofRefreshing]="saving()"
            (submit)="save($event)"
          >
            <div class="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div class="flex flex-col gap-1.5">
                <label class="text-muted-foreground text-sm" for="role-name">{{
                  'editor.admin.roles.fields.name' | transloco
                }}</label>
                <input
                  id="role-name"
                  z-input
                  autocomplete="off"
                  [attr.maxlength]="nameMax"
                  [attr.aria-invalid]="shown().name ? 'true' : null"
                  [value]="draft().name"
                  (input)="setName($any($event.target).value)"
                />
                @if (shown().name; as problem) {
                  <p class="text-destructive m-0 text-xs">
                    {{ problem | transloco }}
                  </p>
                }
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-muted-foreground text-sm"
                  for="role-description"
                  >{{
                    'editor.admin.roles.fields.description' | transloco
                  }}</label
                >
                <input
                  id="role-description"
                  z-input
                  autocomplete="off"
                  [attr.maxlength]="descriptionMax"
                  [attr.aria-invalid]="shown().description ? 'true' : null"
                  [value]="draft().description"
                  (input)="patch({ description: $any($event.target).value })"
                />
              </div>
            </div>

            @if (creating()) {
              <div class="flex flex-col gap-1.5">
                <label class="text-muted-foreground text-sm" for="role-id">{{
                  'editor.admin.roles.fields.id' | transloco
                }}</label>
                <input
                  id="role-id"
                  z-input
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono sm:max-w-80"
                  [attr.maxlength]="idMax"
                  [attr.aria-invalid]="shown().id ? 'true' : null"
                  aria-describedby="role-id-hint"
                  [value]="draft().id"
                  (input)="setId($any($event.target).value)"
                />
                <p
                  id="role-id-hint"
                  class="text-muted-foreground m-0 text-xs"
                  [class.text-destructive]="!!shown().id"
                >
                  {{
                    shown().id ?? 'editor.admin.roles.fields.idHint' | transloco
                  }}
                </p>
              </div>
            }

            <fieldset class="m-0 flex flex-col gap-3 border-0 p-0">
              <legend class="mb-3 p-0 text-sm font-medium">
                {{ 'editor.admin.roles.fields.permissions' | transloco }}
              </legend>
              <div class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                @for (p of permissions; track p) {
                  <div class="flex min-w-0 items-start gap-2">
                    <z-checkbox
                      class="mt-0.5"
                      [zId]="'perm-' + p"
                      [zAriaLabel]="p"
                      [ngModel]="draft().permissions.includes(p)"
                      [ngModelOptions]="{ standalone: true }"
                      (checkChange)="togglePermission(p, $event)"
                    />
                    <label class="flex min-w-0 flex-col" [for]="'perm-' + p">
                      <span class="font-mono text-sm break-all">{{ p }}</span>
                      <span class="text-muted-foreground text-xs break-words">{{
                        permissionText(p) | transloco
                      }}</span>
                    </label>
                  </div>
                }
              </div>
              @if (shown().permissions; as problem) {
                <p class="text-destructive m-0 text-xs">
                  {{ problem | transloco }}
                </p>
              }
            </fieldset>

            <fieldset class="m-0 flex flex-col gap-3 border-0 p-0">
              <legend class="mb-1 p-0 text-sm font-medium">
                {{ 'editor.admin.roles.fields.scope' | transloco }}
              </legend>
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{
                  (hasGlobal()
                    ? 'editor.admin.roles.scope.hintGlobal'
                    : 'editor.admin.roles.scope.hint'
                  ) | transloco
                }}
              </p>
              @if (config(); as c) {
                @for (f of c.facets; track f.id) {
                  <div
                    class="grid items-center gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <span class="text-muted-foreground text-sm">{{
                      f.label
                    }}</span>
                    <z-select
                      zMultiple
                      zPosition="popper"
                      [zMaxLabelCount]="4"
                      [zAriaLabel]="f.label"
                      [zPlaceholder]="
                        'editor.admin.roles.scope.all' | transloco
                      "
                      [zValue]="facetValues(f.id)"
                      (zSelectionChange)="setFacet(f.id, $event)"
                    >
                      @for (v of f.values; track v.id) {
                        <z-select-item [zValue]="v.id">{{
                          v.label
                        }}</z-select-item>
                      }
                    </z-select>
                  </div>
                }
                <div
                  class="grid items-center gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
                >
                  <span class="text-muted-foreground text-sm">{{
                    'editor.admin.roles.scope.moduleTypes' | transloco
                  }}</span>
                  <z-select
                    zMultiple
                    zPosition="popper"
                    [zMaxLabelCount]="4"
                    [zAriaLabel]="
                      'editor.admin.roles.scope.moduleTypes' | transloco
                    "
                    [zPlaceholder]="'editor.admin.roles.scope.all' | transloco"
                    [zValue]="list(draft().moduleTypes)"
                    (zSelectionChange)="patch({ moduleTypes: values($event) })"
                  >
                    @for (t of c.moduleTypes; track t.id) {
                      <z-select-item [zValue]="t.id">{{
                        t.label
                      }}</z-select-item>
                    }
                  </z-select>
                </div>
                <div
                  class="grid items-center gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
                >
                  <span class="text-muted-foreground text-sm">{{
                    'editor.admin.roles.scope.audience' | transloco
                  }}</span>
                  <z-select
                    zPosition="popper"
                    [zAriaLabel]="
                      'editor.admin.roles.scope.audience' | transloco
                    "
                    [zValue]="draft().maxAudience"
                    (zSelectionChange)="patch({ maxAudience: single($event) })"
                  >
                    <z-select-item zValue="">{{
                      'editor.admin.roles.scope.allAudiences' | transloco
                    }}</z-select-item>
                    @for (a of c.audiences; track a.id) {
                      <z-select-item [zValue]="a.id">{{
                        'editor.admin.roles.scope.upTo'
                          | transloco: { level: a.label }
                      }}</z-select-item>
                    }
                  </z-select>
                </div>
                <div
                  class="grid items-center gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
                >
                  <span class="text-muted-foreground text-sm">{{
                    'editor.admin.roles.scope.languages' | transloco
                  }}</span>
                  <z-select
                    zMultiple
                    zPosition="popper"
                    [zMaxLabelCount]="4"
                    [zAriaLabel]="
                      'editor.admin.roles.scope.languages' | transloco
                    "
                    [zPlaceholder]="'editor.admin.roles.scope.all' | transloco"
                    [zValue]="list(draft().languages)"
                    (zSelectionChange)="patch({ languages: values($event) })"
                  >
                    @for (l of languages(); track l) {
                      <z-select-item [zValue]="l">{{
                        languageName(l)
                      }}</z-select-item>
                    }
                  </z-select>
                </div>
              } @else if (configFailed()) {
                <p class="text-destructive m-0 text-xs">
                  {{ 'editor.admin.roles.scope.configFailed' | transloco }}
                </p>
              }
            </fieldset>

            <div
              class="border-border flex flex-wrap items-center gap-3 border-t pt-4"
            >
              @if (!creating()) {
                <button
                  z-button
                  zType="outline"
                  type="button"
                  class="text-destructive"
                  [zDisabled]="deleteBlocked() || saving()"
                  [attr.aria-describedby]="
                    deleteBlocked() ? 'role-delete-reason' : null
                  "
                  (click)="remove()"
                >
                  {{ 'editor.admin.roles.delete.action' | transloco }}
                </button>
                @if (deleteBlocked()) {
                  <span
                    id="role-delete-reason"
                    class="text-muted-foreground text-xs"
                    >{{
                      'editor.admin.roles.delete.held'
                        | transloco: { count: holderTotal() }
                    }}</span
                  >
                }
              }
              <span class="ms-auto flex gap-2">
                @if (dirty() || creating()) {
                  <button
                    z-button
                    zType="ghost"
                    type="button"
                    (click)="discard()"
                  >
                    {{ 'editor.admin.cancel' | transloco }}
                  </button>
                }
                <button
                  z-button
                  type="submit"
                  [zDisabled]="(!dirty() && !creating()) || saving()"
                  [zLoading]="saving()"
                >
                  {{
                    (creating()
                      ? 'editor.admin.roles.create'
                      : 'editor.admin.save'
                    ) | transloco
                  }}
                </button>
              </span>
            </div>
          </form>
        }
      </section>

      <aside class="flex min-w-0 flex-col gap-4 lg:col-span-2 xl:col-span-1">
        <section
          class="border-border flex flex-col gap-3 rounded-xl border p-4"
        >
          <h2 class="m-0 text-sm font-medium">
            {{ 'editor.admin.roles.groups.title' | transloco }}
          </h2>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.admin.roles.groups.description' | transloco }}
          </p>
          <!-- The mappings are kept on their own page, filtered to this role. -->
          @if (creating() || !editedId()) {
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.roles.groups.afterCreate' | transloco }}
            </p>
          } @else {
            <a
              class="text-foreground focus-visible:ring-ring/50 self-start rounded-sm text-sm font-medium break-words underline-offset-4 outline-none hover:underline focus-visible:ring-2"
              routerLink="/admin/group-mappings"
              [queryParams]="{ role: editedId() }"
              >{{ 'editor.admin.roles.groups.link' | transloco }}</a
            >
          }
        </section>
        <section
          class="border-border flex min-w-0 flex-col gap-3 rounded-xl border p-4"
        >
          <h2 class="m-0 text-sm font-medium">
            {{ 'editor.admin.roles.holders.title' | transloco }}
          </h2>
          @if (creating() || !editedId()) {
            <p class="text-muted-foreground m-0 text-xs">
              {{ 'editor.admin.roles.holders.afterCreate' | transloco }}
            </p>
          } @else {
            <of-list-frame
              class="min-w-0"
              [label]="'editor.admin.roles.holders.title' | transloco"
              [items]="holdersDoc()?.data ?? []"
              [page]="holdersDoc()?.meta?.page ?? null"
              [loading]="holdersLoading()"
              [error]="errorOf(holdersFailure())"
              [skeletonRows]="3"
              offset="calc(26rem + var(--of-sandbox-h, 0px))"
              [emptyTitle]="'editor.admin.roles.holders.empty' | transloco"
              (pageChange)="holderPage.set($event)"
              (retry)="reloadHolders()"
            >
              <ng-template ofListRow let-item>
                @let user = asUser(item);
                <div class="flex min-w-0 items-center gap-2 px-3 py-2">
                  <span
                    class="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-medium"
                    aria-hidden="true"
                    >{{ initials(user.attributes.name) }}</span
                  >
                  <span class="flex min-w-0 flex-col">
                    <span class="text-sm break-words">{{
                      user.attributes.name
                    }}</span>
                    @if (user.attributes.deactivatedAt) {
                      <span class="text-muted-foreground text-xs">{{
                        'editor.admin.users.status.deactivated' | transloco
                      }}</span>
                    }
                    @if (heldViaGroup(user)) {
                      <span
                        class="text-muted-foreground text-xs"
                        data-via="group"
                        >{{
                          'editor.admin.roles.holders.viaGroup' | transloco
                        }}</span
                      >
                    }
                  </span>
                  @if (!heldViaGroup(user)) {
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon"
                      type="button"
                      class="ms-auto size-7 shrink-0"
                      [zDisabled]="changingHolder() !== null"
                      [attr.aria-label]="
                        'editor.admin.roles.holders.remove'
                          | transloco: { name: user.attributes.name }
                      "
                      (click)="removeHolder(user)"
                    >
                      <ng-icon name="lucideX" aria-hidden="true" />
                    </button>
                  }
                </div>
              </ng-template>
            </of-list-frame>
            @if (
              serviceHoldersDoc()?.meta?.page?.total || serviceHoldersFailure()
            ) {
              <h3 class="text-muted-foreground m-0 mt-1 text-xs font-medium">
                {{ 'editor.admin.roles.holders.services' | transloco }}
              </h3>
              <of-list-frame
                class="min-w-0"
                [label]="'editor.admin.roles.holders.services' | transloco"
                [items]="serviceHoldersDoc()?.data ?? []"
                [page]="serviceHoldersDoc()?.meta?.page ?? null"
                [loading]="serviceHoldersLoading()"
                [error]="errorOf(serviceHoldersFailure())"
                [skeletonRows]="2"
                offset="calc(30rem + var(--of-sandbox-h, 0px))"
                (pageChange)="serviceHolderPage.set($event)"
                (retry)="reloadHolders()"
              >
                <ng-template ofListRow let-item>
                  @let account = asServiceAccount(item);
                  <div class="flex min-w-0 items-center gap-2 px-3 py-2">
                    <span
                      class="bg-muted text-foreground flex size-7 shrink-0 items-center justify-center rounded-full"
                      aria-hidden="true"
                      ><ng-icon name="lucideBot" class="text-sm"
                    /></span>
                    <span class="flex min-w-0 flex-col">
                      <span class="text-sm break-words">{{
                        account.attributes.name
                      }}</span>
                      <span class="text-muted-foreground text-xs break-words">{{
                        (account.attributes.deactivatedAt
                          ? 'editor.admin.roles.holders.serviceDeactivated'
                          : 'editor.admin.roles.holders.service'
                        ) | transloco
                      }}</span>
                    </span>
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon"
                      type="button"
                      class="ms-auto size-7 shrink-0"
                      [zDisabled]="changingHolder() !== null"
                      [attr.aria-label]="
                        'editor.admin.roles.holders.remove'
                          | transloco: { name: account.attributes.name }
                      "
                      (click)="removeServiceHolder(account)"
                    >
                      <ng-icon name="lucideX" aria-hidden="true" />
                    </button>
                  </div>
                </ng-template>
              </of-list-frame>
            }
            <z-select
              zSearchable
              zPosition="popper"
              [zAriaLabel]="'editor.admin.roles.holders.add' | transloco"
              [zPlaceholder]="'editor.admin.roles.holders.add' | transloco"
              [zDisabled]="changingHolder() !== null"
              [zValue]="pick()"
              (zSelectionChange)="addHolder(single($event))"
            >
              @for (u of candidates(); track u.id) {
                <z-select-item [zValue]="userPick + u.id">{{
                  u.attributes.name
                }}</z-select-item>
              }
              @for (a of serviceCandidates(); track a.id) {
                <z-select-item [zValue]="servicePick + a.id">{{
                  'editor.admin.roles.holders.serviceOption'
                    | transloco: { name: a.attributes.name }
                }}</z-select-item>
              }
            </z-select>
            @if (servicesBarred()) {
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{ 'editor.admin.roles.holders.servicesBarred' | transloco }}
              </p>
            }
          }
        </section>
        <p class="text-muted-foreground m-0 text-xs break-words">
          {{ 'editor.admin.note' | transloco }}
        </p>
      </aside>
    </div>
  `,
})
export class RolesPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly injector = inject(Injector);

  protected readonly view = injectQueryState({
    role: idParam(ROLE_ID),
    page: intParam(1),
  });
  private readonly chosen = this.view.get('role');

  protected readonly permissions = PERMISSIONS;
  protected readonly nameMax = NAME_MAX;
  protected readonly descriptionMax = DESCRIPTION_MAX;
  protected readonly idMax = ID_MAX;
  protected readonly roleKind = roleKind;

  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  protected readonly configFailed = signal(false);
  protected readonly rolesDoc = signal<RoleDoc | null>(null);
  protected readonly rolesLoading = signal(false);
  protected readonly rolesFailure = signal<ApiError | null>(null);
  private readonly rolesReloads = signal(0);

  /** The role shown, as stored; null while creating or before it is read. */
  private readonly stored = signal<RoleItem | null>(null);
  protected readonly storedLoading = signal(false);
  protected readonly creating = signal(false);
  protected readonly draft = signal<RoleDraft>(EMPTY_ROLE);
  /** The ID was typed by hand: it no longer follows the name. */
  private idTyped = false;
  private readonly submitted = signal(false);
  protected readonly saving = signal(false);

  protected readonly holdersDoc = signal<UserDoc | null>(null);
  protected readonly holdersLoading = signal(false);
  protected readonly holdersFailure = signal<ApiError | null>(null);
  protected readonly holderPage = signal(1);
  private readonly holdersReloads = signal(0);
  private readonly people = signal<readonly UserItem[]>([]);
  protected readonly serviceHoldersDoc = signal<ServiceAccountDoc | null>(null);
  protected readonly serviceHoldersLoading = signal(false);
  protected readonly serviceHoldersFailure = signal<ApiError | null>(null);
  protected readonly serviceHolderPage = signal(1);
  private readonly services = signal<readonly ServiceAccountItem[]>([]);
  private serviceHolderRuns = 0;
  protected readonly userPick = USER_PICK;
  protected readonly servicePick = SERVICE_PICK;
  protected readonly changingHolder = signal<string | null>(null);
  /** What the "Add person" picker shows: empty again once the person is added. */
  protected readonly pick = signal('');
  private storedRuns = 0;
  /** Counts the new roles started: a create answered after another one began leaves that one be. */
  private newRuns = 0;
  /** Counts the saves answered for the role in the editor: a read begun before one keeps what it saved. */
  private saveRuns = 0;
  /** A discard question is open. */
  private asking = false;
  private holderRuns = 0;
  private rolesRuns = 0;

  /** The role whose row is marked: the one chosen, or the first while none is. */
  protected readonly shownId = computed(() =>
    this.creating()
      ? undefined
      : (this.chosen() ?? this.rolesDoc()?.data[0]?.id),
  );

  /** The role in the editor, as read: its holders are the ones shown (not a role still being confirmed). */
  protected readonly editedId = computed(() => this.stored()?.id);

  protected readonly editorState = computed(
    (): 'loading' | 'none' | 'ready' => {
      if (this.creating()) return 'ready';
      if (this.stored()) return 'ready';
      if (this.storedLoading() || this.rolesLoading()) return 'loading';
      return 'none';
    },
  );

  private readonly problems = computed(() =>
    roleProblems(this.draft(), this.creating()),
  );
  protected readonly shown = computed(() =>
    this.submitted() ? this.problems() : {},
  );
  protected readonly dirty = computed(() => {
    const stored = this.stored();
    return this.creating()
      ? !sameRole(this.draft(), EMPTY_ROLE)
      : stored !== null && !sameRole(this.draft(), draftOf(stored));
  });
  protected readonly hasGlobal = computed(() =>
    this.draft().permissions.some((p) => GLOBAL.has(p)),
  );
  protected readonly holderTotal = computed(
    () => this.stored()?.meta.holders ?? 0,
  );
  protected readonly deleteBlocked = computed(() => this.holderTotal() > 0);
  protected readonly languages = computed(() => {
    const c = this.config();
    return c ? languagesOf(c) : [];
  });
  /** A role with `admin.roles` (as stored) is never offered to a service account. */
  protected readonly servicesBarred = computed(() => {
    const stored = this.stored();
    return stored !== null && !assignableToService(stored);
  });
  /** Service accounts that may get the role: active, not holding it yet, and only if it may be held by one. */
  protected readonly serviceCandidates = computed(() => {
    const id = this.editedId();
    if (this.servicesBarred()) return [];
    return this.services().filter(
      (a) =>
        !a.attributes.deactivatedAt &&
        !a.relationships.roles.data.some((r) => r.id === id),
    );
  });
  /** People who may get the role: active, not holding it yet. */
  protected readonly candidates = computed(() => {
    const id = this.editedId();
    return this.people().filter(
      (u) =>
        !u.attributes.deactivatedAt &&
        !u.relationships.roles.data.some((r) => r.id === id),
    );
  });

  constructor() {
    effect(() => {
      const page = this.view.get('page')();
      this.rolesReloads();
      untracked(() => void this.loadRoles(page));
    });
    // With no role chosen, the first one is: in the address, so paging or re-sorting the list
    // never swaps the role being edited.
    effect(() => {
      const first = this.rolesDoc()?.data[0]?.id;
      if (this.chosen() || this.creating() || !first) return;
      untracked(() => this.view.set({ role: first }, { replace: true }));
    });
    // The role to show: read again whenever the choice changes (a row, Back or Forward);
    // unsaved changes to the one shown are confirmed first.
    effect(() => {
      const id = this.shownId();
      if (this.creating()) return;
      untracked(() => {
        const shown = this.stored();
        // Already in the editor (kept after a "no", or just saved): nothing to read.
        if (shown && shown.id === id) {
          // Back on it while another role was being read: that read no longer counts.
          if (this.storedLoading()) {
            this.storedRuns++;
            this.storedLoading.set(false);
          }
          return;
        }
        // One question at a time; its answer reads the role chosen by then.
        if (this.asking) return;
        if (shown && this.dirty()) {
          this.asking = true;
          this.confirmDiscard(
            () => {
              this.asking = false;
              void this.loadStored(this.shownId());
            },
            () => {
              this.asking = false;
              this.view.set({ role: shown.id }, { replace: true });
            },
          );
          return;
        }
        void this.loadStored(id);
      });
    });
    // Another role's holders start on their first page.
    let holdersOf: string | undefined;
    effect(() => {
      const id = this.editedId();
      if (id !== holdersOf) {
        holdersOf = id;
        untracked(() => {
          this.holderPage.set(1);
          this.serviceHolderPage.set(1);
        });
      }
    });
    effect(() => {
      const id = this.editedId();
      const page = this.holderPage();
      this.holdersReloads();
      if (this.creating()) return;
      untracked(() => void this.loadHolders(id, page));
    });
    effect(() => {
      const id = this.editedId();
      const page = this.serviceHolderPage();
      this.holdersReloads();
      if (this.creating()) return;
      untracked(() => void this.loadServiceHolders(id, page));
    });
    void this.loadConfig();
    void this.loadPeople();
    void this.loadServices();
    injectAdminActions()?.on('roles', () => this.startNew());
  }

  protected asRole(item: unknown): RoleItem {
    return item as RoleItem;
  }

  protected asUser(item: unknown): UserItem {
    return item as UserItem;
  }

  protected asServiceAccount(item: unknown): ServiceAccountItem {
    return item as ServiceAccountItem;
  }

  protected errorOf(failure: ApiError | null) {
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  }

  protected permissionText(p: ApiPermission): string {
    return PERMISSION_TEXTS[p];
  }

  protected languageName(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }

  protected list(values: readonly string[]): string[] {
    return [...values];
  }

  protected values(value: string | string[]): string[] {
    return Array.isArray(value) ? value : value ? [value] : [];
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected facetValues(id: string): string[] {
    return [...(this.draft().facets[id] ?? [])];
  }

  protected setFacet(id: string, value: string | string[]): void {
    this.patch({
      facets: { ...this.draft().facets, [id]: this.values(value) },
    });
  }

  protected patch(change: Partial<RoleDraft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected setName(name: string): void {
    this.patch(
      this.creating() && !this.idTyped
        ? { name, id: roleIdOf(name) }
        : { name },
    );
  }

  protected setId(id: string): void {
    this.idTyped = true;
    this.patch({ id: id.trim() });
  }

  protected togglePermission(p: ApiPermission, on: boolean): void {
    const current = this.draft().permissions.filter((x) => x !== p);
    this.patch({ permissions: on ? [...current, p] : current });
  }

  protected reloadRoles(): void {
    this.rolesReloads.update((n) => n + 1);
  }

  protected reloadHolders(): void {
    this.holdersReloads.update((n) => n + 1);
  }

  /** Shows another role; the choice's effect confirms unsaved changes (a new role's here). */
  protected select(id: string): void {
    if (id === this.shownId() && !this.creating()) return;
    if (!this.creating()) {
      this.view.set({ role: id });
      return;
    }
    this.whenDiscarded(() => {
      this.creating.set(false);
      this.view.set({ role: id });
    });
  }

  /** For the route's `canDeactivate`: leaving Roles (another tab or section) with unsaved changes asks first. */
  leave(): Promise<boolean> {
    if (!this.dirty()) return Promise.resolve(true);
    return new Promise((resolve) =>
      this.confirmDiscard(
        () => resolve(true),
        () => resolve(false),
      ),
    );
  }

  protected startNew(): void {
    this.whenDiscarded(() => {
      // A role read under way (the first one, or one whose holders changed) no longer counts:
      // its answer would replace the new role's form.
      this.storedRuns++;
      this.storedLoading.set(false);
      this.newRuns++;
      this.creating.set(true);
      this.idTyped = false;
      this.submitted.set(false);
      this.stored.set(null);
      this.draft.set(EMPTY_ROLE);
      // Once the form is rendered: started in the click, it may not be yet (a role still read).
      afterNextRender(() => document.getElementById('role-name')?.focus(), {
        injector: this.injector,
      });
    });
  }

  protected discard(): void {
    if (this.creating()) {
      this.creating.set(false);
      return;
    }
    const stored = this.stored();
    if (stored) this.draft.set(draftOf(stored));
    this.submitted.set(false);
  }

  private whenDiscarded(go: () => void): void {
    if (!this.dirty()) {
      go();
      return;
    }
    this.confirmDiscard(go, () => undefined);
  }

  /** Asks before unsaved changes go: `discard` on yes, `keep` on no or when closed another way. */
  private confirmDiscard(discard: () => void, keep: () => void): void {
    let answered = false;
    const answer = (yes: boolean) => {
      if (answered) return;
      answered = true;
      if (yes) discard();
      else keep();
    };
    const ref = this.dialogs.confirm({
      zTitle: this.t('editor.admin.roles.discard.title'),
      zDescription: this.t('editor.admin.roles.discard.description'),
      zOkText: this.t('editor.admin.roles.discard.ok'),
      zCancelText: this.t('editor.admin.roles.discard.cancel'),
      zOkDestructive: true,
      zOnOk: () => answer(true),
      zOnCancel: () => answer(false),
    });
    // Closed another way (Escape): the changes stay.
    const closing = effect(
      () => {
        if (ref.isClosing()) {
          closing.destroy();
          queueMicrotask(() => answer(false));
        }
      },
      { injector: this.injector },
    );
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    this.submitted.set(true);
    if (Object.keys(this.problems()).length > 0 || this.saving()) return;
    const draft = this.draft();
    const attributes = attributesOf(draft);
    this.saving.set(true);
    try {
      if (this.creating()) {
        const run = this.newRuns;
        const doc = await firstValueFrom(
          this.api.post('/roles', {
            data: { type: 'Role', id: draft.id, attributes },
          }),
        );
        // Cancelled, or another new role begun meanwhile: that form stays (the role is created
        // all the same, and listed).
        if (this.creating() && run === this.newRuns) {
          this.creating.set(false);
          this.stored.set(doc.data);
          this.draft.set(draftOf(doc.data));
          this.submitted.set(false);
          this.view.set({ role: doc.data.id });
        }
        this.toast.success(
          translated('editor.admin.roles.created', { name: attributes.name }),
        );
      } else {
        const id = this.stored()?.id ?? draft.id;
        const doc = await firstValueFrom(
          this.api.patch(
            '/roles/{roleId}',
            { path: { roleId: id } },
            { data: { type: 'Role', id, attributes } },
          ),
        );
        // Still the role in the editor: what is stored follows the save (a "no" to a discard
        // question open meanwhile comes back to it saved), and a read of it begun before (a
        // holder change's) keeps it. Its form while it is the one shown, or while it is still
        // as sent: a new role, or changes made meanwhile, stay.
        if (!this.creating() && this.stored()?.id === id) {
          this.saveRuns++;
          this.stored.set(doc.data);
          if (this.shownId() === id || this.draft() === draft) {
            this.draft.set(draftOf(doc.data));
            this.submitted.set(false);
          }
        }
        this.toast.success(
          translated('editor.admin.roles.saved', { name: attributes.name }),
        );
        // What the person may do follows their roles at once.
        void this.me.refresh(true).catch(() => false);
      }
      this.reloadRoles();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.saving.set(false);
    }
  }

  protected remove(): void {
    const role = this.stored();
    if (!role || this.deleteBlocked()) return;
    const name = role.attributes.name;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.roles.delete.title', { name }),
      zDescription: this.t('editor.admin.roles.delete.description'),
      zOkText: this.t('editor.admin.roles.delete.action'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runDelete(role),
    });
  }

  private async runDelete(role: RoleItem): Promise<void> {
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.delete('/roles/{roleId}', { path: { roleId: role.id } }),
      );
      this.toast.success(
        translated('editor.admin.roles.deleted', {
          name: role.attributes.name,
        }),
      );
      // Gone from the list at once, so the next role (not this one again) is shown.
      const doc = this.rolesDoc();
      if (doc) {
        this.rolesDoc.set({
          ...doc,
          data: doc.data.filter((r) => r.id !== role.id),
        });
      }
      this.stored.set(null);
      this.view.set({ role: undefined }, { replace: true });
      this.reloadRoles();
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.saving.set(false);
    }
  }

  /** Adds the picked holder: a picker value is `user:<id>` or `service:<id>`. */
  protected async addHolder(value: string): Promise<void> {
    const roleId = this.editedId();
    if (!value || !roleId) return;
    this.pick.set(value);
    if (value.startsWith(SERVICE_PICK)) {
      const serviceAccountId = value.slice(SERVICE_PICK.length);
      await this.changeHolder(value, async () => {
        await firstValueFrom(
          this.api.act(
            '/service-accounts/{serviceAccountId}/relationships/roles',
            { path: { serviceAccountId } },
            { data: [{ type: 'Role', id: roleId }] },
          ),
        );
      });
      return;
    }
    const userId = value.slice(USER_PICK.length);
    await this.changeHolder(userId, async () => {
      await firstValueFrom(
        this.api.act(
          '/users/{userId}/relationships/roles',
          { path: { userId } },
          { data: [{ type: 'Role', id: roleId }] },
        ),
      );
    });
  }

  /**
   * `user` holds the edited role only through a sign-in group (#37): listed, but taken only by
   * the group mappings, so no remove button.
   */
  protected heldViaGroup(user: UserItem): boolean {
    const roleId = this.editedId();
    return !!roleId && (user.meta?.groupRoleIds?.includes(roleId) ?? false);
  }

  protected async removeHolder(user: UserItem): Promise<void> {
    const roleId = this.editedId();
    if (!roleId) return;
    await this.changeHolder(user.id, async () => {
      await firstValueFrom(
        this.api.delete(
          '/users/{userId}/relationships/roles',
          { path: { userId: user.id } },
          { data: [{ type: 'Role', id: roleId }] },
        ),
      );
    });
  }

  protected async removeServiceHolder(
    account: ServiceAccountItem,
  ): Promise<void> {
    const roleId = this.editedId();
    if (!roleId) return;
    await this.changeHolder(SERVICE_PICK + account.id, async () => {
      await firstValueFrom(
        this.api.delete(
          '/service-accounts/{serviceAccountId}/relationships/roles',
          { path: { serviceAccountId: account.id } },
          { data: [{ type: 'Role', id: roleId }] },
        ),
      );
    });
  }

  /** `holder` is a user's ID, or `service:<id>` for a service account. */
  private async changeHolder(
    holder: string,
    change: () => Promise<void>,
  ): Promise<void> {
    this.changingHolder.set(holder);
    try {
      await change();
      this.reloadHolders();
      if (holder.startsWith(SERVICE_PICK)) void this.loadServices();
      else void this.loadPeople();
      void this.loadStored(this.editedId(), true);
      if (holder === this.me.me().id)
        void this.me.refresh(true).catch(() => false);
    } catch (error) {
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      this.changingHolder.set(null);
      this.pick.set('');
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      this.storedConfig.set(doc.data.attributes);
    } catch {
      this.configFailed.set(true);
    }
  }

  private async loadPeople(): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/users', {
          query: {
            'filter[status]': 'active',
            ...pageQuery({ number: 1, size: CANDIDATES }),
          },
        }),
      );
      this.people.set(doc.data);
    } catch {
      // The picker stays empty; removing still works.
    }
  }

  private async loadServices(): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/service-accounts', {
          query: {
            'filter[status]': 'active',
            ...pageQuery({ number: 1, size: CANDIDATES }),
          },
        }),
      );
      this.services.set(doc.data);
    } catch {
      // The picker offers people only; removing still works.
    }
  }

  private async loadRoles(page: number): Promise<void> {
    const run = ++this.rolesRuns;
    this.rolesLoading.set(true);
    this.rolesFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/roles', {
          query: pageQuery({ number: page, size: ROLE_PAGE_SIZE }),
        }),
      );
      if (run === this.rolesRuns) this.rolesDoc.set(doc);
    } catch (error) {
      if (run === this.rolesRuns) this.rolesFailure.set(toApiError(error));
    } finally {
      if (run === this.rolesRuns) this.rolesLoading.set(false);
    }
  }

  /** Reads the role to show; `keepDraft` keeps unsaved changes (only its holders changed). */
  private async loadStored(
    id: string | undefined,
    keepDraft = false,
  ): Promise<void> {
    const run = ++this.storedRuns;
    const saves = this.saveRuns;
    if (!id) {
      this.stored.set(null);
      this.storedLoading.set(false);
      return;
    }
    if (this.stored()?.id !== id) this.storedLoading.set(true);
    try {
      const doc = await firstValueFrom(
        this.api.get('/roles/{roleId}', { path: { roleId: id } }),
      );
      if (run !== this.storedRuns) return;
      const before = this.stored();
      // Saved while this read was open: the save's answer is the newer role; the read adds
      // only its holders (it began after they changed).
      const read =
        before?.id === id && saves !== this.saveRuns
          ? { ...before, meta: doc.data.meta }
          : doc.data;
      const keep = keepDraft && before?.id === id && this.dirty();
      this.stored.set(read);
      if (!keep) {
        this.draft.set(draftOf(read));
        this.submitted.set(false);
      }
    } catch (error) {
      if (run !== this.storedRuns) return;
      this.stored.set(null);
      this.toast.error(apiErrorText(toApiError(error)));
    } finally {
      if (run === this.storedRuns) this.storedLoading.set(false);
    }
  }

  private async loadHolders(
    id: string | undefined,
    page: number,
  ): Promise<void> {
    const run = ++this.holderRuns;
    if (!id) {
      this.holdersDoc.set(null);
      return;
    }
    this.holdersLoading.set(true);
    this.holdersFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/users', {
          query: {
            'filter[role]': id,
            ...pageQuery({ number: page, size: HOLDER_PAGE_SIZE }),
          },
        }),
      );
      if (run === this.holderRuns) this.holdersDoc.set(doc);
    } catch (error) {
      if (run === this.holderRuns) this.holdersFailure.set(toApiError(error));
    } finally {
      if (run === this.holderRuns) this.holdersLoading.set(false);
    }
  }

  private async loadServiceHolders(
    id: string | undefined,
    page: number,
  ): Promise<void> {
    const run = ++this.serviceHolderRuns;
    if (!id) {
      this.serviceHoldersDoc.set(null);
      return;
    }
    this.serviceHoldersLoading.set(true);
    this.serviceHoldersFailure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/service-accounts', {
          query: {
            'filter[role]': id,
            ...pageQuery({ number: page, size: HOLDER_PAGE_SIZE }),
          },
        }),
      );
      if (run === this.serviceHolderRuns) this.serviceHoldersDoc.set(doc);
    } catch (error) {
      if (run === this.serviceHolderRuns)
        this.serviceHoldersFailure.set(toApiError(error));
    } finally {
      if (run === this.serviceHolderRuns) this.serviceHoldersLoading.set(false);
    }
  }
}
