import {
  type LocalizedText,
  sourceTextOf,
} from '@openfolia/content-model/core';
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
import {
  lucideArchive,
  lucideArchiveRestore,
  lucideBookOpen,
  lucideFileText,
  lucidePlus,
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFrameError,
  type ListFramePage,
} from '@openfolia/ui/list-frame';
import { SegmentedComponent } from '@openfolia/ui/segmented';
import { FadeInDirective } from '@openfolia/ui/smooth';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type Response,
} from '../../api';
import { type ProjectLanguages, UiTextPipe } from '../../i18n';
import { LocalizedTextFieldsComponent } from '../../shared/localized-text-fields.component';
import { ChangeSetUrl } from '../../session/change-set-url';
import {
  labelProblem,
  type UsageCount,
  type VariantAttribute,
} from '../settings/config-model';
import { valueCondition, type VariantValue } from './variant-edits';

type Use = Response<'/variants/{attributeId}/usages'>['data'][number];
type Build = Response<'/variants/matches'>['data'][number];

/** What the usage list shows: the content naming it, or the builds it appears in (a value only). */
export type UsageTab = 'content' | 'builds';
export const USAGE_TABS: readonly UsageTab[] = ['content', 'builds'];

/** Rows per page of the usage list. */
export const USAGE_PAGE_SIZE = 20;

interface Loaded<T> {
  readonly key: string;
  readonly items: readonly T[];
  readonly page: ListFramePage;
}

/**
 * The right side of the Variants tab (screen 21): the chosen attribute or value. Its label is
 * changed in place (on leaving the field or Enter), its ID and group are shown (fixed: content
 * names them). For a value: whether content uses it (a warning that says so, archiving instead
 * of removing), and the paged list of where (`GET /variants/:attributeId/usages`) or of the builds
 * it appears in (`GET /variants/matches`), each a link. Archive, Restore and Remove are asked
 * for (`archive`, `restore`, `remove`); the page decides, and offers Undo.
 */
@Component({
  selector: 'of-variant-detail',
  imports: [
    LocalizedTextFieldsComponent,
    UiTextPipe,
    TranslocoPipe,
    NgIcon,
    RouterLink,
    FadeInDirective,
    ListFrameComponent,
    ListRowDirective,
    SegmentedComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideArchive,
      lucideArchiveRestore,
      lucideBookOpen,
      lucideFileText,
      lucidePlus,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border bg-background flex min-w-0 flex-col gap-5 rounded-xl border p-4 sm:p-5',
  },
  template: `
    @let a = attribute();
    @let v = value();
    <header class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 class="m-0 min-w-0 text-xl font-semibold break-words">
        {{ src(v ? v.label : a.label) }}
      </h2>
      @if (v?.archived) {
        <z-badge zType="secondary" data-slot="archived-badge">{{
          'editor.admin.settings.option.archived' | transloco
        }}</z-badge>
      }
      @if (!v) {
        <z-badge zType="outline">{{
          (a.kind === 'enum'
            ? 'editor.admin.settings.variants.kindEnum'
            : 'editor.admin.settings.variants.kindVersion'
          ) | transloco
        }}</z-badge>
      }
    </header>

    @if (inUse(); as c) {
      <div
        ofFadeIn
        role="note"
        class="border-warning bg-warning-muted text-foreground flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm"
        data-slot="in-use-note"
      >
        <ng-icon
          name="lucideTriangleAlert"
          class="text-warning mt-0.5 shrink-0"
          size="16"
          aria-hidden="true"
        />
        <p class="m-0 min-w-0 break-words">
          {{
            (v
              ? v.archived
                ? 'editor.admin.variants.detail.inUseArchived'
                : 'editor.admin.variants.detail.inUseValue'
              : 'editor.admin.variants.detail.inUseAttribute'
            )
              | transloco
                : {
                    modules: c.modules,
                    manuals: c.manuals,
                    builds: builds()?.page?.total ?? 0,
                  }
          }}
        </p>
      </div>
    }

    <div class="grid min-w-0 gap-4 sm:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1.5">
        <label class="text-muted-foreground text-sm" for="variant-label">{{
          'editor.admin.variants.detail.label' | transloco
        }}</label>
        <input
          id="variant-label"
          z-input
          autocomplete="off"
          maxlength="200"
          [disabled]="!editable()"
          [attr.lang]="languages()?.source ?? null"
          [value]="src(v ? v.label : a.label)"
          (change)="renameFrom($any($event.target))"
          (keydown.enter)="$any($event.target).blur()"
        />
        @if (languages(); as langs) {
          <of-localized-text-fields
            data-slot="variant-languages"
            [text]="v ? v.label : a.label"
            [languages]="langs"
            [idPrefix]="'variant-label-' + a.id + (v ? '-' + v.id : '')"
            [name]="'editor.admin.variants.detail.label' | transloco"
            [editable]="editable()"
            [showSource]="false"
            [maxlength]="200"
            (changed)="relabel.emit($event)"
          />
        }
      </div>
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-muted-foreground text-sm" id="variant-group-label">{{
          (v
            ? 'editor.admin.variants.detail.group'
            : 'editor.admin.variants.detail.kind'
          ) | transloco
        }}</span>
        <input
          z-input
          disabled
          aria-labelledby="variant-group-label"
          [value]="
            v
              ? src(a.label)
              : ((a.kind === 'enum'
                  ? 'editor.admin.settings.variants.kindEnum'
                  : 'editor.admin.settings.variants.kindVersion'
                ) | transloco)
          "
        />
      </div>
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-muted-foreground text-sm">{{
          'editor.admin.variants.detail.key' | transloco
        }}</span>
        <code
          class="bg-muted self-start rounded-md px-3 py-2 font-mono text-sm break-all"
          data-slot="variant-key"
          >{{ v ? v.id : a.id }}</code
        >
      </div>
      @if (!v && a.kind === 'enum') {
        <div class="flex min-w-0 flex-col gap-1.5">
          <span class="text-muted-foreground text-sm">{{
            'editor.admin.variants.detail.values' | transloco
          }}</span>
          <span class="py-2 text-sm tabular-nums">{{
            'editor.admin.variants.detail.valueCount'
              | transloco: { count: a.values.length, archived: archivedCount() }
          }}</span>
        </div>
      }
    </div>

    @if (!v && a.kind === 'version') {
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'editor.admin.settings.variants.versionHint' | transloco }}
      </p>
    }

    <section
      class="flex min-w-0 flex-col gap-3"
      aria-labelledby="variant-usage-title"
    >
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 id="variant-usage-title" class="m-0 text-sm font-medium">
          {{ 'editor.admin.variants.detail.usage' | transloco }}
        </h3>
        @if (v) {
          <of-segmented
            [label]="'editor.admin.variants.detail.usage' | transloco"
            [options]="tabOptions()"
            [value]="tab()"
            (valueChange)="tabChange.emit($any($event))"
          />
        }
      </div>
      @if (shownTab() === 'content') {
        <of-list-frame
          [label]="'editor.admin.variants.detail.usesLabel' | transloco"
          [items]="uses()?.items ?? []"
          [page]="uses()?.page ?? null"
          [loading]="usesLoading()"
          [error]="usesError()"
          [skeletonRows]="3"
          offset="30rem"
          [emptyTitle]="'editor.admin.variants.detail.noUses' | transloco"
          (pageChange)="pageChange.emit($event)"
          (retry)="reload()"
        >
          <ng-template ofListRow let-item>
            @let u = asUse(item);
            <a
              class="hover:bg-muted focus-visible:ring-ring/50 -mx-2 -my-1 flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
              [routerLink]="useLink(u).commands"
              [queryParams]="useLink(u).query"
              [attr.data-use]="u.id"
            >
              <ng-icon
                [name]="
                  u.attributes.kind === 'manual'
                    ? 'lucideBookOpen'
                    : 'lucideFileText'
                "
                class="text-muted-foreground mt-0.5 shrink-0"
                size="16"
                aria-hidden="true"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="break-words">{{
                  u.attributes.title | uiText
                }}</span>
                <span class="text-muted-foreground text-xs break-words">{{
                  u.attributes.kind === 'manual'
                    ? ('editor.admin.variants.detail.manual' | transloco)
                    : ('editor.admin.variants.detail.module'
                      | transloco
                        : { languages: u.attributes.languages.join(', ') })
                }}</span>
              </span>
            </a>
          </ng-template>
        </of-list-frame>
      } @else {
        <of-list-frame
          [label]="'editor.admin.variants.detail.buildsLabel' | transloco"
          [items]="builds()?.items ?? []"
          [page]="builds()?.page ?? null"
          [loading]="buildsLoading()"
          [error]="buildsError()"
          [skeletonRows]="3"
          offset="30rem"
          [emptyTitle]="'editor.admin.variants.detail.noBuilds' | transloco"
          (pageChange)="pageChange.emit($event)"
          (retry)="reload()"
        >
          <ng-template ofListRow let-item>
            @let b = asBuild(item);
            <a
              class="hover:bg-muted focus-visible:ring-ring/50 -mx-2 -my-1 flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
              routerLink="/manuals"
              [queryParams]="buildLink(b)"
              [attr.data-build]="b.id"
            >
              <ng-icon
                name="lucideBookOpen"
                class="text-muted-foreground mt-0.5 shrink-0"
                size="16"
                aria-hidden="true"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="break-words">{{ b.meta.manualTitle }}</span>
                <span class="text-muted-foreground text-xs break-words">{{
                  b.meta.label
                }}</span>
              </span>
            </a>
          </ng-template>
        </of-list-frame>
      }
    </section>

    @if (editable()) {
      <div
        class="border-border flex min-w-0 flex-wrap items-center gap-2 border-t pt-4"
      >
        @if (v) {
          @if (v.archived) {
            <button
              z-button
              zType="outline"
              type="button"
              data-slot="restore"
              (click)="restore.emit()"
            >
              <ng-icon
                name="lucideArchiveRestore"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.settings.option.restore' | transloco }}
            </button>
          } @else {
            <button
              z-button
              zType="outline"
              type="button"
              data-slot="archive"
              (click)="archive.emit()"
            >
              <ng-icon
                name="lucideArchive"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.settings.option.archive' | transloco }}
            </button>
          }
        } @else if (a.kind === 'enum') {
          <button
            z-button
            zType="outline"
            type="button"
            data-slot="add-value"
            (click)="addValue.emit()"
          >
            <ng-icon
              name="lucidePlus"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.admin.settings.variants.addValue' | transloco }}
          </button>
        }
        <button
          z-button
          zType="ghost"
          type="button"
          class="text-destructive ms-auto"
          data-slot="remove"
          [disabled]="lastValue()"
          [attr.title]="
            lastValue()
              ? ('editor.admin.settings.option.lastOne' | transloco)
              : null
          "
          (click)="remove.emit()"
        >
          <ng-icon
            name="lucideTrash2"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.admin.settings.option.remove' | transloco }}
        </button>
      </div>
    }
  `,
})
export class VariantDetailComponent {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly t = injectTranslate();

  readonly attribute = input.required<VariantAttribute>();
  /** A value of `attribute`; undefined: the attribute itself is shown. */
  readonly value = input<VariantValue | undefined>(undefined);
  readonly editable = input(false);
  /** How much content the person can see names it (`GET /config/usages`); null when unknown. */
  readonly count = input<UsageCount | null>(null);
  readonly tab = input<UsageTab>('content');
  /** The usage list's page (from the address). */
  readonly page = input(1);
  /** Changes when what the lists read may have changed (a save point): they are read again. */
  readonly reloadKey = input(0);

  /** The project's languages: the label is given in each (#731). */
  readonly languages = input<ProjectLanguages | null>(null);

  /** The source language's label, renamed. */
  readonly rename = output<string>();
  /** The label in every language (#731). */
  readonly relabel = output<LocalizedText>();
  readonly archive = output<void>();
  readonly restore = output<void>();
  readonly remove = output<void>();
  readonly addValue = output<void>();
  readonly tabChange = output<UsageTab>();
  readonly pageChange = output<number>();

  protected readonly uses = signal<Loaded<Use> | null>(null);
  protected readonly usesLoading = signal(false);
  protected readonly usesError = signal<ListFrameError | null>(null);
  protected readonly builds = signal<Loaded<Build> | null>(null);
  protected readonly buildsLoading = signal(false);
  protected readonly buildsError = signal<ListFrameError | null>(null);
  private reads = 0;

  /** The builds tab is a value's only. */
  protected readonly shownTab = computed<UsageTab>(() =>
    this.value() ? this.tab() : 'content',
  );

  protected readonly tabOptions = computed(() => [
    {
      value: 'content',
      label: this.t('editor.admin.variants.detail.tabs.content'),
      count: this.uses()?.page.total ?? null,
    },
    {
      value: 'builds',
      label: this.t('editor.admin.variants.detail.tabs.builds'),
      count: this.builds()?.page.total ?? null,
    },
  ]);

  /** The counts when content uses it, else null. */
  protected readonly inUse = computed(() => {
    const c = this.count();
    const builds = this.builds()?.page.total ?? 0;
    if (!c && builds === 0) return null;
    const counted = c ?? { modules: 0, manuals: 0 };
    return counted.modules + counted.manuals + builds > 0 ? counted : null;
  });

  protected readonly archivedCount = computed(() => {
    const a = this.attribute();
    return a.kind === 'enum' ? a.values.filter((v) => v.archived).length : 0;
  });

  /** An enum attribute keeps at least one value. */
  protected readonly lastValue = computed(() => {
    const a = this.attribute();
    return !!this.value() && a.kind === 'enum' && a.values.length <= 1;
  });

  /** The IDs alone: a rename or an archive of the shown item reads its lists again only when they change. */
  private readonly attributeId = computed(() => this.attribute().id);
  private readonly valueId = computed(() => this.value()?.id);

  constructor() {
    effect(() => {
      const a = this.attributeId();
      const v = this.valueId();
      const page = this.page();
      const tab = this.shownTab();
      this.reloadKey();
      this.readRef.ref();
      this.readRef.moves();
      untracked(() => void this.read(a, v, tab, page));
    });
  }

  protected reload(): void {
    void this.read(
      this.attribute().id,
      this.value()?.id,
      this.shownTab(),
      this.page(),
    );
  }

  /**
   * Reads the shown list's page, and the first row of the other (for its count). Rows on screen
   * stay, dimmed, while the next answer comes; an answer to an older read is dropped.
   */
  private async read(
    attribute: string,
    value: string | undefined,
    tab: UsageTab,
    page: number,
  ): Promise<void> {
    const read = ++this.reads;
    const key = `${attribute}\n${value ?? ''}`;
    const stale = () => read !== this.reads;
    // Another attribute or value: the old rows are not this one's.
    if (this.uses()?.key !== key) this.uses.set(null);
    if (this.builds()?.key !== key) this.builds.set(null);
    this.usesLoading.set(true);
    this.usesError.set(null);
    this.buildsLoading.set(value !== undefined);
    this.buildsError.set(null);
    const usesPage = tab === 'content' ? page : 1;
    const usesSize = tab === 'content' ? USAGE_PAGE_SIZE : 1;
    const buildsPage = tab === 'builds' ? page : 1;
    const buildsSize = tab === 'builds' ? USAGE_PAGE_SIZE : 1;
    await Promise.all([
      firstValueFrom(
        this.api.get('/variants/{attributeId}/usages', {
          path: { attributeId: attribute },
          query: {
            ...(value === undefined ? {} : { 'filter[value]': value }),
            ...pageQuery({ number: usesPage, size: usesSize }),
          },
        }),
      ).then(
        (doc) => {
          if (stale()) return;
          this.uses.set({ key, items: doc.data, page: doc.meta.page });
          this.usesLoading.set(false);
        },
        (error: unknown) => {
          if (stale()) return;
          const e = toApiError(error);
          this.usesError.set({ kind: e.kind, message: e.message });
          this.usesLoading.set(false);
        },
      ),
      value === undefined
        ? Promise.resolve()
        : firstValueFrom(
            this.api.get('/variants/matches', {
              query: {
                when: valueCondition(attribute, value),
                ...pageQuery({ number: buildsPage, size: buildsSize }),
              },
            }),
          ).then(
            (doc) => {
              if (stale()) return;
              this.builds.set({ key, items: doc.data, page: doc.meta.page });
              this.buildsLoading.set(false);
            },
            (error: unknown) => {
              if (stale()) return;
              const e = toApiError(error);
              // A value not committed to the branch yet: no build can name it.
              if (e.status === 422 && e.code === 'unknown-variant') {
                this.builds.set({
                  key,
                  items: [],
                  page: {
                    currentPage: 1,
                    lastPage: 1,
                    perPage: buildsSize,
                    total: 0,
                  },
                });
              } else {
                this.buildsError.set({ kind: e.kind, message: e.message });
              }
              this.buildsLoading.set(false);
            },
          ),
    ]);
  }

  /** A label in the source language: what the field renames (#731). */
  protected src(label: LocalizedText): string {
    if (typeof label === 'string') return label;
    const source = this.languages()?.source;
    return (
      (source && sourceTextOf(label, source)) ?? Object.values(label)[0] ?? ''
    );
  }

  protected renameFrom(field: HTMLInputElement): void {
    const v = this.value();
    const before = this.src(v ? v.label : this.attribute().label);
    const label = field.value.trim().replace(/\s+/g, ' ');
    if (labelProblem(label) !== null || label === before) {
      field.value = before;
      return;
    }
    this.rename.emit(label);
  }

  protected asUse(item: unknown): Use {
    return item as Use;
  }

  protected asBuild(item: unknown): Build {
    return item as Build;
  }

  protected useLink(u: Use): {
    commands: string[];
    query: Record<string, string>;
  } {
    const query = this.csLink.params();
    if (u.attributes.kind === 'manual') {
      return {
        commands: ['/manuals'],
        query: { ...query, manual: u.attributes.manualId },
      };
    }
    return {
      commands: [
        '/content',
        u.attributes.languages[0] ?? '',
        u.attributes.moduleId,
      ],
      query,
    };
  }

  protected buildLink(b: Build): Record<string, string> {
    return {
      ...this.csLink.params(),
      manual: b.relationships.manual.data.id,
      variant: b.meta.slug,
    };
  }
}
