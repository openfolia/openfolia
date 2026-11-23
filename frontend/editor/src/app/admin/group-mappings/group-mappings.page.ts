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
import { firstValueFrom } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { DatePipe, injectTranslate, translated } from '@openfolia/ui/i18n';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Response,
} from '../../api';
import { apiErrorText } from '../../i18n';
import { MeService } from '../../permissions/me';
import { PasswordSession } from '../../session/password-session';
import { idParam, injectQueryState, intParam } from '../../view-state';
import { injectAdminActions } from '../admin-actions';
import type { RoleItem } from '../admin-model';
import { loadAllRoles } from '../roles-source';
import { GroupMappingDialogComponent } from './group-mapping-dialog.component';
import {
  type GroupMappingItem,
  isRoleFilter,
  MAPPING_PAGE_SIZES,
  type MappingDraft,
} from './group-mappings-model';

type MappingDoc = Response<'/group-mappings'>;

/** Space kept below the frame: the notes under it and the page's bottom padding. */
const BELOW_FRAME_PX = 96;

/**
 * The Group mappings tab of Admin (#592): which identity-provider group's members hold which role
 * (`/group-mappings`, #37), by group, then role; a filter by role (in the address, so the Roles
 * page links here for one role). "Add mapping" (the header's action) opens the dialog; Remove asks
 * first. A removal that would leave nobody who can manage roles (409 `last-admin`) says so in
 * plain words. Needs `admin.roles`.
 */
@Component({
  selector: 'of-group-mappings-page',
  imports: [
    TranslocoPipe,
    DatePipe,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSelectImports,
    ZardTableImports,
    GroupMappingDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <p class="text-muted-foreground m-0 max-w-prose text-sm break-words">
      {{ 'editor.admin.groupMappings.intro' | transloco }}
    </p>
    <div class="flex flex-wrap items-center gap-3">
      <z-select
        class="w-full sm:w-64"
        zSearchable
        data-filter="role"
        [zPrefix]="'editor.admin.groupMappings.filter.role' | transloco"
        [zAriaLabel]="'editor.admin.groupMappings.filter.role' | transloco"
        [zValue]="role()"
        (zSelectionChange)="setRole($event)"
      >
        <!-- By value and label: an item's label is read once, and the filtered role is named
             by its ID until the roles are read. -->
        @for (o of roleOptions(); track o.value + ':' + o.label) {
          <z-select-item [zValue]="o.value">{{ o.label }}</z-select-item>
        }
      </z-select>
    </div>

    <of-list-frame
      #frame
      class="min-h-64 min-w-0"
      [label]="'editor.admin.groupMappings.table.label' | transloco"
      [items]="doc()?.data ?? []"
      [page]="doc()?.meta?.page ?? null"
      [loading]="loading()"
      [error]="frameError()"
      [offset]="offset()"
      [pageSizes]="pageSizes"
      [emptyTitle]="
        (filtered()
          ? 'editor.admin.groupMappings.empty.filteredTitle'
          : 'editor.admin.groupMappings.empty.title'
        ) | transloco
      "
      [emptyDescription]="
        (filtered()
          ? 'editor.admin.groupMappings.empty.filteredDescription'
          : 'editor.admin.groupMappings.empty.description'
        ) | transloco
      "
      (pageChange)="view.set({ page: $event })"
      (pageSizeChange)="view.set({ size: $event, page: 1 })"
      (retry)="reload()"
    >
      <ng-template ofListTable let-items>
        <table z-table class="w-full table-fixed">
          <thead z-table-header class="bg-background sticky top-0 z-10">
            <tr z-table-row>
              <th z-table-head>
                {{ 'editor.admin.groupMappings.table.group' | transloco }}
              </th>
              <th z-table-head class="w-[28%]">
                {{ 'editor.admin.groupMappings.table.role' | transloco }}
              </th>
              <!-- Left out at phone width, so the group and its Remove button fit. -->
              <th z-table-head class="hidden w-44 md:table-cell">
                {{ 'editor.admin.groupMappings.table.added' | transloco }}
              </th>
              <th z-table-head class="w-28">
                <span class="sr-only">{{
                  'editor.admin.groupMappings.table.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            @for (m of asMappings(items); track m.id) {
              <tr z-table-row [ofListItem]="m">
                <td
                  z-table-cell
                  class="align-top font-mono text-sm whitespace-normal [overflow-wrap:anywhere]"
                >
                  {{ m.attributes.group }}
                </td>
                <td z-table-cell class="align-top whitespace-normal">
                  <z-badge
                    zType="outline"
                    class="h-auto max-w-full break-words whitespace-normal"
                    >{{ roleName(m.relationships.role.data.id) }}</z-badge
                  >
                </td>
                <td
                  z-table-cell
                  class="text-muted-foreground hidden align-top text-sm whitespace-normal md:table-cell"
                >
                  {{ m.attributes.createdAt | ofDate: dateFormat }}
                </td>
                <td z-table-cell class="text-end align-top">
                  <button
                    z-button
                    zType="outline"
                    zSize="sm"
                    type="button"
                    [zLoading]="removing() === m.id"
                    [zDisabled]="removing() !== null"
                    [attr.aria-label]="
                      'editor.admin.groupMappings.actions.removeLabel'
                        | transloco
                          : {
                              group: m.attributes.group,
                              role: roleName(m.relationships.role.data.id),
                            }
                    "
                    (click)="remove(m)"
                  >
                    {{
                      'editor.admin.groupMappings.actions.remove' | transloco
                    }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </ng-template>
    </of-list-frame>

    @if (noProvider()) {
      <p
        class="text-muted-foreground m-0 text-xs break-words"
        data-testid="no-provider"
      >
        {{ 'editor.admin.groupMappings.noProvider' | transloco }}
      </p>
    }
    <p class="text-muted-foreground m-0 text-xs break-words">
      {{ 'editor.admin.note' | transloco }}
    </p>

    <of-group-mapping-dialog
      [(open)]="dialogOpen"
      [roles]="roles()"
      [initialRole]="role()"
      [busy]="saving()"
      [error]="saveError()"
      (save)="save($event)"
    />
  `,
})
export class GroupMappingsPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly passwords = inject(PasswordSession);
  private readonly t = injectTranslate();

  protected readonly view = injectQueryState({
    role: idParam(isRoleFilter),
    page: intParam(1),
    size: intParam(MAPPING_PAGE_SIZES[0], { only: MAPPING_PAGE_SIZES }),
  });
  /** The role filtered by, as the address has it; '' for all. */
  protected readonly role = computed(() => this.view.get('role')() ?? '');
  protected readonly pageSizes = MAPPING_PAGE_SIZES;
  protected readonly dateFormat: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };

  protected readonly doc = signal<MappingDoc | null>(null);
  protected readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  protected readonly roles = signal<readonly RoleItem[]>([]);
  protected readonly dialogOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  /** The mapping a removal is under way for. */
  protected readonly removing = signal<string | null>(null);
  protected readonly offset = signal('20rem');
  private readonly frame = viewChild('frame', { read: ElementRef });
  private runs = 0;

  protected readonly filtered = computed(() => this.role() !== '');

  /** No identity provider is set up (#37): the mappings wait for one. */
  protected readonly noProvider = computed(
    () => this.passwords.options()?.providers === 0,
  );

  private readonly roleNames = computed(
    () => new Map(this.roles().map((r) => [r.id, r.attributes.name])),
  );

  protected readonly roleOptions = computed(() => {
    const options = [
      { value: '', label: this.t('editor.admin.groupMappings.filter.all') },
      ...[...this.roles()]
        .sort((a, b) => a.attributes.name.localeCompare(b.attributes.name))
        .map((r) => ({ value: r.id, label: r.attributes.name })),
    ];
    // The filtered role before the roles are read (or one deleted meanwhile): still shown.
    const role = this.role();
    if (role && !options.some((o) => o.value === role)) {
      options.push({ value: role, label: role });
    }
    return options;
  });

  protected readonly frameError = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    const text = apiErrorText(failure);
    return { kind: failure.kind, message: this.t(text.key, text.params) };
  });

  constructor() {
    effect(() => {
      const query = {
        role: this.role(),
        page: this.view.get('page')(),
        size: this.view.get('size')(),
      };
      this.reloads();
      untracked(() => void this.load(query));
    });
    void this.loadRoles();
    void this.passwords.loadOptions();
    injectAdminActions()?.on('group-mappings', () => this.add());

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
      this.noProvider();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected asMappings(items: readonly unknown[]): readonly GroupMappingItem[] {
    return items as readonly GroupMappingItem[];
  }

  protected roleName(id: string): string {
    return this.roleNames().get(id) ?? id;
  }

  protected setRole(value: string | string[]): void {
    const role = typeof value === 'string' && value ? value : undefined;
    if ((role ?? '') === this.role()) return;
    this.view.set({ role, page: 1 });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected add(): void {
    this.saveError.set('');
    this.dialogOpen.set(true);
  }

  protected async save(draft: MappingDraft): Promise<void> {
    this.saving.set(true);
    this.saveError.set('');
    try {
      await firstValueFrom(
        this.api.post('/group-mappings', {
          data: {
            type: 'GroupMapping',
            attributes: { group: draft.group },
            relationships: {
              role: { data: { type: 'Role', id: draft.roleId } },
            },
          },
        }),
      );
      this.toast.success(
        translated('editor.admin.groupMappings.added', {
          group: draft.group,
          role: this.roleName(draft.roleId),
        }),
      );
      this.dialogOpen.set(false);
      this.reload();
      // One's own roles may have changed: a mapping applies at once to the group's members.
      void this.me.refresh(true).catch(() => false);
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.saveError.set(this.t(text.key, text.params));
    } finally {
      this.saving.set(false);
    }
  }

  protected remove(mapping: GroupMappingItem): void {
    const params = {
      group: mapping.attributes.group,
      role: this.roleName(mapping.relationships.role.data.id),
    };
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.groupMappings.remove.title'),
      zDescription: this.t(
        'editor.admin.groupMappings.remove.description',
        params,
      ),
      zOkText: this.t('editor.admin.groupMappings.actions.remove'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runRemove(mapping, params),
    });
  }

  private async runRemove(
    mapping: GroupMappingItem,
    params: { group: string; role: string },
  ): Promise<void> {
    this.removing.set(mapping.id);
    try {
      await firstValueFrom(
        this.api.delete('/group-mappings/{mappingId}', {
          path: { mappingId: mapping.id },
        }),
      );
      this.toast.success(
        translated('editor.admin.groupMappings.remove.done', params),
      );
      // The last row of a later page: the page before it, once this one is empty.
      const doc = this.doc();
      const page = this.view.get('page')();
      if (doc && doc.data.length === 1 && page > 1) {
        this.view.set({ page: page - 1 });
      } else {
        this.reload();
      }
      // One's own roles may have changed.
      void this.me.refresh(true).catch(() => false);
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'last-admin') {
        // Said in plain words, and kept until read: nothing was removed.
        this.dialogs.warning({
          zTitle: this.t('editor.admin.groupMappings.lastAdmin.title'),
          zDescription: this.t(
            'editor.admin.groupMappings.lastAdmin.description',
            params,
          ),
          zOkText: this.t('editor.admin.groupMappings.lastAdmin.ok'),
        });
      } else {
        this.toast.error(apiErrorText(failure));
        // Gone already (removed elsewhere): the list shows what is left.
        if (failure.code === 'not-found') this.reload();
      }
    } finally {
      this.removing.set(null);
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
    role: string;
    page: number;
    size: number;
  }): Promise<void> {
    const run = ++this.runs;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const doc = await firstValueFrom(
        this.api.get('/group-mappings', {
          query: {
            ...(query.role ? { 'filter[role]': query.role } : {}),
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
