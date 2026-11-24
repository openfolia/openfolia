import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import {
  type LocalizedText,
  ownTextIn,
  sourceTextOf,
  withTextIn,
} from '@openfolia/content-model/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideLanguages,
  lucidePencil,
  lucideRotateCcw,
  lucideTrash2,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import {
  SortableListComponent,
  SortableRowDirective,
} from '@openfolia/ui/sortable-list';

import type { ProjectLanguages } from '../../i18n';
import { LocalizedTextFieldsComponent } from '../../shared/localized-text-fields.component';
import {
  contentFilter,
  LABEL_MAX,
  usageKey,
  type ConfigUsageKind,
  type UsageCount,
} from './config-model';
import { InlineLabelComponent } from './inline-label.component';

/** One row of an option list: a value of the configuration. */
export interface OptionRow {
  readonly id: string;
  /** One text, or one per language (#731; code languages: always one). */
  readonly label: LocalizedText;
  /** A module type that needs `content.approve` to sign off. */
  readonly restricted?: boolean;
  /** A module type whose modules are snippets: reusable wording, suggested while writing. */
  readonly snippet?: boolean;
  /** A safety type (#451): a derived manual such as a safety leaflet gathers its modules. */
  readonly safety?: boolean;
}

/** A change of the list: the whole new list, and what it was (for a refusal). */
export interface OptionListChange {
  readonly items: readonly OptionRow[];
  readonly what: TranslatedText;
}

/** The flags rows may carry: module types are restricted, hold snippets or are safety types. */
export type OptionFlags = 'moduleType' | null;

/**
 * A list of `{ id, label }` values of the configuration (module types, audiences, facet values,
 * text attributes, safety symbols, code languages), read first: each row shows its label, its ID
 * (monospace, muted: fixed once added, content names it), its flags as badges and how much
 * content uses it (a link to the content list where it filters). Where the person may edit, the
 * label is renamed in place (a click on it), a ⋯ menu holds Rename, the flags and Delete, and
 * rows are put in order by their grip (drag, or Alt+Arrow keys). The rows scroll inside the list.
 * It owns no data: every change is the whole list in `changed`; a removal is only asked for
 * (`remove`), since the topic first checks whether content uses it. Adding is the topic's Add
 * button. Rows that ship with the product (`defaults`) have Rename and "Reset to …" instead of
 * Delete.
 */
@Component({
  selector: 'of-option-list',
  imports: [
    TranslocoPipe,
    NgIcon,
    RouterLink,
    CollapseComponent,
    InlineLabelComponent,
    LocalizedTextFieldsComponent,
    SortableListComponent,
    SortableRowDirective,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardDropdownImports,
  ],
  viewProviders: [
    provideIcons({
      lucideEllipsis,
      lucideLanguages,
      lucidePencil,
      lucideRotateCcw,
      lucideTrash2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: '@container flex min-h-0 min-w-0 flex-col' },
  template: `
    @if (items().length > 0) {
      <div
        class="relative min-h-0 min-w-0 overflow-y-auto"
        data-slot="option-rows"
        [class]="
          framed() ? 'border-border bg-card rounded-xl border px-2 py-1.5' : ''
        "
        [style.max-height]="maxHeight()"
      >
        <of-sortable-list
          [items]="sortItems()"
          [label]="label()"
          [readonly]="!editable() || !sortable()"
          (itemsChange)="reorder($event)"
        >
          <ng-template ofSortableRow let-item>
            @let row = asRow(item);
            @let shown = sourceOf(row);
            <div class="flex min-w-0 flex-col" [attr.data-option]="row.id">
              <div class="flex min-h-9 min-w-0 items-center gap-2">
                @if (editable() && !sortable()) {
                  <!-- Where a sortable list has its grip: rows line up with one above. -->
                  <span class="size-6 shrink-0" aria-hidden="true"></span>
                }
                <div
                  class="flex min-w-0 flex-1 flex-col gap-0.5 @lg:flex-row @lg:items-center @lg:gap-4"
                >
                  <div
                    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm @lg:flex-1"
                  >
                    <of-inline-label
                      #name
                      [label]="shown"
                      [editable]="editable()"
                      [ariaLabel]="
                        'editor.admin.settings.option.labelOf'
                          | transloco: { id: row.id }
                      "
                      (rename)="rename(row, $event)"
                    />
                    @if (badge()) {
                      <z-badge zType="secondary" data-flag="badge">{{
                        badge()
                      }}</z-badge>
                    }
                    @if (row.restricted) {
                      <z-badge zType="warning" data-flag="restricted">{{
                        'editor.admin.settings.option.restricted' | transloco
                      }}</z-badge>
                    }
                    @if (row.snippet) {
                      <z-badge zType="secondary" data-flag="snippet">{{
                        'editor.admin.settings.option.snippetBadge' | transloco
                      }}</z-badge>
                    }
                    @if (row.safety) {
                      <z-badge zType="secondary" data-flag="safety">{{
                        'editor.admin.settings.option.safetyBadge' | transloco
                      }}</z-badge>
                    }
                  </div>
                  <div
                    class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 @lg:w-80 @lg:shrink-0 @lg:flex-nowrap"
                  >
                    <code
                      class="text-muted-foreground min-w-0 font-mono text-xs break-all @lg:flex-1"
                      >{{ row.id }}</code
                    >
                    @if (translatable(); as langs) {
                      <button
                        z-button
                        zType="ghost"
                        zSize="xs"
                        type="button"
                        class="text-muted-foreground shrink-0"
                        data-slot="option-languages"
                        [attr.aria-expanded]="languagesOpen() === row.id"
                        [attr.aria-controls]="'option-languages-' + row.id"
                        [attr.aria-label]="
                          'editor.admin.settings.option.languagesOf'
                            | transloco: { label: shown }
                        "
                        (click)="toggleLanguages(row.id)"
                      >
                        <ng-icon
                          name="lucideLanguages"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {{
                          'editor.admin.settings.option.languagesCount'
                            | transloco
                              : {
                                  given: givenOf(row, langs),
                                  total: langs.targets.length,
                                }
                        }}
                      </button>
                    }
                    @if (countOf(row.id); as c) {
                      @if (filterOf(row.id) && c.modules > 0) {
                        <a
                          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2 @lg:w-36 @lg:text-end"
                          data-slot="usage"
                          routerLink="/content"
                          [queryParams]="linkParams(filterOf(row.id))"
                          >{{
                            'editor.admin.settings.usage.short' | transloco: c
                          }}</a
                        >
                      } @else {
                        <span
                          class="text-muted-foreground text-xs @lg:w-36 @lg:text-end"
                          data-slot="usage"
                          >{{
                            'editor.admin.settings.usage.short' | transloco: c
                          }}</span
                        >
                      }
                    } @else if (usageKind()) {
                      <span class="hidden @lg:block @lg:w-36"></span>
                    }
                  </div>
                </div>
                @if (editable()) {
                  <button
                    z-button
                    zType="ghost"
                    zSize="icon-sm"
                    type="button"
                    class="shrink-0"
                    data-slot="option-menu"
                    z-dropdown
                    [zDropdownMenu]="menu"
                    [attr.aria-label]="
                      'editor.admin.settings.option.actionsOf'
                        | transloco: { label: shown }
                    "
                  >
                    <ng-icon name="lucideEllipsis" aria-hidden="true" />
                  </button>
                  <z-dropdown-menu-content #menu class="w-56">
                    <z-dropdown-menu-item
                      data-action="option-rename"
                      (click)="editSoon(name)"
                    >
                      <ng-icon name="lucidePencil" aria-hidden="true" />
                      {{ 'editor.admin.settings.option.rename' | transloco }}
                    </z-dropdown-menu-item>
                    @if (flags() === 'moduleType') {
                      <z-dropdown-menu-separator />
                      <z-dropdown-menu-checkbox-item
                        data-action="option-restricted"
                        [zChecked]="!!row.restricted"
                        (zCheckedChange)="setRestricted(row, $event)"
                        >{{
                          'editor.admin.settings.option.restricted' | transloco
                        }}</z-dropdown-menu-checkbox-item
                      >
                      <z-dropdown-menu-checkbox-item
                        data-action="option-snippet"
                        [zChecked]="!!row.snippet"
                        (zCheckedChange)="setSnippet(row, $event)"
                        >{{
                          'editor.admin.settings.option.snippet' | transloco
                        }}</z-dropdown-menu-checkbox-item
                      >
                      <z-dropdown-menu-checkbox-item
                        data-action="option-safety"
                        [zChecked]="!!row.safety"
                        (zCheckedChange)="setSafety(row, $event)"
                        >{{
                          'editor.admin.settings.option.safety' | transloco
                        }}</z-dropdown-menu-checkbox-item
                      >
                    }
                    @if (defaults(); as d) {
                      @if (d.get(row.id); as shipped) {
                        @if (shipped !== shown) {
                          <z-dropdown-menu-item
                            data-action="option-reset"
                            (click)="resetLabel.emit(row)"
                          >
                            <ng-icon
                              name="lucideRotateCcw"
                              aria-hidden="true"
                            />
                            {{
                              'editor.admin.settings.option.resetTo'
                                | transloco: { label: shipped }
                            }}
                          </z-dropdown-menu-item>
                        }
                      }
                    } @else {
                      <z-dropdown-menu-separator />
                      <z-dropdown-menu-item
                        zType="destructive"
                        data-action="option-delete"
                        [zDisabled]="items().length <= min()"
                        [attr.title]="
                          items().length <= min()
                            ? ('editor.admin.settings.option.lastOne'
                              | transloco)
                            : null
                        "
                        (click)="items().length > min() && remove.emit(row)"
                      >
                        <ng-icon name="lucideTrash2" aria-hidden="true" />
                        {{ 'editor.admin.settings.option.delete' | transloco }}
                      </z-dropdown-menu-item>
                    }
                  </z-dropdown-menu-content>
                }
              </div>
              @if (translatable(); as langs) {
                <of-collapse
                  [open]="languagesOpen() === row.id"
                  [attr.id]="'option-languages-' + row.id"
                >
                  @if (languagesOpen() === row.id) {
                    <div
                      class="ps-8 pe-10 pt-1 pb-2"
                      data-slot="option-languages-fields"
                    >
                      <of-localized-text-fields
                        [text]="row.label"
                        [languages]="langs"
                        [idPrefix]="'option-label-' + row.id"
                        [name]="
                          'editor.admin.settings.option.labelName' | transloco
                        "
                        [editable]="editable()"
                        [showSource]="false"
                        [collapsible]="false"
                        [maxlength]="max"
                        (changed)="relabel(row, $event)"
                      />
                    </div>
                  }
                </of-collapse>
              }
            </div>
          </ng-template>
        </of-sortable-list>
      </div>
    } @else {
      <p class="text-muted-foreground m-0 py-2 text-sm">
        {{ empty() || ('editor.admin.settings.option.none' | transloco) }}
      </p>
    }
  `,
})
export class OptionListComponent {
  readonly items = input.required<readonly OptionRow[]>();
  /** The list's accessible name. */
  readonly label = input('');
  readonly editable = input(false);
  readonly flags = input<OptionFlags>(null);
  /** The fewest rows the list keeps (the schema's `min`). */
  readonly min = input(0);
  /** The usage counts' kind for these values, and the facet they belong to. */
  readonly usageKind = input<ConfigUsageKind | null>(null);
  readonly usageParent = input<string | undefined>(undefined);
  readonly counts = input<ReadonlyMap<string, UsageCount>>(new Map());
  /** The change set's query parameters for links (`?cs=`). */
  readonly linkQuery = input<Record<string, string>>({});
  /** What an empty list says (translated); default "None yet." */
  readonly empty = input('');
  /** The rows sit in a card of their own (not inside another card). */
  readonly framed = input(true);
  /** The tallest the rows may be before they scroll, as a CSS length. */
  readonly maxHeight = input('calc(100dvh - 18rem - var(--of-sandbox-h, 0px))');
  /** The rows keep their order: no grips (they still line up with a sortable list's). */
  readonly sortable = input(true);
  /** A badge every row carries (translated), e.g. "Built-in"; none when empty. */
  readonly badge = input('');
  /**
   * Rows that ship with the product, by ID with their shipped label: they are renamed but never
   * deleted, and a renamed one offers to go back to its shipped label (`resetLabel`).
   */
  readonly defaults = input<ReadonlyMap<string, string> | null>(null);

  /**
   * The project's languages: each row's label is given per language (#731), the source
   * language's in place, the others' in the row's language fields. Null: one text (code languages).
   */
  readonly languages = input<ProjectLanguages | null>(null);

  readonly changed = output<OptionListChange>();
  readonly remove = output<OptionRow>();
  readonly resetLabel = output<OptionRow>();

  protected readonly max = LABEL_MAX;
  /** The row whose languages are open, by ID. */
  protected readonly languagesOpen = signal<string | null>(null);

  /** The rows as the sortable list names them: by their label in the source language. */
  protected readonly sortItems = computed(() =>
    this.items().map((row) => ({ id: row.id, label: this.sourceOf(row) })),
  );

  protected asRow(item: unknown): OptionRow {
    const id = (item as { id: string }).id;
    return this.items().find((row) => row.id === id) ?? (item as OptionRow);
  }

  /** The project's languages when there are languages to translate into. */
  protected translatable(): ProjectLanguages | null {
    const langs = this.languages();
    return langs && langs.targets.some((l) => l !== langs.source)
      ? langs
      : null;
  }

  /** A row's label in the source language: what the row shows and renames in place. */
  protected sourceOf(row: OptionRow): string {
    const langs = this.languages();
    if (typeof row.label === 'string') return row.label;
    return (
      (langs && sourceTextOf(row.label, langs.source)) ??
      Object.values(row.label)[0] ??
      ''
    );
  }

  /** How many target languages have a label of their own. */
  protected givenOf(row: OptionRow, langs: ProjectLanguages): number {
    return langs.targets.filter(
      (l) => l !== langs.source && !!ownTextIn(row.label, l, langs.source),
    ).length;
  }

  protected toggleLanguages(id: string): void {
    this.languagesOpen.update((open) => (open === id ? null : id));
  }

  /** A target language's label changed (the source language's is renamed in place). */
  protected relabel(row: OptionRow, label: LocalizedText): void {
    this.update(
      row,
      { label },
      translated('editor.admin.settings.changes.relabel', {
        label: this.sourceOf(row),
      }),
    );
  }

  protected countOf(id: string): UsageCount | undefined {
    const kind = this.usageKind();
    if (!kind) return undefined;
    return this.counts().get(
      usageKey({ kind, valueId: id, parentId: this.usageParent() }),
    );
  }

  protected filterOf(id: string): Record<string, string> | null {
    const kind = this.usageKind();
    return kind
      ? contentFilter({ kind, valueId: id, parentId: this.usageParent() })
      : null;
  }

  protected linkParams(
    filter: Record<string, string> | null,
  ): Record<string, string> {
    return { ...this.linkQuery(), ...(filter ?? {}) };
  }

  /**
   * The menu's Rename: the field opens once the menu has closed, since closing gives the focus
   * back to the ⋯ button (which would end the edit at once).
   */
  protected editSoon(name: InlineLabelComponent): void {
    setTimeout(() => name.edit(), 30);
  }

  protected reorder(order: readonly { readonly id: string }[]): void {
    const byId = new Map(this.items().map((row) => [row.id, row]));
    const items = order.flatMap((o) => byId.get(o.id) ?? []);
    this.changed.emit({
      items,
      what: translated('editor.admin.settings.changes.reorder'),
    });
  }

  /** The source language's label renamed in place: the other languages' stay as they are. */
  protected rename(row: OptionRow, label: string): void {
    const langs = this.languages();
    this.update(
      row,
      {
        label: langs
          ? withTextIn(row.label, langs.source, langs.source, label)
          : label,
      },
      translated('editor.admin.settings.changes.rename', { label }),
    );
  }

  protected setRestricted(row: OptionRow, restricted: boolean): void {
    this.update(
      row,
      { restricted },
      translated(
        restricted
          ? 'editor.admin.settings.changes.restrict'
          : 'editor.admin.settings.changes.unrestrict',
        { label: this.sourceOf(row) },
      ),
    );
  }

  protected setSnippet(row: OptionRow, snippet: boolean): void {
    this.update(
      row,
      { snippet },
      translated(
        snippet
          ? 'editor.admin.settings.changes.snippet'
          : 'editor.admin.settings.changes.unsnippet',
        { label: this.sourceOf(row) },
      ),
    );
  }

  protected setSafety(row: OptionRow, safety: boolean): void {
    this.update(
      row,
      { safety },
      translated(
        safety
          ? 'editor.admin.settings.changes.safety'
          : 'editor.admin.settings.changes.unsafety',
        { label: this.sourceOf(row) },
      ),
    );
  }

  private update(
    row: OptionRow,
    patch: Partial<OptionRow>,
    what: TranslatedText,
  ): void {
    this.changed.emit({
      items: this.items().map((i) =>
        i.id === row.id ? { ...i, ...patch } : i,
      ),
      what,
    });
  }
}
