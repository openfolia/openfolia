import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { type LocalizedText, withTextIn } from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucidePencil,
  lucidePlus,
  lucideTrash2,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import {
  SortableListComponent,
  SortableRowDirective,
  type SortableItem,
} from '@openfolia/ui/sortable-list';
import { ToastService } from '@openfolia/ui/toast';

import { LocalizedTextFieldsComponent } from '../../shared/localized-text-fields.component';
import { idParam, injectQueryState } from '../../view-state';
import {
  CONFIG_KEY,
  isProductFacet,
  LABEL_MAX,
  keyFromLabel,
  setFacets,
  sourceLabel,
  type ProjectConfig,
} from './config-model';
import { InlineLabelComponent } from './inline-label.component';
import {
  OptionListComponent,
  type OptionListChange,
  type OptionRow,
} from './option-list.component';
import {
  OptionNewDialogComponent,
  type NewOption,
} from './option-new-dialog.component';
import { SettingsContext } from './settings-context';
import type { SettingsTopicPage } from './settings-topics';

type Facet = ProjectConfig['facets'][number];

/**
 * Settings › Facets, as master and detail (like #91's variant editor): on the left the facets in
 * order (chosen by a click, reordered by their grip, a new one added at the foot); on the right
 * the chosen facet: its label (renamed in place), ID, usage and ⋯ menu, then its values read
 * first (`of-option-list`). The topic's Add button adds a value to the chosen facet (a facet
 * first when there is none). The chosen facet is in the address (`facet`).
 */
@Component({
  selector: 'of-settings-facets',
  imports: [
    TranslocoPipe,
    NgIcon,
    InlineLabelComponent,
    LocalizedTextFieldsComponent,
    OptionListComponent,
    OptionNewDialogComponent,
    SortableListComponent,
    SortableRowDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDropdownImports,
  ],
  viewProviders: [
    provideIcons({ lucideEllipsis, lucidePencil, lucidePlus, lucideTrash2 }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: '@container block max-w-4xl min-w-0' },
  template: `
    <div
      class="grid min-w-0 items-start gap-4 @3xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]"
    >
      <div
        class="border-border bg-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border"
        data-slot="facet-list"
      >
        <div
          class="min-h-0 overflow-y-auto p-2"
          style="max-height: calc(100dvh - 20rem)"
        >
          @if (rows().length === 0) {
            <p class="text-muted-foreground m-0 p-3 text-sm">
              {{ 'editor.admin.settings.facets.none' | transloco }}
            </p>
          } @else {
            <of-sortable-list
              [items]="rows()"
              [label]="'editor.admin.settings.sections.facets' | transloco"
              [readonly]="!ctx.editable()"
              (itemsChange)="reorder($event)"
            >
              <ng-template ofSortableRow let-item>
                <button
                  type="button"
                  class="hover:bg-muted focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-start text-sm transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
                  [class.bg-muted]="item.id === selected()?.id"
                  [class.font-medium]="item.id === selected()?.id"
                  [attr.aria-current]="
                    item.id === selected()?.id ? 'true' : null
                  "
                  [attr.data-facet]="item.id"
                  (click)="choose(item.id)"
                >
                  <span class="min-w-0 flex-1 break-words">{{
                    item.label
                  }}</span>
                  <span
                    class="text-muted-foreground shrink-0 text-xs tabular-nums"
                    >{{ valueCount(item.id) }}</span
                  >
                </button>
              </ng-template>
            </of-sortable-list>
          }
        </div>
        @if (ctx.editable()) {
          <div class="border-border border-t p-2">
            <button
              z-button
              zType="ghost"
              zSize="sm"
              type="button"
              class="w-full justify-start"
              data-slot="new-facet"
              (click)="adding.set('facet')"
            >
              <ng-icon
                name="lucidePlus"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.admin.settings.facets.newFacet' | transloco }}
            </button>
          </div>
        }
      </div>

      @if (selected(); as f) {
        <div
          class="border-border flex min-w-0 flex-col gap-4 rounded-xl border p-4 sm:p-5"
          data-slot="facet-detail"
          [attr.data-facet]="f.id"
        >
          <div class="flex min-w-0 items-start gap-2">
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <of-inline-label
                  #name
                  class="text-base font-medium"
                  [label]="src(f.label)"
                  [editable]="ctx.editable()"
                  [ariaLabel]="
                    'editor.admin.settings.option.labelOf'
                      | transloco: { id: f.id }
                  "
                  (rename)="rename(f, $event)"
                />
                @if (isProduct(f.id)) {
                  <z-badge zType="info">{{
                    'editor.admin.settings.facets.products' | transloco
                  }}</z-badge>
                }
              </div>
              <p
                class="text-muted-foreground m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
              >
                <code class="font-mono break-all">{{ f.id }}</code>
                @if (ctx.countOf({ kind: 'facet', valueId: f.id }); as n) {
                  <span data-slot="usage">{{
                    'editor.admin.settings.usage.short' | transloco: n
                  }}</span>
                }
              </p>
              @if (ctx.languages(); as langs) {
                <of-localized-text-fields
                  class="mt-1"
                  data-slot="facet-languages"
                  [text]="f.label"
                  [languages]="langs"
                  [idPrefix]="'facet-label-' + f.id"
                  [name]="'editor.admin.settings.option.labelName' | transloco"
                  [editable]="ctx.editable()"
                  [showSource]="false"
                  [maxlength]="labelMax"
                  (changed)="relabel(f, $event)"
                />
              }
            </div>
            @if (ctx.editable()) {
              <button
                z-button
                zType="ghost"
                zSize="icon-sm"
                type="button"
                class="shrink-0"
                data-slot="facet-menu"
                z-dropdown
                [zDropdownMenu]="menu"
                [attr.aria-label]="
                  'editor.admin.settings.option.actionsOf'
                    | transloco: { label: src(f.label) }
                "
              >
                <ng-icon name="lucideEllipsis" aria-hidden="true" />
              </button>
              <z-dropdown-menu-content #menu class="w-56">
                <z-dropdown-menu-item (click)="editSoon(name)">
                  <ng-icon name="lucidePencil" aria-hidden="true" />
                  {{ 'editor.admin.settings.option.rename' | transloco }}
                </z-dropdown-menu-item>
                <z-dropdown-menu-separator />
                <z-dropdown-menu-item
                  zType="destructive"
                  data-action="facet-delete"
                  (click)="removeFacet(f)"
                >
                  <ng-icon name="lucideTrash2" aria-hidden="true" />
                  {{ 'editor.admin.settings.option.delete' | transloco }}
                </z-dropdown-menu-item>
              </z-dropdown-menu-content>
            }
          </div>
          <div class="flex min-w-0 flex-col gap-1">
            <h3 class="text-muted-foreground m-0 text-xs font-medium">
              {{ 'editor.admin.settings.facets.values' | transloco }}
            </h3>
            <of-option-list
              usageKind="facetValue"
              [framed]="false"
              maxHeight="calc(100dvh - 26rem)"
              [items]="f.values"
              [label]="src(f.label)"
              [languages]="ctx.languages()"
              [editable]="ctx.editable()"
              [min]="1"
              [usageParent]="f.id"
              [counts]="ctx.counts()"
              [linkQuery]="ctx.linkQuery()"
              (changed)="setValues(f, $event)"
              (remove)="removeValue(f, $event)"
            />
          </div>
        </div>
      } @else {
        <p
          class="border-border text-muted-foreground m-0 rounded-xl border p-5 text-sm"
        >
          {{ 'editor.admin.settings.facets.noneChosen' | transloco }}
        </p>
      }
    </div>

    <of-option-new-dialog
      [open]="adding() !== null"
      [title]="
        (adding() === 'facet'
          ? 'editor.admin.settings.facets.newFacet'
          : 'editor.admin.settings.facets.addValueTo'
        ) | transloco: { facet: src(selected()?.label ?? '') }
      "
      [rule]="adding() === 'facet' ? 'facets' : 'facetValues'"
      [taken]="taken()"
      [withFirst]="adding() === 'facet'"
      [languages]="ctx.languages()"
      (add)="add($event)"
      (closed)="adding.set(null)"
    />
  `,
})
export class FacetsTopicPage implements SettingsTopicPage {
  protected readonly ctx = inject(SettingsContext);
  private readonly toast = inject(ToastService);
  private readonly view = injectQueryState({ facet: idParam(CONFIG_KEY) });

  protected readonly facets = computed(
    (): readonly Facet[] => this.ctx.config()?.facets ?? [],
  );
  protected readonly rows = computed((): SortableItem[] =>
    this.facets().map((f) => ({ id: f.id, label: this.src(f.label) })),
  );
  protected readonly labelMax = LABEL_MAX;
  /** The facet shown: the address's while it exists, else the first. */
  protected readonly selected = computed(() => {
    const wanted = this.view.get('facet')();
    const facets = this.facets();
    return facets.find((f) => f.id === wanted) ?? facets[0];
  });
  /** What the Add dialog adds; null: closed. */
  protected readonly adding = signal<'facet' | 'value' | null>(null);
  protected readonly taken = computed(() =>
    this.adding() === 'facet'
      ? this.facets().map((f) => f.id)
      : (this.selected()?.values.map((v) => v.id) ?? []),
  );

  openAdd(): void {
    this.adding.set(this.selected() ? 'value' : 'facet');
  }

  /** A label in the source language: what the settings show and rename in place (#731). */
  protected src(label: LocalizedText): string {
    const c = this.ctx.config();
    return c ? sourceLabel(c, label) : typeof label === 'string' ? label : '';
  }

  protected choose(id: string): void {
    this.view.set({ facet: id });
  }

  protected valueCount(id: string): number {
    return this.facets().find((f) => f.id === id)?.values.length ?? 0;
  }

  protected isProduct(id: string): boolean {
    const c = this.ctx.config();
    return !!c && isProductFacet(c, id);
  }

  /** The menu's Rename, once the menu has given the focus back (see `OptionListComponent`). */
  protected editSoon(name: InlineLabelComponent): void {
    setTimeout(() => name.edit(), 30);
  }

  private saveFacets(
    facets: readonly Facet[],
    what: TranslatedText,
    done?: TranslatedText,
  ): boolean {
    const c = this.ctx.config();
    if (!c) return false;
    return this.ctx.save(
      setFacets(c, facets),
      what,
      done && { part: 'facets', done },
    );
  }

  private replace(next: Facet, what: TranslatedText): void {
    this.saveFacets(
      this.facets().map((f) => (f.id === next.id ? next : f)),
      what,
    );
  }

  protected reorder(rows: readonly SortableItem[]): void {
    const byId = new Map(this.facets().map((f) => [f.id, f]));
    this.saveFacets(
      rows.flatMap((r) => {
        const f = byId.get(r.id);
        return f ? [f] : [];
      }),
      translated('editor.admin.settings.changes.reorder'),
    );
  }

  /** The source language's label renamed in place: the other languages' stay as they are. */
  protected rename(f: Facet, label: string): void {
    const source = this.ctx.languages()?.source;
    this.replace(
      {
        ...f,
        label: source ? withTextIn(f.label, source, source, label) : label,
      },
      translated('editor.admin.settings.changes.rename', { label }),
    );
  }

  /** The other languages' labels (#731). */
  protected relabel(f: Facet, label: LocalizedText): void {
    this.replace(
      { ...f, label },
      translated('editor.admin.settings.changes.relabel', {
        label: this.src(f.label),
      }),
    );
  }

  protected setValues(f: Facet, change: OptionListChange): void {
    this.replace(
      { ...f, values: change.items.map((v) => ({ id: v.id, label: v.label })) },
      change.what,
    );
  }

  protected add(option: NewOption): void {
    const kind = this.adding();
    this.adding.set(null);
    const label = this.src(option.label);
    const done = translated('editor.admin.settings.done.add', { label });
    const what = translated('editor.admin.settings.changes.add', { label });
    if (kind === 'facet') {
      const first = option.first ?? label;
      const facet: Facet = {
        id: option.id,
        label: option.label,
        values: [{ id: keyFromLabel(first), label: first }],
      };
      if (this.saveFacets([...this.facets(), facet], what, done)) {
        this.view.set({ facet: facet.id });
      }
      return;
    }
    const f = this.selected();
    if (!f) return;
    this.saveFacets(
      this.facets().map((x) =>
        x.id === f.id
          ? {
              ...x,
              values: [...x.values, { id: option.id, label: option.label }],
            }
          : x,
      ),
      what,
      done,
    );
  }

  protected removeFacet(f: Facet): void {
    if (this.isProduct(f.id)) {
      this.toast.error(
        translated('editor.admin.settings.facets.productFacet', {
          label: this.src(f.label),
        }),
      );
      return;
    }
    this.ctx.remove({ kind: 'facet', valueId: f.id }, f.label, 'facets', (c) =>
      setFacets(
        c,
        c.facets.filter((x) => x.id !== f.id),
      ),
    );
  }

  protected removeValue(f: Facet, value: OptionRow): void {
    this.ctx.remove(
      { kind: 'facetValue', valueId: value.id, parentId: f.id },
      value.label,
      'facets',
      (c) =>
        setFacets(
          c,
          c.facets.map((x) =>
            x.id === f.id
              ? { ...x, values: x.values.filter((v) => v.id !== value.id) }
              : x,
          ),
        ),
    );
  }
}
