import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSelectImports } from '@openfolia/ui/select';
import { CollapseComponent } from '@openfolia/ui/collapse';

import type { ProjectConfig } from '../content/browser-model';
import { MODULE_ID, moduleIdOf } from '../content/module-id';
import { mayGatherFrom } from './derived-rule';
import type { NewManual } from './manual-creation';
import {
  type LocalizedText,
  ownTextIn,
  safetyTypes,
  withTextIn,
} from '@openfolia/content-model/core';
import {
  LocalizedTextFieldsComponent,
  tidyText,
  typedTextIn,
} from '../shared/localized-text-fields.component';
import { headingText } from './manual-outline';
import { parseVersions } from './update-guide';

const TITLE_MAX = 200;

/** A manual the dialog knows of: its ID is taken, and it can be copied unless deleted. */
export interface KnownManual {
  readonly id: string;
  readonly title: string;
  readonly state?: 'new' | 'deleted' | undefined;
  /** A derived manual (#451) or an update guide (#906): never a source of another. */
  readonly kind?: 'derived' | 'update-guide' | undefined;
  /** Its audience as committed: a derived manual gathers only from one for its own or a wider one. */
  readonly audience?: string | undefined;
}

/** The kinds of manual the dialog makes. */
type ManualKind = 'assembled' | 'derived' | 'update-guide';

/** What the dialog starts with: "Duplicate" fills in the title and the manual to copy. */
export interface NewManualPrefill {
  readonly title: string;
  readonly copyFrom: string;
}

/**
 * A new manual's title, audience and, optionally, the manual it starts as a copy of. Its fields
 * are a subset the manual's settings (variants, text attributes) extend later. Submitting closes
 * the dialog and hands the manual to the caller, which creates it in the current change set. The
 * ID is made from the title; one taken among the manuals listed here (deleted ones too) is refused
 * at once, any other taken one by the creation itself. Without a draft change set (`blocked`) it
 * says why and creates nothing.
 */
@Component({
  selector: 'of-new-manual-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardCheckboxComponent,
    ZardRadioGroupImports,
    CollapseComponent,
    TranslocoPipe,
    LocalizedTextFieldsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[36rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.manuals.new.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.manuals.new.description'
            | transloco: { changeSet: changeSetTitle() }
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="new-manual-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          @if (blocked(); as reason) {
            <p
              role="alert"
              data-testid="new-manual-blocked"
              class="m-0 rounded-md border border-destructive/30 bg-destructive-muted px-3 py-2 text-sm text-destructive"
            >
              {{ reason | transloco }}
            </p>
          }
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="new-manual-title">{{
              'editor.manuals.new.titleField' | transloco
            }}</label>
            <input
              id="new-manual-title"
              z-input
              autocomplete="off"
              required
              [attr.maxlength]="titleMax"
              [attr.aria-invalid]="titleError() ? 'true' : null"
              aria-describedby="new-manual-id"
              [attr.lang]="config().languages.source"
              [value]="title()"
              (input)="setTitle($any($event.target).value)"
            />
            <p
              id="new-manual-id"
              class="m-0 text-xs break-words text-muted-foreground"
              [class.text-destructive]="!!titleError()"
              aria-live="polite"
            >
              @if (titleError(); as error) {
                {{ error | transloco: { id: id() } }}
              } @else if (id()) {
                {{ 'editor.manuals.new.idHint' | transloco: { id: id() } }}
              } @else {
                {{ 'editor.manuals.new.idFromTitle' | transloco }}
              }
            </p>
            <of-localized-text-fields
              idPrefix="new-manual-title"
              mode="input"
              [text]="titleText()"
              [languages]="config().languages"
              [name]="'editor.manuals.new.titleField' | transloco"
              [showSource]="false"
              [maxlength]="titleMax"
              (changed)="titleText.set($event)"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.manuals.new.audience' | transloco
            }}</span>
            <z-select
              zPosition="popper"
              data-testid="new-manual-audience"
              [zAriaLabel]="'editor.manuals.new.audience' | transloco"
              [zPlaceholder]="'editor.manuals.new.noAudience' | transloco"
              [zValue]="audience()"
              (zSelectionChange)="audience.set(single($event))"
            >
              <z-select-item zValue="">{{
                'editor.manuals.new.noAudience' | transloco
              }}</z-select-item>
              @for (a of config().audiences; track a.id) {
                <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
              }
            </z-select>
          </div>

          <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend class="mb-1.5 p-0 text-sm">
              {{ 'editor.manuals.new.kind' | transloco }}
            </legend>
            <z-radio-group
              class="flex flex-col gap-2"
              data-testid="new-manual-kind"
              [attr.aria-label]="'editor.manuals.new.kind' | transloco"
              [value]="kind()"
              (valueChange)="setKind($event)"
            >
              @for (k of kinds; track k) {
                <label
                  class="flex min-w-0 cursor-pointer items-center gap-2 text-sm"
                  [attr.data-kind]="k"
                >
                  <z-radio [value]="k" [zId]="'new-manual-kind-' + k" />
                  <span class="min-w-0 break-words">{{
                    kindLabels[k] | transloco
                  }}</span>
                </label>
              }
            </z-radio-group>
          </fieldset>

          <!-- An update guide (issue 908): its product, version attribute and versions. -->
          <of-collapse [open]="kind() === 'update-guide'">
            <div
              class="flex flex-col gap-4 pb-1"
              data-testid="new-manual-guide"
            >
              <p class="m-0 text-xs break-words text-muted-foreground">
                {{ 'editor.manuals.new.guideHint' | transloco }}
              </p>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm">{{
                  'editor.manuals.new.product' | transloco
                }}</span>
                <z-select
                  zSearchable
                  zPosition="popper"
                  data-testid="new-manual-product"
                  [zAriaLabel]="'editor.manuals.new.product' | transloco"
                  [zPlaceholder]="'editor.manuals.new.noProduct' | transloco"
                  [zValue]="product()"
                  (zSelectionChange)="product.set(single($event))"
                >
                  <z-select-item zValue="">{{
                    'editor.manuals.new.noProduct' | transloco
                  }}</z-select-item>
                  @for (m of productOptions(); track m.id) {
                    <z-select-item [zValue]="m.id">{{ m.title }}</z-select-item>
                  }
                </z-select>
                <p class="m-0 text-xs break-words text-muted-foreground">
                  {{ 'editor.manuals.new.productHint' | transloco }}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm">{{
                  'editor.manuals.new.versionAttribute' | transloco
                }}</span>
                <z-select
                  zPosition="popper"
                  data-testid="new-manual-version-attribute"
                  [zAriaLabel]="
                    'editor.manuals.new.versionAttribute' | transloco
                  "
                  [zPlaceholder]="
                    'editor.manuals.new.versionAttribute' | transloco
                  "
                  [zInvalid]="attributeMissing()"
                  [zDisabled]="versionAttributes().length === 0"
                  [zValue]="attribute()"
                  (zSelectionChange)="attribute.set(single($event))"
                >
                  @for (a of versionAttributes(); track a.id) {
                    <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
                  }
                </z-select>
                @if (versionAttributes().length === 0) {
                  <p
                    class="m-0 text-xs break-words text-destructive"
                    data-testid="new-manual-no-version-attribute"
                  >
                    {{ 'editor.manuals.new.noVersionAttribute' | transloco }}
                  </p>
                } @else if (attributeMissing()) {
                  <p class="m-0 text-xs text-destructive">
                    {{
                      'editor.manuals.new.versionAttributeMissing' | transloco
                    }}
                  </p>
                }
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="new-manual-versions">{{
                  'editor.manuals.new.versions' | transloco
                }}</label>
                <input
                  id="new-manual-versions"
                  z-input
                  autocomplete="off"
                  inputmode="decimal"
                  aria-describedby="new-manual-versions-hint"
                  [attr.aria-invalid]="versionsProblem() ? 'true' : null"
                  [placeholder]="
                    'editor.manuals.new.versionsPlaceholder' | transloco
                  "
                  [value]="versionsText()"
                  (input)="versionsText.set($any($event.target).value)"
                />
                <p
                  id="new-manual-versions-hint"
                  class="m-0 text-xs break-words text-muted-foreground"
                  [class.text-destructive]="!!versionsProblem()"
                  aria-live="polite"
                >
                  @if (versionsProblem(); as problem) {
                    {{ problem.key | transloco: { value: problem.value } }}
                  } @else {
                    {{ 'editor.manuals.new.versionsHint' | transloco }}
                  }
                </p>
              </div>
            </div>
          </of-collapse>

          <of-collapse [open]="kind() === 'derived'">
            <div
              class="flex flex-col gap-4 pb-1"
              data-testid="new-manual-derived"
            >
              <p class="m-0 text-xs break-words text-muted-foreground">
                {{ 'editor.manuals.new.derivedHint' | transloco }}
              </p>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm">{{
                  'editor.manuals.new.source' | transloco
                }}</span>
                <z-select
                  zSearchable
                  zPosition="popper"
                  data-testid="new-manual-source"
                  [zAriaLabel]="'editor.manuals.new.source' | transloco"
                  [zPlaceholder]="'editor.manuals.new.source' | transloco"
                  [zInvalid]="sourceMissing()"
                  [zValue]="source()"
                  (zSelectionChange)="source.set(single($event))"
                >
                  @for (m of sourceOptions(); track m.id) {
                    <z-select-item [zValue]="m.id">{{ m.title }}</z-select-item>
                  }
                </z-select>
                @if (sourceOptions().length === 0) {
                  <p class="m-0 text-xs break-words text-muted-foreground">
                    {{ 'editor.manuals.new.noSources' | transloco }}
                  </p>
                } @else if (sourceMissing()) {
                  <p class="m-0 text-xs text-destructive">
                    {{ 'editor.manuals.new.sourceMissing' | transloco }}
                  </p>
                }
              </div>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm">{{
                  'editor.manuals.new.types' | transloco
                }}</span>
                <z-select
                  zMultiple
                  zPosition="popper"
                  data-testid="new-manual-types"
                  [zMaxLabelCount]="3"
                  [zAriaLabel]="'editor.manuals.new.types' | transloco"
                  [zPlaceholder]="safetyLabels()"
                  [zInvalid]="typesMissing()"
                  [zValue]="types()"
                  (zSelectionChange)="types.set(many($event))"
                >
                  @for (t of config().moduleTypes; track t.id) {
                    <z-select-item [zValue]="t.id">{{ t.label }}</z-select-item>
                  }
                </z-select>
                <p
                  class="m-0 text-xs break-words text-muted-foreground"
                  [class.text-destructive]="typesMissing()"
                >
                  @if (typesMissing()) {
                    {{ 'editor.manuals.new.typesMissing' | transloco }}
                  } @else if (safetyLabels()) {
                    {{
                      'editor.manuals.new.typesSafety'
                        | transloco: { types: safetyLabels() }
                    }}
                  } @else {
                    {{ 'editor.manuals.new.typesNoSafety' | transloco }}
                  }
                </p>
              </div>
            </div>
          </of-collapse>

          @if (kind() === 'assembled') {
            <div class="flex flex-col gap-2">
              <z-checkbox (checkChange)="copy.set($event)">{{
                'editor.manuals.new.copy' | transloco
              }}</z-checkbox>
              @if (copy()) {
                <z-select
                  zSearchable
                  zPosition="popper"
                  [zAriaLabel]="'editor.manuals.new.copyFrom' | transloco"
                  [zPlaceholder]="'editor.manuals.new.copyFrom' | transloco"
                  [zInvalid]="copyMissing()"
                  [zValue]="copyFrom()"
                  (zSelectionChange)="copyFrom.set(single($event))"
                >
                  @for (m of copyOptions(); track m.id) {
                    <z-select-item [zValue]="m.id">{{ m.title }}</z-select-item>
                  }
                </z-select>
                @if (copyMissing()) {
                  <p class="m-0 text-xs text-destructive">
                    {{ 'editor.manuals.new.copyMissing' | transloco }}
                  </p>
                }
              }
            </div>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.manuals.new.cancel' | transloco }}
        </button>
        <button z-button type="submit" form="new-manual-form">
          {{ 'editor.manuals.new.create' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class NewManualDialogComponent {
  readonly open = model(false);
  readonly config = input.required<ProjectConfig>();
  /** The manuals known in the change set: their IDs are taken; those not deleted can be copied. */
  readonly manuals = input<readonly KnownManual[]>([]);
  /** The change set the manual goes into, named in the description. */
  readonly changeSetTitle = input('');
  /** Why no manual can be created now (a translation key), or null. */
  readonly blocked = input<string | null>(null);
  /** What the fields start with (a duplicate); null starts empty. */
  readonly prefill = input<NewManualPrefill | null>(null);
  readonly create = output<NewManual>();

  protected readonly titleMax = TITLE_MAX;
  /** The title as typed, every language's (#731). */
  protected readonly titleText = signal<LocalizedText>('');
  /** The source language's title as typed: the ID is made from it. */
  protected readonly title = computed(() =>
    headingText(this.titleText(), this.config().languages.source),
  );
  protected readonly audience = signal('');
  protected readonly copy = signal(false);
  protected readonly copyFrom = signal('');
  protected readonly kinds = ['assembled', 'derived', 'update-guide'] as const;
  protected readonly kindLabels: Readonly<Record<ManualKind, string>> = {
    assembled: 'editor.manuals.new.assembled',
    derived: 'editor.manuals.new.derived',
    'update-guide': 'editor.manuals.new.updateGuide',
  };
  /** An assembled manual, one derived from another (#451, #669), or an update guide (#908). */
  protected readonly kind = signal<ManualKind>('assembled');
  /** An update guide's product (a manual whose variants it takes; empty: the default variant). */
  protected readonly product = signal('');
  /** An update guide's version attribute, and its versions as typed. */
  protected readonly attribute = signal('');
  protected readonly versionsText = signal('');
  /** A derived manual's source and the types it gathers (none: the configured safety types). */
  protected readonly source = signal('');
  protected readonly types = signal<string[]>([]);
  private readonly submitted = signal(false);
  private readonly copyBox = viewChild(ZardCheckboxComponent);

  protected readonly id = computed(() => moduleIdOf(this.title()));
  protected readonly copyOptions = computed(() =>
    this.manuals().filter((m) => m.state !== 'deleted'),
  );
  protected readonly titleError = computed((): string | null => {
    const title = this.title().trim();
    if (!this.submitted() && title === '') return null;
    if (title === '') return 'editor.manuals.new.titleMissing';
    if (!MODULE_ID.test(this.id())) return 'editor.manuals.new.idEmpty';
    if (this.manuals().some((m) => m.id === this.id())) {
      return 'editor.manuals.new.idTaken';
    }
    return null;
  });
  protected readonly copyMissing = computed(
    () =>
      this.submitted() &&
      this.kind() === 'assembled' &&
      this.copy() &&
      !this.copyFrom(),
  );

  /** The manuals a derived manual for the chosen audience may gather from (the API decides too). */
  protected readonly sourceOptions = computed(() => {
    const manual = { id: this.id(), audience: this.audience() || undefined };
    return this.manuals().filter(
      (m) => m.state !== 'deleted' && mayGatherFrom(m, manual, this.config()),
    );
  });
  protected readonly sourceMissing = computed(
    () =>
      this.submitted() &&
      this.kind() === 'derived' &&
      !this.sourceOptions().some((m) => m.id === this.source()),
  );
  /** The configured safety types, by label: what an empty choice of types gathers. */
  protected readonly safetyLabels = computed(() => {
    const config = this.config();
    return safetyTypes(config)
      .map((id) => config.moduleTypes.find((t) => t.id === id)?.label ?? id)
      .join(', ');
  });
  /** No type chosen and none configured as safety: nothing would be gathered. */
  protected readonly typesMissing = computed(
    () =>
      this.submitted() &&
      this.kind() === 'derived' &&
      this.types().length === 0 &&
      !this.safetyLabels(),
  );

  /** The configured version attributes: an update guide follows one of them. */
  protected readonly versionAttributes = computed(() =>
    this.config().variantAttributes.filter((a) => a.kind === 'version'),
  );
  /** The manuals an update guide may take its product from: assembled ones not deleted. */
  protected readonly productOptions = computed(() =>
    this.manuals().filter((m) => m.state !== 'deleted' && m.kind === undefined),
  );
  protected readonly attributeMissing = computed(
    () =>
      this.submitted() &&
      this.kind() === 'update-guide' &&
      this.versionAttributes().length > 0 &&
      !this.versionAttributes().some((a) => a.id === this.attribute()),
  );
  /** What is wrong with the versions typed, once submitted (or once something is typed). */
  protected readonly versionsProblem = computed(
    (): { key: string; value: string } | null => {
      if (this.kind() !== 'update-guide') return null;
      if (!this.submitted() && this.versionsText().trim() === '') return null;
      const parsed = parseVersions(this.versionsText());
      if ('versions' in parsed) return null;
      // While typing, only an invalid version is said; too few once submitted.
      if (!this.submitted() && !parsed.value) return null;
      return { key: parsed.problem, value: parsed.value ?? '' };
    },
  );

  constructor() {
    // Every opening starts afresh, or with the duplicate's values.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        const prefill = this.prefill();
        this.titleText.set(prefill?.title ?? '');
        this.audience.set('');
        this.copy.set(!!prefill);
        this.copyFrom.set(prefill?.copyFrom ?? '');
        this.kind.set('assembled');
        this.product.set('');
        // The only version attribute is the one to follow.
        const versions = this.versionAttributes();
        this.attribute.set(
          versions.length === 1 ? (versions[0]?.id ?? '') : '',
        );
        this.versionsText.set('');
        this.source.set('');
        this.types.set([]);
        this.submitted.set(false);
      });
    });
    // The checkbox shows the duplicate's choice once it is rendered.
    effect(() => {
      const box = this.copyBox();
      if (box) untracked(() => box.writeValue(this.copy()));
    });
  }

  protected setTitle(value: string): void {
    const source = this.config().languages.source;
    this.titleText.set(typedTextIn(this.titleText(), source, source, value));
  }

  /** The title tidied: each language's text, an empty one left out (#731). */
  private tidiedTitle(): LocalizedText {
    const { source, targets } = this.config().languages;
    let title: LocalizedText = tidyText(this.title()).slice(0, TITLE_MAX);
    for (const lang of targets) {
      if (lang === source) continue;
      const own = tidyText(ownTextIn(this.titleText(), lang, source) ?? '');
      if (own) title = withTextIn(title, lang, source, own.slice(0, TITLE_MAX));
    }
    return title;
  }

  protected setKind(value: unknown): void {
    this.kind.set(
      value === 'derived' || value === 'update-guide' ? value : 'assembled',
    );
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected many(value: string | string[]): string[] {
    return Array.isArray(value) ? value : value ? [value] : [];
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (this.blocked() || this.titleError() || this.copyMissing()) return;
    if (this.sourceMissing() || this.typesMissing()) return;
    const guide = this.kind() === 'update-guide';
    const versions = guide ? parseVersions(this.versionsText()) : null;
    if (guide) {
      if (this.versionAttributes().length === 0 || this.attributeMissing())
        return;
      if (!versions || !('versions' in versions)) return;
    }
    const derived = this.kind() === 'derived';
    // Only an assembled manual copies one: a guide's product and a derived manual's source are their own.
    const source =
      this.kind() === 'assembled' && this.copy()
        ? this.copyOptions().find((m) => m.id === this.copyFrom())
        : undefined;
    this.create.emit({
      id: this.id(),
      title: this.tidiedTitle(),
      audience: this.audience() || undefined,
      copyFrom: source?.id,
      ...(derived
        ? {
            derivedFrom: this.source(),
            moduleTypes:
              this.types().length > 0 ? [...this.types()] : undefined,
          }
        : {}),
      ...(versions && 'versions' in versions
        ? {
            updateGuide: {
              attribute: this.attribute(),
              versions: versions.versions,
            },
            productFrom: this.productOptions().some(
              (m) => m.id === this.product(),
            )
              ? this.product()
              : undefined,
          }
        : {}),
    });
    this.open.set(false);
  }
}
