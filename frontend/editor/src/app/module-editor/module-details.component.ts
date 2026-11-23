import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideBookOpen } from '@ng-icons/lucide';
import type { LocalizedText } from '@openfolia/content-model/core';

import { StatusBadgeComponent } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import {
  languageName,
  type ProjectConfig,
  unsetAudienceLevel,
} from '../content/browser-model';
import type { Deprecation } from '../content/deprecate-dialog.component';
import { KeywordFieldComponent } from '../content/keyword-field.component';
import { UiTextPipe } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import type { ModuleMeta } from './module-model';
import { ModuleRenamePanelComponent } from './module-rename-panel.component';

/** A language of the module in the Translations card. */
export interface TranslationRow {
  readonly lang: string;
  /** `source`: the module's source language; `current`: the one open now. */
  readonly exists: boolean;
  readonly source: boolean;
  readonly current: boolean;
}

/** A manual that includes the module (Used in). */
export interface UsedInRow {
  readonly id: string;
  /** The manual's title, one per language perhaps (#731): shown in the interface language. */
  readonly title: LocalizedText;
  /** The manual is deprecated itself (#266). */
  readonly deprecated?: boolean;
}

/**
 * The editor's side panel: the module's details (title, type, product lines and the other
 * facets, audience, keywords; the variants its blocks use and its ID, which "Change ID" renames
 * in a draft change set, #265), its
 * translations and the manuals it is used in. Every change is handed on at once (`metaChange`),
 * as the page's document holds the metadata and saves it with the text. A language the module
 * is not in yet offers "Translate" (`content.edit`; blocked with the reason outside a draft).
 */
@Component({
  selector: 'of-module-details',
  imports: [
    UiTextPipe,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    ZardInputComponent,
    ZardButtonComponent,
    GuardDirective,
    ZardSelectImports,
    ZardSkeletonComponent,
    KeywordFieldComponent,
    CollapseComponent,
    StatusBadgeComponent,
    ModuleRenamePanelComponent,
  ],
  viewProviders: [provideIcons({ lucideArchive, lucideBookOpen })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  template: `
    <of-collapse [open]="!!deprecation()">
      @if (deprecation(); as d) {
        <section
          class="border-border bg-muted flex flex-col gap-1.5 rounded-2xl border p-3.5"
          aria-labelledby="module-deprecated-title"
          data-slot="module-deprecation"
        >
          <h2
            id="module-deprecated-title"
            class="m-0 flex items-center gap-2 text-sm font-medium"
          >
            <ng-icon name="lucideArchive" size="16" aria-hidden="true" />
            {{ 'editor.deprecation.notice.title' | transloco }}
          </h2>
          <p class="m-0 text-sm break-words">{{ d.reason }}</p>
          @if (d.replacedBy; as replacement) {
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.deprecation.notice.replacedBy' | transloco }}
              <a
                class="text-foreground font-mono underline underline-offset-2"
                [routerLink]="['/content', meta().lang, replacement]"
                queryParamsHandling="preserve"
                >{{ replacement }}</a
              >
            </p>
          }
        </section>
      }
    </of-collapse>
    <section
      class="border-border flex flex-col gap-3 rounded-2xl border p-3.5"
      aria-labelledby="module-details-title"
    >
      <h2 id="module-details-title" class="sr-only">
        {{ 'editor.moduleEditor.details.title' | transloco }}
      </h2>
      <div class="flex flex-col gap-1">
        <label for="module-title" class="text-muted-foreground text-xs">{{
          'editor.moduleEditor.details.moduleTitle' | transloco
        }}</label>
        <input
          id="module-title"
          z-input
          autocomplete="off"
          [attr.maxlength]="titleMax"
          [readOnly]="!editable()"
          [attr.aria-invalid]="titleMissing() ? 'true' : null"
          [value]="meta().title"
          [attr.lang]="meta().lang"
          dir="auto"
          (input)="setTitle($any($event.target).value)"
        />
        <of-collapse class="-mt-1" [open]="titleMissing()">
          <p class="text-destructive m-0 pt-1 text-xs">
            {{ 'editor.moduleEditor.details.titleMissing' | transloco }}
          </p>
        </of-collapse>
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-muted-foreground text-xs" id="module-type-label">{{
          'editor.moduleEditor.details.type' | transloco
        }}</span>
        <z-select
          zPosition="popper"
          [zDisabled]="!editable()"
          [zAriaLabel]="'editor.moduleEditor.details.type' | transloco"
          [zValue]="meta().type"
          (zSelectionChange)="change({ type: single($event) || meta().type })"
        >
          @for (t of config().moduleTypes; track t.id) {
            <z-select-item [zValue]="t.id">{{ t.label }}</z-select-item>
          }
        </z-select>
      </div>
      @for (f of config().facets; track f.id) {
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs">{{ f.label }}</span>
          <z-select
            zMultiple
            zPosition="popper"
            [zMaxLabelCount]="3"
            [zDisabled]="!editable()"
            [zAriaLabel]="f.label"
            [zPlaceholder]="'editor.moduleEditor.details.none' | transloco"
            [zValue]="facetValues(f.id)"
            (zSelectionChange)="setFacet(f.id, $event)"
          >
            @for (v of f.values; track v.id) {
              <z-select-item [zValue]="v.id">{{ v.label }}</z-select-item>
            }
          </z-select>
        </div>
      }
      <div class="flex flex-col gap-1">
        <span class="text-muted-foreground text-xs">{{
          'editor.moduleEditor.details.audience' | transloco
        }}</span>
        <z-select
          zPosition="popper"
          [zDisabled]="!editable()"
          [zAriaLabel]="'editor.moduleEditor.details.audience' | transloco"
          [zPlaceholder]="
            'editor.moduleEditor.details.noAudience'
              | transloco: { level: unsetLevel() }
          "
          [zValue]="meta().audience ?? ''"
          (zSelectionChange)="change({ audience: single($event) || undefined })"
        >
          <z-select-item zValue="">{{
            'editor.moduleEditor.details.noAudience'
              | transloco: { level: unsetLevel() }
          }}</z-select-item>
          @for (a of config().audiences; track a.id) {
            <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
          }
        </z-select>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-muted-foreground text-xs" for="module-keywords">{{
          'editor.keywords.label' | transloco
        }}</label>
        @if (editable()) {
          <of-keyword-field
            inputId="module-keywords"
            [label]="'editor.keywords.label' | transloco"
            [keywords]="meta().keywords ?? []"
            (keywordsChange)="change({ keywords: [...$event] })"
          />
        } @else {
          <p id="module-keywords" class="m-0 text-sm break-words">
            {{
              meta().keywords?.length
                ? meta().keywords!.join(', ')
                : ('editor.moduleEditor.details.none' | transloco)
            }}
          </p>
        }
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-muted-foreground text-xs">{{
          'editor.moduleEditor.details.variants' | transloco
        }}</span>
        <p class="m-0 text-sm break-words">
          {{
            variants().length
              ? variants().join(', ')
              : ('editor.moduleEditor.details.allVariants' | transloco)
          }}
        </p>
      </div>
      <div class="flex items-start gap-2">
        <p
          class="text-muted-foreground m-0 min-w-0 flex-1 font-mono text-xs break-all"
        >
          {{ moduleId() }}
          @if (meta().source; as source) {
            · {{ source.system }} {{ source.id }}
          }
        </p>
        @if (canRename()) {
          <button
            z-button
            zType="outline"
            zSize="xs"
            type="button"
            class="shrink-0"
            data-change-id
            aria-controls="module-rename"
            [attr.aria-expanded]="renameOpen()"
            [ofGuard]="{
              permission: 'content.edit',
              blockedReason: renameOpen() ? null : renameBlocked(),
            }"
            (click)="renameOpenChange.emit(!renameOpen())"
          >
            {{ 'editor.moduleEditor.rename.action' | transloco }}
          </button>
        }
      </div>
      @if (renameChangeSetId(); as changeSetId) {
        <of-collapse id="module-rename" [open]="renameOpen()">
          <of-module-rename-panel
            class="border-border border-t pt-2.5"
            [moduleId]="moduleId()"
            [title]="meta().title"
            [changeSetId]="changeSetId"
            [active]="renameOpen()"
            [busy]="renaming()"
            (rename)="rename.emit($event)"
            (closed)="renameOpenChange.emit(false)"
          />
        </of-collapse>
      }
    </section>

    <section
      class="border-border flex flex-col gap-2.5 rounded-2xl border p-3.5"
      aria-labelledby="module-translations-title"
    >
      <h2 id="module-translations-title" class="m-0 text-sm font-medium">
        {{ 'editor.moduleEditor.translations.title' | transloco }}
      </h2>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
        @for (row of translations(); track row.lang) {
          <li class="flex items-center gap-2 text-sm">
            <span
              class="size-2 shrink-0 rounded-full"
              [class]="
                row.exists
                  ? 'bg-foreground'
                  : 'border-muted-foreground border border-dashed'
              "
              aria-hidden="true"
            ></span>
            @if (row.exists && !row.current) {
              <a
                class="hover:bg-muted focus-visible:ring-ring -mx-1 min-w-0 flex-1 rounded-md px-1 break-words outline-none focus-visible:ring-2"
                [routerLink]="['/content', row.lang, moduleId()]"
                queryParamsHandling="preserve"
                [attr.lang]="row.lang"
                >{{ name(row.lang) }}</a
              >
            } @else {
              <span class="min-w-0 flex-1 break-words" [attr.lang]="row.lang">{{
                name(row.lang)
              }}</span>
            }
            <span class="text-muted-foreground shrink-0 text-xs">
              {{
                (row.current
                  ? 'editor.moduleEditor.translations.editing'
                  : row.exists
                    ? row.source
                      ? 'editor.moduleEditor.translations.source'
                      : 'editor.moduleEditor.translations.translated'
                    : 'editor.moduleEditor.translations.missing'
                ) | transloco
              }}
            </span>
            @if (!row.exists && canTranslate()) {
              <button
                z-button
                zType="outline"
                zSize="xs"
                type="button"
                class="shrink-0"
                [attr.data-translate]="row.lang"
                [zLoading]="translating() === row.lang"
                [ofGuard]="{
                  permission: 'content.edit',
                  blockedReason: translateBlocked(),
                }"
                [attr.aria-label]="
                  'editor.moduleEditor.translate.into'
                    | transloco: { language: name(row.lang) }
                "
                (click)="translate.emit(row.lang)"
              >
                {{ 'editor.moduleEditor.translate.action' | transloco }}
              </button>
            }
          </li>
        }
      </ul>
    </section>

    <section
      class="border-border flex flex-col gap-2 rounded-2xl border p-3.5"
      aria-labelledby="module-used-title"
    >
      <h2 id="module-used-title" class="m-0 text-sm font-medium">
        {{ 'editor.moduleEditor.usedIn.title' | transloco }}
      </h2>
      <div>
        <of-collapse [open]="usedIn() === null && !usedInFailed()">
          <div role="status" aria-busy="true" class="flex flex-col gap-2">
            <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
            <z-skeleton class="h-4 w-3/4" />
            <z-skeleton class="h-4 w-1/2" />
          </div>
        </of-collapse>
        <of-collapse [open]="usedIn() !== null || usedInFailed()">
          @if (usedIn(); as manuals) {
            @if (manuals.length) {
              <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
                @for (m of manuals; track m.id) {
                  <li class="flex items-start gap-2 text-sm">
                    <ng-icon
                      name="lucideBookOpen"
                      class="text-muted-foreground mt-0.5 shrink-0"
                      size="16"
                      aria-hidden="true"
                    />
                    <span class="min-w-0 break-words">{{
                      m.title | uiText: config().languages
                    }}</span>
                    @if (m.deprecated) {
                      <of-status-badge
                        class="ml-auto shrink-0"
                        status="deprecated"
                      />
                    }
                  </li>
                }
              </ul>
              @if (deprecation()) {
                <p
                  class="text-destructive m-0 mt-2 text-xs break-words"
                  role="status"
                  data-slot="used-in-deprecated"
                >
                  {{
                    'editor.deprecation.usedIn'
                      | transloco: { count: manuals.length }
                  }}
                </p>
              } @else {
                <p class="text-muted-foreground m-0 mt-2 text-xs">
                  {{
                    'editor.moduleEditor.usedIn.note'
                      | transloco: { count: manuals.length }
                  }}
                </p>
              }
            } @else {
              <p class="text-muted-foreground m-0 text-sm">
                {{ 'editor.moduleEditor.usedIn.none' | transloco }}
              </p>
            }
          } @else if (usedInFailed()) {
            <p class="text-muted-foreground m-0 text-sm">
              {{ 'editor.moduleEditor.usedIn.failed' | transloco }}
            </p>
          }
        </of-collapse>
      </div>
    </section>
  `,
})
export class ModuleDetailsComponent {
  private readonly language = inject(LanguageService);

  readonly meta = input.required<ModuleMeta>();
  readonly moduleId = input.required<string>();
  readonly config = input.required<ProjectConfig>();
  readonly editable = input(false);
  /** What the variant blocks are conditioned on, as people read them. */
  readonly variants = input<readonly string[]>([]);
  readonly translations = input<readonly TranslationRow[]>([]);
  /** The manuals using the module; null while they are read. */
  readonly usedIn = input<readonly UsedInRow[] | null>(null);
  readonly usedInFailed = input(false);
  /** The module's deprecation (#266); null: it is not deprecated. */
  readonly deprecation = input<Deprecation | null>(null);
  /** Whether "Translate" is offered (not in a contributor's suggestion, #137). */
  readonly canTranslate = input(true);
  /** Why "Translate" is blocked now (a translation key), or null. */
  readonly translateBlocked = input<string | null>(null);
  /** The language a version is being started in, or null. */
  readonly translating = input<string | null>(null);
  /** A change of the metadata, to apply to the document. */
  readonly metaChange = output<Partial<ModuleMeta>>();
  /** "Translate": start the module's version in this language. */
  readonly translate = output<string>();
  /** Whether "Change ID" is offered (`content.edit`, not in a contributor's suggestion). */
  readonly canRename = input(false);
  /** The change set "Change ID" renames the module in; null while there is none to rename in. */
  readonly renameChangeSetId = input<string | null>(null);
  /** The rename panel is open (`?rename=open`). */
  readonly renameOpen = input(false);
  /** Why "Change ID" is blocked now (a translation key), or null. */
  readonly renameBlocked = input<string | null>(null);
  /** A rename is under way. */
  readonly renaming = input(false);
  /** Open or close the rename panel. */
  readonly renameOpenChange = output<boolean>();
  /** "Change ID": rename the module to this ID. */
  readonly rename = output<string>();

  protected readonly titleMax = 200;
  /** The level a module without an audience counts as (#693). */
  protected readonly unsetLevel = computed(() =>
    unsetAudienceLevel(this.config()),
  );
  protected readonly titleMissing = computed(() => !this.meta().title.trim());

  protected name(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected facetValues(id: string): string[] {
    return [...(this.meta().facets?.[id] ?? [])];
  }

  protected change(patch: Partial<ModuleMeta>): void {
    if (this.editable()) this.metaChange.emit(patch);
  }

  protected setTitle(title: string): void {
    this.change({ title });
  }

  protected setFacet(id: string, value: string | string[]): void {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    this.change({ facets: { ...this.meta().facets, [id]: values } });
  }
}
