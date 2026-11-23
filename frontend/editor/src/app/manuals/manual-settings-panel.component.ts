import type { LocalizedText } from '@openfolia/content-model/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucidePencil,
  lucidePlus,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ToastService } from '@openfolia/ui/toast';
import { firstValueFrom } from 'rxjs';

import { ApiClient, pageQuery, ReadRef } from '../api';
import { CHECK_TITLES, type CheckCode } from '../checks/checks-model';
import type { ProjectConfig } from '../content/browser-model';
import { conditionChips } from '../doc-editor/blocks/doc-blocks-context';
import type { VariantPick } from '../doc-editor/blocks/doc-blocks-context';
import { CoverImageSettingsComponent } from './cover-image-settings.component';
import { ManualDraft } from './manual-draft';
import {
  attributeRows,
  cleanVariant,
  coverOf,
  moveCoverVariant,
  withCover,
  duplicateOf,
  fromOptions,
  issuesFor,
  restoreVariant,
  toOptions,
  withAttribute,
  withCondition,
  type AttributeOption,
  type Condition,
  type Issue,
  type IssueField,
} from './manual-settings';
import { variantLabel, type VariantValues } from './manual-variants';
import { LocalizedTextFieldsComponent } from '../shared/localized-text-fields.component';

/** Opens the variant picker for a condition; resolves to the new one, `remove`, or null (cancelled). */
export type PickCondition = (
  current: Condition | null,
  labels: { readonly title: string; readonly subtitle: string },
) => Promise<VariantPick | null>;

/** The combination being edited: one of the list (`index`) or a new one. */
interface VariantEdit {
  readonly index: number | 'new';
  readonly values: Readonly<Record<string, string>>;
}

/**
 * The manual's settings (screen 3, "Settings", in a side panel): its audience, the variant
 * combinations it is built for and the values of its text attributes. Each change is saved at once
 * through the builder's working copy (`ManualDraft.changeSettings`: a refusal puts the last saved
 * settings back and offers a retry); removing a combination offers an undo. A combination is chosen
 * attribute by attribute (an attribute may be left unset, as the content model allows) and one
 * already listed is refused. A text attribute holds one value, or several each for some variants
 * (chosen in the variant picker), the first that matches winning; one not set says so. The content
 * model's issues show beside the field they are about. Read-only, it shows the settings and why
 * they can't be changed.
 */
@Component({
  selector: 'of-manual-settings-panel',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    CoverImageSettingsComponent,
    LocalizedTextFieldsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleAlert,
      lucidePencil,
      lucidePlus,
      lucideTrash2,
      lucideX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-6' },
  template: `
    @if (!editable() && blockedReason(); as reason) {
      <p
        class="m-0 rounded-md border border-border bg-muted px-3 py-2 text-xs break-words text-muted-foreground"
        data-testid="settings-read-only"
      >
        {{ reason | transloco }}
      </p>
    }

    <!-- Title: in the source language, and in each target language that has its own. -->
    @if (manualTitle(); as title) {
      <section
        class="flex flex-col gap-2"
        aria-labelledby="settings-title-heading"
        data-testid="settings-title"
      >
        <h3 id="settings-title-heading" class="m-0 text-sm font-medium">
          {{ 'editor.manuals.settings.titleSection.heading' | transloco }}
        </h3>
        <of-localized-text-fields
          idPrefix="settings-title"
          [text]="title"
          [languages]="config().languages"
          [name]="'editor.manuals.settings.titleSection.name' | transloco"
          [editable]="editable()"
          [maxlength]="titleMax"
          (changed)="setTitle($event)"
        />
      </section>
    }

    <!-- Audience -->
    <section class="flex flex-col gap-2" aria-labelledby="settings-audience">
      <h3 id="settings-audience" class="m-0 text-sm font-medium">
        {{ 'editor.manuals.settings.audience.heading' | transloco }}
      </h3>
      @if (editable()) {
        <z-select
          zPosition="popper"
          data-testid="settings-audience"
          [zAriaLabel]="'editor.manuals.settings.audience.heading' | transloco"
          [zInvalid]="audienceIssues().length > 0"
          [zValue]="settings().audience ?? ''"
          [zLabel]="audienceLabel()"
          (zSelectionChange)="chooseAudience($event)"
        >
          <z-select-item zValue="">{{
            'editor.manuals.settings.audience.none' | transloco
          }}</z-select-item>
          @for (a of config().audiences; track a.id) {
            <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
          }
        </z-select>
      } @else {
        <p class="m-0 text-sm break-words" data-testid="settings-audience">
          {{ audienceLabel() }}
        </p>
      }
      <p class="m-0 text-xs text-muted-foreground">
        {{ 'editor.manuals.settings.audience.hint' | transloco }}
      </p>
      @for (issue of audienceIssues(); track $index) {
        <ng-container
          *ngTemplateOutlet="issueLine; context: { $implicit: issue }"
        />
      }
    </section>

    <!-- Page design (issue 589) -->
    <section
      class="flex flex-col gap-2"
      aria-labelledby="settings-design"
      data-testid="settings-design"
    >
      <h3 id="settings-design" class="m-0 text-sm font-medium">
        {{ 'editor.manuals.settings.design.heading' | transloco }}
      </h3>
      @if (editable()) {
        <z-select
          zPosition="popper"
          data-testid="settings-design-select"
          [zAriaLabel]="'editor.manuals.settings.design.heading' | transloco"
          [zInvalid]="designMissing()"
          [zValue]="settings().design ?? ''"
          [zLabel]="designLabel()"
          (zSelectionChange)="chooseDesign($event)"
        >
          <z-select-item zValue="">{{ projectDefaultLabel() }}</z-select-item>
          @for (d of designChoices(); track d.id) {
            <z-select-item [zValue]="d.id">{{ d.name }}</z-select-item>
          }
        </z-select>
      } @else {
        <p class="m-0 text-sm break-words" data-testid="settings-design-select">
          {{ designLabel() }}
        </p>
      }
      <p class="m-0 text-xs text-muted-foreground">
        {{ 'editor.manuals.settings.design.hint' | transloco }}
      </p>
      @if (designMissing()) {
        <p
          class="m-0 flex items-start gap-1.5 text-xs break-words text-warning"
          data-testid="settings-design-missing"
        >
          <ng-icon
            name="lucideCircleAlert"
            class="mt-px shrink-0"
            aria-hidden="true"
          />
          {{
            'editor.manuals.settings.design.missing'
              | transloco: { id: settings().design }
          }}
        </p>
      }
    </section>

    <!-- Cover image (issue 394) -->
    <of-cover-image-settings
      [config]="config()"
      [editable]="editable()"
      [changeSetId]="changeSetId()"
    />

    <!-- Variant builds -->
    <section class="flex flex-col gap-2" aria-labelledby="settings-variants">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="settings-variants" class="m-0 text-sm font-medium">
          {{
            'editor.manuals.settings.variants.heading'
              | transloco: { count: settings().variants.length }
          }}
        </h3>
        @if (editable()) {
          <button
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-testid="variant-add"
            [zDisabled]="editing()?.index === 'new'"
            (click)="startAdd()"
          >
            <ng-icon
              name="lucidePlus"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.manuals.settings.variants.add' | transloco }}
          </button>
        }
      </div>
      <p class="m-0 text-xs text-muted-foreground">
        {{ 'editor.manuals.settings.variants.hint' | transloco }}
      </p>
      <ul
        class="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0"
        [attr.aria-label]="'editor.manuals.settings.variants.list' | transloco"
      >
        @for (v of settings().variants; track $index; let i = $index) {
          <li class="flex flex-col gap-2 px-3 py-2" [attr.data-build]="i">
            <div class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 text-sm break-words">{{
                label(v)
              }}</span>
              @if (editable()) {
                <button
                  z-button
                  zType="ghost"
                  zSize="icon-sm"
                  type="button"
                  data-testid="variant-edit"
                  [attr.aria-label]="
                    'editor.manuals.settings.variants.edit'
                      | transloco: { variant: label(v) }
                  "
                  [attr.aria-expanded]="editing()?.index === i"
                  (click)="startEdit(i)"
                >
                  <ng-icon name="lucidePencil" aria-hidden="true" />
                </button>
                <button
                  z-button
                  zType="ghost"
                  zSize="icon-sm"
                  type="button"
                  data-testid="variant-remove"
                  [zDisabled]="settings().variants.length < 2"
                  [attr.title]="
                    settings().variants.length < 2
                      ? ('editor.manuals.settings.variants.keepOne' | transloco)
                      : null
                  "
                  [attr.aria-label]="
                    'editor.manuals.settings.variants.remove'
                      | transloco: { variant: label(v) }
                  "
                  (click)="removeVariant(i)"
                >
                  <ng-icon name="lucideTrash2" aria-hidden="true" />
                </button>
              }
            </div>
            @for (issue of variantIssues(i); track $index) {
              <ng-container
                *ngTemplateOutlet="issueLine; context: { $implicit: issue }"
              />
            }
            <of-collapse [open]="editing()?.index === i">
              @if (editing()?.index === i) {
                <ng-container *ngTemplateOutlet="variantForm" />
              }
            </of-collapse>
          </li>
        }
      </ul>
      <of-collapse [open]="editing()?.index === 'new'">
        @if (editing()?.index === 'new') {
          <div
            class="rounded-lg border border-border p-3"
            data-testid="variant-new"
          >
            <ng-container *ngTemplateOutlet="variantForm" />
          </div>
        }
      </of-collapse>
      @if (settings().variants.length < 2 && editable()) {
        <p class="m-0 text-xs text-muted-foreground">
          {{ 'editor.manuals.settings.variants.keepOne' | transloco }}
        </p>
      }
      @for (issue of consistencyIssues(); track $index) {
        <ng-container
          *ngTemplateOutlet="issueLine; context: { $implicit: issue }"
        />
      }
    </section>

    <!-- Text attributes -->
    <section class="flex flex-col gap-2" aria-labelledby="settings-attributes">
      <h3 id="settings-attributes" class="m-0 text-sm font-medium">
        {{ 'editor.manuals.settings.attributes.heading' | transloco }}
      </h3>
      <p class="m-0 text-xs text-muted-foreground">
        {{ 'editor.manuals.settings.attributes.hint' | transloco }}
      </p>
      @if (attributes().length === 0) {
        <p class="m-0 text-sm text-muted-foreground">
          {{ 'editor.manuals.settings.attributes.noneConfigured' | transloco }}
        </p>
      }
      <ul class="m-0 flex list-none flex-col gap-3 p-0">
        @for (a of attributes(); track a.id) {
          @let options = optionsOf(a.id);
          <li
            class="flex flex-col gap-2 rounded-lg border border-border p-3"
            [attr.data-attribute]="a.id"
          >
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="min-w-0 text-sm font-medium break-words">{{
                a.label
              }}</span>
              <code class="text-xs break-all text-muted-foreground">{{
                '{' + a.id + '}'
              }}</code>
              @if (options.length === 0) {
                <z-badge
                  zType="warning"
                  class="font-normal"
                  data-testid="attribute-not-set"
                  >{{
                    'editor.manuals.settings.attributes.notSet' | transloco
                  }}</z-badge
                >
              }
            </div>
            @if (options.length > 0) {
              <ol class="m-0 flex list-none flex-col gap-2 p-0">
                @for (o of options; track $index; let j = $index) {
                  <li
                    class="flex min-w-0 flex-col gap-1.5"
                    [attr.data-option]="j"
                  >
                    @if (editable()) {
                      <input
                        z-input
                        type="text"
                        autocomplete="off"
                        class="w-full"
                        data-testid="attribute-value"
                        [attr.aria-label]="
                          'editor.manuals.settings.attributes.valueLabel'
                            | transloco: { attribute: a.label, n: j + 1 }
                        "
                        [value]="o.value"
                        (change)="commitValue(a.id, j, $event)"
                      />
                    } @else {
                      <span class="text-sm break-words">{{ o.value }}</span>
                    }
                    @if (shadowed(options, j)) {
                      <p
                        class="m-0 flex items-start gap-1.5 text-xs break-words text-warning"
                        data-testid="option-unused"
                      >
                        <ng-icon
                          name="lucideCircleAlert"
                          class="mt-px shrink-0"
                          aria-hidden="true"
                        />
                        {{
                          'editor.manuals.settings.attributes.unused'
                            | transloco
                        }}
                      </p>
                    }
                    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                      @if (o.when) {
                        @for (chip of chipsOf(o.when); track $index) {
                          <z-badge
                            zType="outline"
                            class="font-normal break-words whitespace-normal"
                            data-testid="option-condition"
                            >{{ chip }}</z-badge
                          >
                        }
                      } @else {
                        <span
                          class="text-xs text-muted-foreground"
                          data-testid="option-every"
                          >{{
                            'editor.manuals.settings.attributes.everyVariant'
                              | transloco
                          }}</span
                        >
                      }
                      @if (editable()) {
                        <button
                          z-button
                          zType="link"
                          zSize="sm"
                          type="button"
                          class="h-auto px-1"
                          data-testid="option-condition-pick"
                          (click)="pickOption(a.id, a.label, j)"
                        >
                          {{
                            (o.when
                              ? 'editor.manuals.settings.attributes.changeVariants'
                              : 'editor.manuals.settings.attributes.someVariants'
                            ) | transloco
                          }}
                        </button>
                        <button
                          z-button
                          zType="ghost"
                          zSize="icon-xs"
                          type="button"
                          class="ms-auto"
                          data-testid="option-remove"
                          [attr.aria-label]="
                            'editor.manuals.settings.attributes.removeValue'
                              | transloco: { value: o.value }
                          "
                          (click)="removeOption(a.id, j)"
                        >
                          <ng-icon name="lucideX" aria-hidden="true" />
                        </button>
                      }
                    </div>
                  </li>
                }
              </ol>
            }
            @if (editable()) {
              @if (adding() === a.id) {
                <div class="flex flex-col gap-1.5">
                  <input
                    z-input
                    type="text"
                    autocomplete="off"
                    data-testid="attribute-new-value"
                    [attr.aria-label]="
                      'editor.manuals.settings.attributes.newValue'
                        | transloco: { attribute: a.label }
                    "
                    [attr.aria-invalid]="addError() ? 'true' : null"
                    [attr.aria-describedby]="'attribute-new-' + a.id"
                    (keydown.enter)="addValue(a.id, $event)"
                    (keydown.escape)="cancelAdd($event)"
                    (blur)="addValue(a.id, $event)"
                  />
                  <p
                    class="m-0 text-xs text-muted-foreground"
                    [class.text-destructive]="addError()"
                    [id]="'attribute-new-' + a.id"
                    aria-live="polite"
                  >
                    {{
                      (addError()
                        ? 'editor.manuals.settings.attributes.valueRequired'
                        : 'editor.manuals.settings.attributes.newValueHint'
                      ) | transloco
                    }}
                  </p>
                </div>
              } @else {
                <button
                  z-button
                  zType="outline"
                  zSize="sm"
                  type="button"
                  class="self-start"
                  data-testid="attribute-add-value"
                  (click)="startAddValue(a.id)"
                >
                  <ng-icon
                    name="lucidePlus"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{
                    (options.length === 0
                      ? 'editor.manuals.settings.attributes.setValue'
                      : 'editor.manuals.settings.attributes.addValue'
                    ) | transloco
                  }}
                </button>
              }
            }
            @for (issue of attributeIssues(a.id); track $index) {
              <ng-container
                *ngTemplateOutlet="issueLine; context: { $implicit: issue }"
              />
            }
          </li>
        }
      </ul>
    </section>

    <ng-template #variantForm>
      @if (editing(); as edit) {
        <form
          class="flex flex-col gap-3 pt-1"
          novalidate
          data-testid="variant-form"
          (submit)="saveVariant($event)"
          (keydown.escape)="cancelEdit($event)"
        >
          @for (attr of config().variantAttributes; track attr.id) {
            <div class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{{
                attr.label
              }}</span>
              @if (attr.kind === 'enum') {
                <z-select
                  zPosition="popper"
                  [attr.data-attr]="attr.id"
                  [zAriaLabel]="attr.label"
                  [zValue]="edit.values[attr.id] ?? ''"
                  (zSelectionChange)="setValue(attr.id, $event)"
                >
                  <z-select-item zValue="">{{
                    'editor.manuals.settings.variants.notSet' | transloco
                  }}</z-select-item>
                  @for (o of attr.values; track o.id) {
                    <z-select-item [zValue]="o.id">{{ o.label }}</z-select-item>
                  }
                </z-select>
              } @else {
                <input
                  z-input
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  [attr.data-attr]="attr.id"
                  [attr.aria-label]="attr.label"
                  [placeholder]="
                    'editor.manuals.settings.variants.versionPlaceholder'
                      | transloco
                  "
                  [value]="edit.values[attr.id] ?? ''"
                  (input)="setValue(attr.id, $any($event.target).value)"
                />
              }
            </div>
          }
          @if (formError(); as error) {
            <p
              class="m-0 flex items-start gap-1.5 text-xs break-words text-destructive"
              role="alert"
              data-testid="variant-form-error"
            >
              <ng-icon
                name="lucideCircleAlert"
                class="mt-px shrink-0"
                aria-hidden="true"
              />
              {{ error | transloco: { variant: duplicateLabel() } }}
            </p>
          }
          <div class="flex flex-wrap justify-end gap-2">
            <button
              z-button
              zType="ghost"
              zSize="sm"
              type="button"
              (click)="editing.set(null)"
            >
              {{ 'editor.manuals.settings.variants.cancel' | transloco }}
            </button>
            <button
              z-button
              zSize="sm"
              type="submit"
              data-testid="variant-save"
              [zDisabled]="!!formError()"
            >
              {{
                (edit.index === 'new'
                  ? 'editor.manuals.settings.variants.create'
                  : 'editor.manuals.settings.variants.save'
                ) | transloco
              }}
            </button>
          </div>
        </form>
      }
    </ng-template>

    <ng-template #issueLine let-issue>
      <p
        class="m-0 flex items-start gap-1.5 text-xs break-words"
        [class.text-destructive]="issue.severity === 'error'"
        [class.text-warning]="issue.severity !== 'error'"
        data-testid="settings-issue"
      >
        <ng-icon
          name="lucideCircleAlert"
          class="mt-px shrink-0"
          aria-hidden="true"
        />
        <span>
          <span class="sr-only">{{
            (issue.severity === 'error'
              ? 'editor.manuals.settings.issueError'
              : 'editor.manuals.settings.issueWarning'
            ) | transloco
          }}</span>
          {{ issueText(issue) }}
        </span>
      </p>
    </ng-template>
  `,
})
export class ManualSettingsPanelComponent {
  private readonly draft = inject(ManualDraft);
  private readonly toast = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly t = injectTranslate();

  /** The page designs at the revision read (`GET /page-designs`); null before they are read. */
  private readonly designs = signal<
    readonly { id: string; name: string }[] | null
  >(null);
  private designReads = 0;

  readonly config = input.required<ProjectConfig>();

  /** The manual's title in every language (#731); null until the manual is read. */
  protected readonly manualTitle = computed(
    () => this.draft.manual()?.title ?? null,
  );
  protected readonly titleMax = 200;

  protected setTitle(title: LocalizedText): void {
    if (this.editable()) this.draft.setTitle(title);
  }
  /** Why the settings can't be changed now (a key), shown while read-only. */
  readonly blockedReason = input<string | null>(null);
  /** The draft change set (uploads of a cover image go there); null while reading. */
  readonly changeSetId = input<string | null>(null);
  /** Opens the variant picker (the page's). */
  readonly pickCondition = input<PickCondition | null>(null);

  protected readonly settings = computed(
    () => this.draft.settings() ?? { variants: [], attributes: {} },
  );
  /** Changeable now: read to edit, and nothing (a change-set switch) blocks it. */
  protected readonly editable = computed(
    () =>
      this.draft.mode().kind === 'edit' &&
      this.draft.settings() !== null &&
      !this.blockedReason(),
  );

  protected readonly editing = signal<VariantEdit | null>(null);
  /** The combinations: a new list only when they change (not for another setting). */
  private readonly variants = computed(() => this.settings().variants);

  constructor() {
    // The designs to choose from, read again when reads move to another revision.
    effect(() => {
      this.readRef.ref();
      this.readRef.moves();
      untracked(() => void this.loadDesigns());
    });
    // The combinations changed (a removal, an undo, a refusal, a reload): an open form's
    // position no longer names the one it was opened for, so it closes.
    effect(() => {
      this.variants();
      untracked(() => this.editing.set(null));
    });
  }
  /** The text attribute a new value is being typed for. */
  protected readonly adding = signal<string | null>(null);
  protected readonly addError = signal(false);

  protected readonly audienceLabel = computed(() => {
    const id = this.settings().audience;
    if (id === undefined)
      return this.t('editor.manuals.settings.audience.none');
    return this.config().audiences.find((a) => a.id === id)?.label ?? id;
  });

  /** The designs a manual may name: those that can be read (a file that is no design is not one). */
  protected readonly designChoices = computed(() => this.designs() ?? []);
  private nameOfDesign(id: string): string {
    return this.designs()?.find((d) => d.id === id)?.name ?? id;
  }
  /** "Project default (Classic)": what a manual without a design of its own is printed with. */
  protected readonly projectDefaultLabel = computed(() => {
    // A configuration read without `pdf` (a partial one in a test, an older API) names none.
    const id = this.config().pdf?.design;
    return this.t('editor.manuals.settings.design.projectDefault', {
      name: id
        ? this.nameOfDesign(id)
        : this.t('editor.manuals.settings.design.builtin'),
    });
  });
  protected readonly designLabel = computed(() => {
    const own = this.settings().design;
    return own === undefined
      ? this.projectDefaultLabel()
      : own === 'builtin'
        ? this.t('editor.manuals.settings.design.builtin')
        : this.nameOfDesign(own);
  });
  /** The manual's own design is not at the revision (once the designs are read). */
  protected readonly designMissing = computed(() => {
    const own = this.settings().design;
    const designs = this.designs();
    return (
      own !== undefined &&
      own !== 'builtin' &&
      designs !== null &&
      !designs.some((d) => d.id === own)
    );
  });

  protected readonly audienceIssues = computed(() =>
    this.issuesOf({ kind: 'audience' }),
  );
  protected readonly consistencyIssues = computed(() =>
    this.issuesOf({ kind: 'variants' }),
  );

  protected readonly attributes = computed(() =>
    attributeRows(this.config(), this.settings().attributes),
  );

  /** What keeps the edited combination from being saved (a key), or null. */
  protected readonly formError = computed((): string | null => {
    const edit = this.editing();
    if (!edit) return null;
    const values = cleanVariant(edit.values);
    if (Object.keys(values).length === 0) {
      return 'editor.manuals.settings.variants.empty';
    }
    const except = edit.index === 'new' ? -1 : edit.index;
    return duplicateOf(this.settings().variants, values, except) >= 0
      ? 'editor.manuals.settings.variants.duplicate'
      : null;
  });

  protected readonly duplicateLabel = computed(() => {
    const edit = this.editing();
    return edit ? this.label(cleanVariant(edit.values)) : '';
  });

  protected label(values: VariantValues): string {
    return (
      variantLabel(values, this.config()) ||
      this.t('editor.manuals.settings.variants.nothingSet')
    );
  }

  protected variantIssues(index: number): Issue[] {
    return this.issuesOf({ kind: 'variant', index });
  }

  protected attributeIssues(id: string): Issue[] {
    return this.issuesOf({ kind: 'attribute', id });
  }

  private issuesOf(field: IssueField): Issue[] {
    return issuesFor(this.draft.issues(), field);
  }

  protected issueText(issue: Issue): string {
    const key = CHECK_TITLES[issue.code as CheckCode] as string | undefined;
    return key ? `${this.t(key)}: ${issue.message}` : issue.message;
  }

  protected optionsOf(id: string): AttributeOption[] {
    return toOptions(this.settings().attributes[id]);
  }

  /** Whether a value comes after one for every variant, which always wins: it is never used. */
  protected shadowed(
    options: readonly AttributeOption[],
    index: number,
  ): boolean {
    return options.some((o, i) => i < index && !o.when);
  }

  protected chipsOf(when: Condition): string[] {
    return (
      conditionChips(
        when,
        this.config(),
        this.t('editor.manuals.settings.rule'),
      ) ?? []
    ).map((chip) => `${chip.attribute}: ${chip.values.join(', ')}`);
  }

  protected chooseAudience(value: string | string[]): void {
    const id = Array.isArray(value) ? value[0] : value;
    const audience = id ? id : undefined;
    if (audience === this.settings().audience || !this.editable()) return;
    this.draft.changeSettings({ audience });
  }

  protected chooseDesign(value: string | string[]): void {
    const id = Array.isArray(value) ? value[0] : value;
    const design = id ? id : undefined;
    if (design === this.settings().design || !this.editable()) return;
    this.draft.changeSettings({ design });
  }

  /** Reads every design at the revision; a failure leaves the choice to the project default. */
  private async loadDesigns(): Promise<void> {
    const read = ++this.designReads;
    try {
      const found: { id: string; name: string }[] = [];
      for (let page = 1; page <= 10; page++) {
        const doc = await firstValueFrom(
          this.api.get('/page-designs', {
            query: pageQuery({ number: page, size: 200 }),
          }),
        );
        if (read !== this.designReads) return;
        for (const d of doc.data) {
          // A file that is no design has no attributes: it is not offered.
          if ('attributes' in d && 'name' in d.attributes) {
            found.push({ id: d.id, name: d.attributes.name as string });
          }
        }
        if (page >= doc.meta.page.lastPage) break;
      }
      this.designs.set(found);
    } catch {
      if (read === this.designReads) this.designs.set(null);
    }
  }

  protected startAdd(): void {
    this.editing.set({ index: 'new', values: this.nextFree() });
  }

  protected startEdit(index: number): void {
    if (this.editing()?.index === index) {
      this.editing.set(null);
      return;
    }
    const values = this.settings().variants[index];
    if (values) this.editing.set({ index, values: { ...values } });
  }

  /** Escape closes the form, not the panel around it. */
  protected cancelEdit(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.editing.set(null);
  }

  protected setValue(attr: string, value: string | string[]): void {
    const v = Array.isArray(value) ? (value[0] ?? '') : value;
    this.editing.update((edit) =>
      edit ? { ...edit, values: { ...edit.values, [attr]: v } } : edit,
    );
  }

  protected saveVariant(event: Event): void {
    event.preventDefault();
    const edit = this.editing();
    if (!edit || this.formError() || !this.editable()) return;
    const values = cleanVariant(edit.values);
    const settings = this.settings();
    const variants = [...settings.variants];
    const before = edit.index === 'new' ? undefined : variants[edit.index];
    if (edit.index === 'new') variants.push(values);
    else variants[edit.index] = values;
    this.editing.set(null);
    // A variant's own cover image (#394) follows its new values.
    this.draft.changeSettings(
      before && settings.coverImage
        ? {
            variants,
            coverImage: moveCoverVariant(settings.coverImage, before, values),
          }
        : { variants },
    );
  }

  /** Removes a combination (one stays at least), with an undo. */
  protected removeVariant(index: number): void {
    const variants = this.settings().variants;
    const removed = variants[index];
    if (!removed || variants.length < 2 || !this.editable()) return;
    if (this.editing()?.index === index) this.editing.set(null);
    // Its own cover image (#394) goes with it, and comes back with an undo.
    const cover = coverOf(this.settings().coverImage, removed);
    this.draft.changeSettings({
      variants: variants.filter((_, i) => i !== index),
      ...(cover && {
        coverImage: moveCoverVariant(
          this.settings().coverImage,
          removed,
          undefined,
        ),
      }),
    });
    const draft = this.draft;
    const scope = draft.scope();
    const variant = this.label(removed);
    this.toast.show(
      translated('editor.manuals.settings.variants.removed', { variant }),
      {
        actionLabel: translated('editor.manuals.row.undo'),
        onAction: () => {
          const now = draft.settings();
          // Already back (the removal was refused): nothing to save.
          if (now && duplicateOf(now.variants, removed) >= 0) return;
          // Only in the manual and change set it was removed in, while they can be edited.
          if (
            !now ||
            draft.scope() !== scope ||
            draft.mode().kind !== 'edit' ||
            !this.editable()
          ) {
            return;
          }
          draft.changeSettings({
            variants: restoreVariant(now.variants, removed, index),
            ...(cover && {
              coverImage: withCover(now.coverImage, removed, cover),
            }),
          });
        },
      },
    );
  }

  /** A combination not listed yet: the first values that make one, else the first values. */
  private nextFree(): Record<string, string> {
    const attrs = this.config().variantAttributes;
    const taken = this.settings().variants;
    const enums = attrs.filter((a) => a.kind === 'enum');
    const first = Object.fromEntries(
      enums.flatMap((a) => (a.values[0] ? [[a.id, a.values[0].id]] : [])),
    );
    // Vary one attribute at a time (most combinations differ in one), else keep the first values.
    for (const attr of enums) {
      for (const value of attr.values) {
        const candidate = { ...first, [attr.id]: value.id };
        if (duplicateOf(taken, candidate) < 0) return candidate;
      }
    }
    return first;
  }

  protected commitValue(id: string, index: number, event: Event): void {
    const field = event.target as HTMLInputElement;
    const value = field.value.trim().replace(/\s+/g, ' ');
    const options = this.optionsOf(id);
    const option = options[index];
    if (!option) return;
    // An empty value is not stored: the one saved comes back (Remove takes a value away).
    if (value === '') {
      field.value = option.value;
      return;
    }
    if (value === option.value) return;
    const next = options.map((o, i) => (i === index ? { ...o, value } : o));
    this.saveOptions(id, next);
  }

  protected startAddValue(id: string): void {
    this.addError.set(false);
    this.adding.set(id);
    // Focused once it is in the page.
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLInputElement>(
            `[data-attribute="${CSS.escape(id)}"] [data-testid=attribute-new-value]`,
          )
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected addValue(id: string, event: Event): void {
    if (this.adding() !== id) return;
    const field = event.target as HTMLInputElement;
    const value = field.value.trim().replace(/\s+/g, ' ');
    if (value === '') {
      // Leaving an empty field cancels; Enter on one says what is missing.
      if (event.type === 'blur') this.adding.set(null);
      else {
        event.preventDefault();
        this.addError.set(true);
      }
      return;
    }
    event.preventDefault();
    this.adding.set(null);
    this.saveOptions(id, [...this.optionsOf(id), { value }]);
  }

  protected cancelAdd(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.adding.set(null);
  }

  protected removeOption(id: string, index: number): void {
    this.saveOptions(
      id,
      this.optionsOf(id).filter((_, i) => i !== index),
    );
  }

  /** Chooses the variants a value is for, in the variant picker. */
  protected async pickOption(
    id: string,
    label: string,
    index: number,
  ): Promise<void> {
    const pick = this.pickCondition();
    const option = this.optionsOf(id)[index];
    if (!pick || !option) return;
    const scope = this.draft.scope();
    const result = await pick(option.when ?? null, {
      title: this.t('editor.manuals.settings.attributes.pickTitle'),
      subtitle: this.t('editor.manuals.settings.attributes.pickSubtitle', {
        attribute: label,
        value: option.value,
      }),
    });
    if (!result || this.draft.scope() !== scope) return;
    // The value may have moved meanwhile: found again by what it was.
    const options = this.optionsOf(id);
    const at = options.findIndex(
      (o) =>
        o.value === option.value &&
        JSON.stringify(o.when) === JSON.stringify(option.when),
    );
    if (at < 0) return;
    this.saveOptions(
      id,
      withCondition(options, at, result === 'remove' ? null : result),
    );
  }

  private saveOptions(id: string, options: readonly AttributeOption[]): void {
    if (!this.editable()) return;
    this.draft.changeSettings({
      attributes: withAttribute(
        this.settings().attributes,
        id,
        fromOptions(options),
      ),
    });
  }
}
