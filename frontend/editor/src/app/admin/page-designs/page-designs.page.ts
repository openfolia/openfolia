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
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideFileCode,
  lucideGitBranch,
  lucideInfo,
  lucidePlus,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import type { PageDesignPreset } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFrameError,
  type ListFramePage,
} from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSelectComponent, ZardSelectImports } from '@openfolia/ui/select';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { SaveStatusComponent } from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError, type Schema } from '../../api';
import { apiErrorText } from '../../i18n';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import { ChangeSetSession } from '../../session/change-set-session';
import { ChangeSetUrl } from '../../session/change-set-url';
import { injectOwnDraft } from '../../session/own-draft';
import { injectAdminActions } from '../admin-actions';
import { ConfigDraft, type ConfigChangeSet } from '../settings/config-draft';
import { createDesign } from './design-draft';
import {
  DESIGN_NAME_MAX,
  designIdProblem,
  idFromName,
  newDesign,
  PRESETS,
} from './design-model';
import { createTemplate } from './template-draft';
import { templateIdProblem, TEMPLATE_ID_MAX } from './template-files';

/** Templates per page of their list, paged in the screen. */
const TEMPLATE_PAGE_SIZE = 10;
/** Designs per page of the list, paged in the screen. */
const PAGE_SIZE = 20;
/** Designs per read of `GET /page-designs` (the API's most): all of them, in one request while there are no more. */
const READ_SIZE = 200;
/** The most reads of the list: a safety stop, never reached by designs as few as a project has. */
const MAX_READS = 10;
const BUILTIN = 'builtin';
/** Why the settings are read-only that a draft of the person's own would end. */
const DRAFT_REASONS: ReadonlySet<string> = new Set([
  'editor.admin.settings.blocked.needsChangeSet',
  'editor.admin.settings.blocked.notDraft',
  'editor.admin.settings.blocked.notAuthor',
]);

type DesignRow =
  Schema<'PageDesignResource'> | Schema<'UnreadablePageDesignResource'>;

const PRESET_NAMES: Readonly<Record<string, string>> = {
  classic: 'editor.admin.pageDesigns.layout.presets.classic',
  'image-led': 'editor.admin.pageDesigns.layout.presets.imageLed',
  minimal: 'editor.admin.pageDesigns.layout.presets.minimal',
};

/**
 * Admin › Page design (#392): the page designs at the chosen change set's branch
 * (`GET /page-designs`, paged, in their own scroller), each opening its editor; the project's
 * default design (`pdf.design` in the configuration, saved into the change set's configuration
 * working copy like the project settings, so only who may change the settings sets it); and
 * "New design" (the admin header's action), which makes the design in the change set
 * (`createDesign`) and opens it. Everyone who reads drafts sees the list.
 */
@Component({
  selector: 'of-page-designs-page',
  imports: [
    TranslocoPipe,
    NgIcon,
    RouterLink,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDialogImports,
    ZardInputComponent,
    ZardSelectImports,
    ListFrameComponent,
    ListRowDirective,
    SegmentedComponent,
    SaveStatusComponent,
    FadeInDirective,
    ZardSwitchComponent,
  ],
  providers: [ConfigDraft],
  viewProviders: [
    provideIcons({
      lucideChevronRight,
      lucideFileCode,
      lucideGitBranch,
      lucideInfo,
      lucidePlus,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <p
      class="text-muted-foreground m-0 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      data-slot="designs-status"
    >
      <ng-icon
        name="lucideInfo"
        class="shrink-0"
        size="16"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 break-words">{{
        statusText()
          | transloco: { changeSet: changeSets.selected()?.title ?? '' }
      }}</span>
    </p>

    <section
      class="bg-card flex max-w-4xl min-w-0 flex-col gap-2 rounded-xl border p-4"
      aria-labelledby="designs-default"
      data-slot="default-design"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="designs-default" class="m-0 text-sm font-medium">
          {{ 'editor.admin.pageDesigns.default.title' | transloco }}
        </h2>
        <z-select
          #defaultSelect
          class="w-full min-w-0 sm:w-72"
          zPosition="popper"
          data-slot="default-select"
          [zDisabled]="!defaultEditable()"
          [zAriaLabel]="'editor.admin.pageDesigns.default.title' | transloco"
          [zValue]="defaultId()"
          (zSelectionChange)="setDefault($any($event))"
        >
          <z-select-item [zValue]="builtin">{{
            'editor.admin.pageDesigns.default.builtin' | transloco
          }}</z-select-item>
          @for (d of readable(); track d.id) {
            <z-select-item [zValue]="d.id">{{ d.name }}</z-select-item>
          }
        </z-select>
        @if (config.saveState(); as s) {
          <of-save-status [status]="s" />
        }
        @if (draftOffered()) {
          <button
            ofFadeIn
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-slot="default-in-draft"
            [zLoading]="drafting()"
            (click)="changeInDraft()"
          >
            <ng-icon
              name="lucideGitBranch"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.admin.pageDesigns.default.inDraft' | transloco }}
          </button>
        }
      </div>
      <p class="text-muted-foreground m-0 text-xs break-words">
        {{
          (defaultEditable()
            ? 'editor.admin.pageDesigns.default.hint'
            : draftOffered()
              ? 'editor.admin.pageDesigns.default.inDraftHint'
              : 'editor.admin.pageDesigns.default.readOnly'
          ) | transloco
        }}
      </p>
    </section>

    <of-list-frame
      class="min-h-48 max-w-4xl min-w-0"
      offset="20rem"
      [label]="'editor.admin.pageDesigns.list.label' | transloco"
      [items]="rows()"
      [page]="shownPage()"
      [loading]="loading()"
      [error]="frameError()"
      [skeletonRows]="3"
      [emptyTitle]="'editor.admin.pageDesigns.list.empty' | transloco"
      [emptyDescription]="
        'editor.admin.pageDesigns.list.emptyDescription' | transloco
      "
      (pageChange)="pageNumber.set($event)"
      (retry)="load()"
    >
      <ng-template ofListRow let-item>
        @let d = asRow(item);
        <a
          class="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 outline-none focus-visible:ring-2"
          [routerLink]="d.id"
          [queryParams]="linkQuery()"
          [attr.data-design]="d.id"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="min-w-0 text-sm font-medium break-words">{{
                nameOf(d)
              }}</span>
              @if (d.id === defaultId()) {
                <z-badge zType="secondary" data-slot="default-badge">{{
                  'editor.admin.pageDesigns.default.badge' | transloco
                }}</z-badge>
              }
            </span>
            <span
              class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
            >
              @if ('error' in d.meta) {
                {{
                  'editor.admin.pageDesigns.list.unreadable'
                    | transloco: { id: d.id }
                }}
              } @else {
                {{
                  'editor.admin.pageDesigns.list.facts'
                    | transloco
                      : {
                          id: d.id,
                          preset: (presetName(d) | transloco),
                          issues: d.meta.issues.length,
                        }
                }}
              }
            </span>
          </span>
          <ng-icon
            name="lucideChevronRight"
            class="text-muted-foreground shrink-0"
            size="16"
            aria-hidden="true"
          />
        </a>
      </ng-template>
    </of-list-frame>

    <section
      class="flex max-w-4xl min-w-0 flex-col gap-3"
      aria-labelledby="designs-templates"
      data-slot="own-templates"
    >
      <div
        class="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="designs-templates" class="m-0 text-base font-semibold">
            {{ 'editor.admin.pageDesigns.templates.list.heading' | transloco }}
          </h2>
          <p class="text-muted-foreground m-0 max-w-2xl text-xs break-words">
            {{ 'editor.admin.pageDesigns.templates.list.hint' | transloco }}
          </p>
        </div>
        @if (mayCreate()) {
          <button
            ofFadeIn
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-slot="new-template"
            (click)="openCreateTemplate()"
          >
            <ng-icon
              name="lucidePlus"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.admin.pageDesigns.templates.create.action' | transloco }}
          </button>
        }
      </div>
      <of-list-frame
        class="min-h-32 min-w-0"
        offset="22rem"
        [label]="'editor.admin.pageDesigns.templates.list.label' | transloco"
        [items]="templateRows()"
        [page]="templatePage()"
        [loading]="templatesLoading()"
        [error]="templatesError()"
        [skeletonRows]="2"
        [emptyTitle]="
          'editor.admin.pageDesigns.templates.list.empty' | transloco
        "
        [emptyDescription]="
          'editor.admin.pageDesigns.templates.list.emptyDescription' | transloco
        "
        (pageChange)="templatePageNumber.set($event)"
        (retry)="loadTemplates()"
      >
        <ng-template ofListRow let-item>
          @let id = asTemplate(item).id;
          <a
            class="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 outline-none focus-visible:ring-2"
            [routerLink]="['templates', id]"
            [queryParams]="linkQuery()"
            [attr.data-template]="id"
          >
            <ng-icon
              name="lucideFileCode"
              class="text-muted-foreground shrink-0"
              size="16"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="min-w-0 font-mono text-sm font-medium break-all">{{
                id
              }}</span>
              <span
                class="text-muted-foreground text-xs [overflow-wrap:anywhere]"
                >{{ templateUse(id) }}</span
              >
            </span>
            <ng-icon
              name="lucideChevronRight"
              class="text-muted-foreground shrink-0"
              size="16"
              aria-hidden="true"
            />
          </a>
        </ng-template>
      </of-list-frame>
    </section>

    <z-dialog
      class="sm:max-w-md"
      [zVisible]="creatingTemplate()"
      (zVisibleChange)="$event || closeCreateTemplate()"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.admin.pageDesigns.templates.create.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.pageDesigns.templates.create.hint' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      <form
        id="new-template-form"
        class="flex min-w-0 flex-col gap-1.5"
        novalidate
        (submit)="createNewTemplate($event)"
      >
        <label class="text-sm" for="new-template-id">{{
          'editor.admin.pageDesigns.templates.create.name' | transloco
        }}</label>
        <input
          id="new-template-id"
          z-input
          type="text"
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
          cdkFocusInitial
          [attr.maxlength]="templateIdMax"
          [value]="newTemplateId()"
          [attr.aria-invalid]="
            templateProblem() && newTemplateId() ? 'true' : null
          "
          aria-describedby="new-template-id-hint"
          (input)="typeTemplateId($any($event.target).value)"
        />
        <p
          id="new-template-id-hint"
          class="m-0 text-xs break-words"
          [class.text-destructive]="!!templateProblem() && !!newTemplateId()"
          [class.text-muted-foreground]="!templateProblem() || !newTemplateId()"
        >
          {{
            (templateProblem() && newTemplateId()
              ? templateProblem()!
              : 'editor.admin.pageDesigns.templates.create.nameHint'
            ) | transloco
          }}
        </p>
      </form>
      <z-dialog-footer>
        <button
          z-button
          zType="ghost"
          type="button"
          (click)="closeCreateTemplate()"
        >
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="new-template-form"
          data-slot="new-template-create"
          [zLoading]="savingTemplate()"
          [zDisabled]="!!templateProblem()"
        >
          {{ 'editor.admin.pageDesigns.templates.create.submit' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>

    <z-dialog
      class="sm:max-w-lg"
      [zVisible]="creating()"
      (zVisibleChange)="$event || closeCreate()"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.admin.pageDesigns.create.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.pageDesigns.create.hint' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      <form
        id="new-design-form"
        class="flex min-w-0 flex-col gap-4"
        novalidate
        (submit)="create($event)"
      >
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="text-sm" for="new-design-name">{{
            'editor.admin.pageDesigns.create.name' | transloco
          }}</label>
          <input
            id="new-design-name"
            z-input
            type="text"
            autocomplete="off"
            cdkFocusInitial
            [attr.maxlength]="nameMax"
            [value]="newName()"
            (input)="typeName($any($event.target).value)"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="text-sm" for="new-design-id">{{
            'editor.admin.pageDesigns.create.id' | transloco
          }}</label>
          <input
            id="new-design-id"
            z-input
            type="text"
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            maxlength="64"
            [value]="newId()"
            [attr.aria-invalid]="idProblem() && newId() ? 'true' : null"
            aria-describedby="new-design-id-hint"
            (input)="typeId($any($event.target).value)"
          />
          <p
            id="new-design-id-hint"
            class="m-0 text-xs break-words"
            [class.text-destructive]="!!idProblem() && !!newId()"
            [class.text-muted-foreground]="!idProblem() || !newId()"
          >
            {{
              (idProblem() && newId()
                ? idProblem()!
                : 'editor.admin.pageDesigns.create.idHint'
              ) | transloco
            }}
          </p>
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <span class="text-sm">{{
            'editor.admin.pageDesigns.layout.title' | transloco
          }}</span>
          <of-segmented
            data-slot="new-design-preset"
            [options]="presetOptions()"
            [value]="newPreset()"
            [label]="'editor.admin.pageDesigns.layout.title' | transloco"
            (valueChange)="newPreset.set($any($event))"
          />
        </div>
        @if (mayChangeDefault()) {
          <div class="flex min-w-0 flex-col gap-1.5">
            <z-switch
              data-slot="new-design-default"
              [zChecked]="newAsDefault()"
              (zCheckedChange)="newAsDefault.set($event)"
              >{{
                'editor.admin.pageDesigns.create.asDefault' | transloco
              }}</z-switch
            >
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{
                (defaultId() === builtin
                  ? 'editor.admin.pageDesigns.create.asDefaultHint'
                  : 'editor.admin.pageDesigns.create.asDefaultReplaces'
                ) | transloco: { name: defaultName() }
              }}
            </p>
          </div>
        }
      </form>
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="closeCreate()">
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="new-design-form"
          data-slot="new-design-create"
          [zLoading]="saving()"
          [zDisabled]="!!idProblem() || !newName().trim()"
        >
          {{ 'editor.admin.pageDesigns.create.action' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class PageDesignsPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly permissions = inject(PermissionService);
  private readonly me = inject(MeService);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly injector = inject(Injector);
  private readonly ownDraft = injectOwnDraft();
  private readonly t = injectTranslate();
  private readonly defaultSelect =
    viewChild<ZardSelectComponent>('defaultSelect');
  protected readonly changeSets = inject(ChangeSetSession);
  protected readonly config = inject(ConfigDraft);

  protected readonly builtin = BUILTIN;
  protected readonly nameMax = DESIGN_NAME_MAX;
  protected readonly pageNumber = signal(1);
  /** Every design at the revision, read once per load (#557); null before the first answer. */
  private readonly designs = signal<readonly DesignRow[] | null>(null);
  protected readonly loading = signal(false);
  private readonly loadError = signal<ListFrameError | null>(null);
  /** Every design's ID and name, for the default's choice and the IDs taken. */
  private readonly all = computed(() =>
    (this.designs() ?? []).map((d) => ({ id: d.id, name: this.nameOf(d) })),
  );

  protected readonly creating = signal(false);
  protected readonly saving = signal(false);
  protected readonly newName = signal('');
  protected readonly newId = signal('');
  private idTyped = false;
  protected readonly newPreset = signal<PageDesignPreset>('classic');
  /** The new design becomes the project's default, in the same revision (#589). */
  protected readonly newAsDefault = signal(false);
  /** "Change in a draft" is choosing or starting the person's draft. */
  protected readonly drafting = signal(false);
  /** The default's choice opens once the configuration can be changed (after "Change in a draft"). */
  private readonly openDefault = signal(false);

  private readonly lastPage = computed(() =>
    Math.max(1, Math.ceil((this.designs()?.length ?? 0) / PAGE_SIZE)),
  );
  /** The page shown: the one asked for, or the last there is when fewer remain. */
  private readonly currentPage = computed(() =>
    Math.min(this.pageNumber(), this.lastPage()),
  );
  protected readonly rows = computed(() => {
    const start = (this.currentPage() - 1) * PAGE_SIZE;
    return (this.designs() ?? []).slice(start, start + PAGE_SIZE);
  });
  protected readonly shownPage = computed((): ListFramePage | null => {
    const designs = this.designs();
    if (!designs) return null;
    return {
      currentPage: this.currentPage(),
      lastPage: this.lastPage(),
      perPage: PAGE_SIZE,
      total: designs.length,
    };
  });
  protected readonly frameError = computed(() => this.loadError());
  protected readonly readable = computed(() => this.all());
  protected readonly linkQuery = computed(() => this.csLink.params());

  private readonly changeSet = computed((): ConfigChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });

  /** Whether the person may make a design in the chosen change set (a draft of theirs). */
  protected readonly mayCreate = computed(() => {
    if (
      this.permissions.state({ permission: 'content.edit' }).kind === 'hidden'
    )
      return false;
    const cs = this.changeSet();
    return (
      !!cs &&
      cs.state === 'draft' &&
      (cs.authorId === '' || cs.authorId === this.me.me().id)
    );
  });

  protected readonly statusText = computed(() => {
    if (
      this.permissions.state({ permission: 'content.edit' }).kind === 'hidden'
    ) {
      return 'editor.admin.pageDesigns.status.readOnly';
    }
    const cs = this.changeSet();
    if (!cs) return 'editor.admin.pageDesigns.blocked.needsChangeSet';
    if (cs.state !== 'draft')
      return 'editor.admin.pageDesigns.blocked.notDraft';
    if (cs.authorId !== '' && cs.authorId !== this.me.me().id) {
      return 'editor.admin.pageDesigns.blocked.notAuthor';
    }
    return 'editor.admin.pageDesigns.savedIn';
  });

  protected readonly defaultId = computed(
    () => this.config.config()?.pdf.design ?? BUILTIN,
  );
  protected readonly defaultEditable = computed(
    () =>
      this.config.mode().kind === 'edit' && this.config.status() === 'ready',
  );
  /** Whether the person may make the new design the default here: they may change the settings now. */
  protected readonly mayChangeDefault = computed(() => this.defaultEditable());
  /** The default's name, for the create dialog's hint. */
  protected readonly defaultName = computed(() => {
    const id = this.defaultId();
    return id === BUILTIN
      ? this.t('editor.admin.pageDesigns.default.builtin')
      : (this.all().find((d) => d.id === id)?.name ?? id);
  });
  /**
   * "Change in a draft" (#589): the person's role may change the settings, but not in the chosen
   * revision (none, not a draft, or someone else's). A role that never may sees the read-only text.
   */
  protected readonly draftOffered = computed(() => {
    const mode = this.config.mode();
    if (this.config.status() !== 'ready' || mode.kind !== 'read') return false;
    return DRAFT_REASONS.has(mode.reason ?? '');
  });

  protected readonly presetOptions = computed((): SegmentedOption[] =>
    PRESETS.map((p) => ({
      value: p,
      label: this.t(PRESET_NAMES[p] as string),
    })),
  );

  protected readonly idProblem = computed(() =>
    designIdProblem(
      this.newId(),
      this.all().map((d) => d.id),
    ),
  );

  private reads = 0;

  // --- Own templates (#396) ---

  protected readonly templateIdMax = TEMPLATE_ID_MAX;
  /** The own templates at the revision (with the person's drafts); null before the first answer. */
  private readonly templates = signal<readonly string[] | null>(null);
  protected readonly templatesLoading = signal(false);
  protected readonly templatesError = signal<ListFrameError | null>(null);
  protected readonly templatePageNumber = signal(1);
  protected readonly creatingTemplate = signal(false);
  protected readonly savingTemplate = signal(false);
  protected readonly newTemplateId = signal('');
  private templateReads = 0;

  private readonly lastTemplatePage = computed(() =>
    Math.max(
      1,
      Math.ceil((this.templates()?.length ?? 0) / TEMPLATE_PAGE_SIZE),
    ),
  );
  protected readonly templateRows = computed(() => {
    const page = Math.min(this.templatePageNumber(), this.lastTemplatePage());
    const start = (page - 1) * TEMPLATE_PAGE_SIZE;
    return (this.templates() ?? [])
      .slice(start, start + TEMPLATE_PAGE_SIZE)
      .map((id) => ({ id }));
  });
  protected readonly templatePage = computed((): ListFramePage | null => {
    const templates = this.templates();
    if (!templates) return null;
    return {
      currentPage: Math.min(this.templatePageNumber(), this.lastTemplatePage()),
      lastPage: this.lastTemplatePage(),
      perPage: TEMPLATE_PAGE_SIZE,
      total: templates.length,
    };
  });
  protected readonly templateProblem = computed(() =>
    templateIdProblem(this.newTemplateId(), this.templates() ?? []),
  );

  protected asTemplate(item: unknown): { id: string } {
    return item as { id: string };
  }

  /** Which designs name the template, by name. */
  protected templateUse(id: string): string {
    const using = (this.designs() ?? []).filter(
      (d) => 'template' in d.attributes && d.attributes.template === id,
    );
    return using.length === 0
      ? this.t('editor.admin.pageDesigns.templates.list.unused', {
          folder: `templates/${id}/`,
        })
      : this.t('editor.admin.pageDesigns.templates.list.usedBy', {
          folder: `templates/${id}/`,
          designs: using.map((d) => this.nameOf(d)).join(', '),
        });
  }

  /** Reads the own templates at the revision, the person's drafts with them. */
  protected async loadTemplates(): Promise<void> {
    const read = ++this.templateReads;
    this.templatesLoading.set(true);
    this.templatesError.set(null);
    const cs = this.changeSet();
    try {
      const doc = await firstValueFrom(
        this.api.get('/page-design-templates', {
          query: {
            ...pageQuery({ number: 1, size: READ_SIZE }),
            ...(cs && this.mayCreate() ? { workingCopy: 'true' } : {}),
          } as never,
        }),
      );
      if (read !== this.templateReads) return;
      this.templates.set(doc.data.map((t) => t.id));
    } catch (error) {
      if (read !== this.templateReads) return;
      const e = toApiError(error);
      this.templatesError.set({ kind: e.kind, message: e.message });
    } finally {
      if (read === this.templateReads) this.templatesLoading.set(false);
    }
  }

  protected openCreateTemplate(): void {
    if (!this.mayCreate()) {
      this.toast.show(translated(this.statusText()), { kind: 'info' });
      return;
    }
    this.newTemplateId.set('');
    this.creatingTemplate.set(true);
  }

  protected closeCreateTemplate(): void {
    if (this.savingTemplate()) return;
    this.creatingTemplate.set(false);
  }

  protected typeTemplateId(value: string): void {
    this.newTemplateId.set(value.trim());
  }

  protected async createNewTemplate(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.newTemplateId();
    const cs = this.changeSet();
    if (this.templateProblem() || !cs || this.savingTemplate()) return;
    this.savingTemplate.set(true);
    try {
      await createTemplate(this.api, cs.id, id);
      this.creatingTemplate.set(false);
      void this.router.navigate(['templates', id], {
        relativeTo: this.route,
        queryParams: this.linkQuery(),
      });
    } catch (error) {
      const why = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.admin.pageDesigns.templates.create.failed', {
          why: this.t(why.key, why.params),
        }),
      );
    } finally {
      this.savingTemplate.set(false);
    }
  }

  constructor() {
    effect(() => {
      this.changeSet();
      if (this.changeSets.switching()) return;
      untracked(() => {
        this.pageNumber.set(1);
        this.templatePageNumber.set(1);
        void this.load();
        void this.loadTemplates();
      });
    });
    effect(() => {
      this.changeSet();
      this.me.me();
      // A switch unanswered: nothing of the person before is saved under the next (#716).
      if (this.changeSets.switching()) {
        untracked(() => this.config.forget());
        return;
      }
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => void this.config.load(this.changeSet()));
    });
    injectAdminActions()?.on('page-designs', () => this.openCreate());
    // After "Change in a draft": the default's choice opens once the draft's settings are read.
    effect(() => {
      if (!this.openDefault() || !this.defaultEditable()) return;
      untracked(() => {
        this.openDefault.set(false);
        afterNextRender(
          () => {
            const select = this.defaultSelect();
            if (select && !select.isOpen()) select.toggle();
          },
          { injector: this.injector },
        );
      });
    });
  }

  /**
   * "Change in a draft" (#589): chooses the person's own draft revision (the chosen one, else
   * their newest) or starts one, as the screens that need a draft do; the page then reads its
   * settings and the default's choice opens.
   */
  protected async changeInDraft(): Promise<void> {
    if (this.drafting()) return;
    this.drafting.set(true);
    try {
      const id = await this.ownDraft(
        this.t('editor.admin.pageDesigns.default.draftTitle'),
      );
      if (id) this.openDefault.set(true);
    } finally {
      this.drafting.set(false);
    }
  }

  /** Leaving the screen: a default set here becomes a save point first, as in the settings. */
  async leave(): Promise<boolean> {
    if (this.config.mode().kind === 'edit') await this.config.savePoint();
    return true;
  }

  protected asRow(item: unknown): DesignRow {
    return item as DesignRow;
  }

  protected nameOf(row: DesignRow): string {
    return 'name' in row.attributes ? (row.attributes.name as string) : row.id;
  }

  protected presetName(row: DesignRow): string {
    const preset =
      'preset' in row.attributes ? (row.attributes.preset as string) : '';
    return (
      PRESET_NAMES[preset] ?? 'editor.admin.pageDesigns.layout.presets.unknown'
    );
  }

  /**
   * Reads every design at the revision (`GET /page-designs`, paged by the API, #557): one
   * request while there are no more than `READ_SIZE`, the next pages only past that. The list
   * pages them here, so turning a page reads nothing; the default's choice and the IDs taken use
   * the same answer.
   */
  protected async load(): Promise<void> {
    const read = ++this.reads;
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const found: DesignRow[] = [];
      for (let page = 1; page <= MAX_READS; page++) {
        const doc = await firstValueFrom(
          this.api.get('/page-designs', {
            query: pageQuery({ number: page, size: READ_SIZE }),
          }),
        );
        if (read !== this.reads) return;
        found.push(...doc.data);
        if (page >= doc.meta.page.lastPage) break;
      }
      this.designs.set(found);
    } catch (error) {
      if (read !== this.reads) return;
      const e = toApiError(error);
      this.loadError.set({ kind: e.kind, message: e.message });
    } finally {
      if (read === this.reads) this.loading.set(false);
    }
  }

  /** Saves `value` as the default into the revision's settings; false when it cannot be sent. */
  protected setDefault(value: string | string[]): boolean {
    const id = Array.isArray(value) ? value[0] : value;
    const c = this.config.config();
    if (!id || !c) return false;
    if (id === this.defaultId()) return true;
    const pdf = { ...c.pdf };
    if (id === BUILTIN) delete pdf.design;
    else pdf.design = id;
    return this.config.change(
      { ...c, pdf },
      translated('editor.admin.pageDesigns.default.change'),
    );
  }

  protected openCreate(): void {
    if (!this.mayCreate()) {
      this.toast.show(translated(this.statusText()), { kind: 'info' });
      return;
    }
    this.newName.set('');
    this.newId.set('');
    this.idTyped = false;
    this.newPreset.set('classic');
    // On while the project uses the built-in design: a first design is mostly meant to be used.
    this.newAsDefault.set(this.defaultId() === BUILTIN);
    this.creating.set(true);
  }

  protected closeCreate(): void {
    if (this.saving()) return;
    this.creating.set(false);
  }

  protected typeName(value: string): void {
    this.newName.set(value);
    if (!this.idTyped) this.newId.set(idFromName(value));
  }

  protected typeId(value: string): void {
    this.idTyped = true;
    this.newId.set(value.trim());
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newName().replace(/\s+/g, ' ').trim();
    const id = this.newId();
    const cs = this.changeSet();
    if (!name || this.idProblem() || !cs || this.saving()) return;
    this.saving.set(true);
    try {
      await createDesign(
        this.api,
        cs.id,
        newDesign(id, name, this.newPreset()),
      );
      // The default in the same revision: saved into its settings like a choice in the select,
      // and waited for. One that could not be saved is said (the settings' own message says
      // why); the design was made all the same, and opens.
      if (this.newAsDefault() && this.mayChangeDefault()) {
        const saved = this.setDefault(id) && (await this.config.settled());
        if (!saved) {
          this.toast.error(
            translated('editor.admin.pageDesigns.create.notDefault', { name }),
          );
        }
      }
      this.creating.set(false);
      void this.router.navigate([id], {
        relativeTo: this.route,
        queryParams: this.linkQuery(),
      });
    } catch (error) {
      const why = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.admin.pageDesigns.create.failed', {
          why: this.t(why.key, why.params),
        }),
      );
    } finally {
      this.saving.set(false);
    }
  }
}
