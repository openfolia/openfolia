import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import {
  idProblem,
  keyFromLabel,
  labelProblem,
  type VariantAttribute,
} from '../settings/config-model';

/** What the dialog adds: a value (to an enum attribute) or an attribute. */
export type NewVariantKind = 'value' | 'attribute';

/** What the person asked to add. */
export type NewVariant =
  | {
      readonly kind: 'value';
      readonly attribute: string;
      readonly id: string;
      readonly label: string;
    }
  | { readonly kind: 'attribute'; readonly attribute: VariantAttribute };

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * "New value" and "New attribute" on the Variants tab: a value gets its group (an enum attribute),
 * label and ID; an attribute its label, ID and kind (a set of values, with its first value, or a
 * version). The ID is made from the label until typed, and is fixed once added: content names
 * it. The page adds what it hands over (`add`) at once, with Undo, and closes the dialog.
 */
@Component({
  selector: 'of-variant-new-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="!!kind()"
      (zVisibleChange)="$event || closed.emit()"
      class="sm:max-w-[30rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          (kind() === 'attribute'
            ? 'editor.admin.variants.newAttribute'
            : 'editor.admin.actions.newValue'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.variants.new.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (kind()) {
        <form
          id="variant-new-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          @if (kind() === 'value') {
            <div class="flex flex-col gap-1.5">
              <span class="text-sm" id="variant-new-group">{{
                'editor.admin.variants.detail.group' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                aria-labelledby="variant-new-group"
                [zValue]="group()"
                (zSelectionChange)="group.set($any($event))"
              >
                @for (a of groups(); track a.id) {
                  <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
                }
              </z-select>
            </div>
          }
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="variant-new-label">{{
              'editor.admin.variants.detail.label' | transloco
            }}</label>
            <input
              id="variant-new-label"
              z-input
              autocomplete="off"
              maxlength="200"
              data-field="variant-new-label"
              [attr.aria-invalid]="shown().label ? 'true' : null"
              [value]="label()"
              (input)="setLabel($any($event.target).value)"
            />
            @if (shown().label; as p) {
              <p class="text-destructive m-0 text-xs">{{ p | transloco }}</p>
            }
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="variant-new-id">{{
              'editor.admin.variants.detail.key' | transloco
            }}</label>
            <input
              id="variant-new-id"
              z-input
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              data-field="variant-new-id"
              aria-describedby="variant-new-id-hint"
              [attr.aria-invalid]="shown().id ? 'true' : null"
              [value]="id()"
              (input)="setId($any($event.target).value)"
            />
            <p
              id="variant-new-id-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!shown().id"
            >
              {{ shown().id ?? 'editor.admin.variants.new.idHint' | transloco }}
            </p>
          </div>
          @if (kind() === 'attribute') {
            <div class="flex flex-col gap-1.5">
              <span class="text-sm" id="variant-new-kind">{{
                'editor.admin.settings.variants.kind' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                aria-labelledby="variant-new-kind"
                [zValue]="attributeKind()"
                (zSelectionChange)="
                  attributeKind.set(
                    $any($event) === 'version' ? 'version' : 'enum'
                  )
                "
              >
                <z-select-item zValue="enum">{{
                  'editor.admin.settings.variants.kindEnum' | transloco
                }}</z-select-item>
                <z-select-item zValue="version">{{
                  'editor.admin.settings.variants.kindVersion' | transloco
                }}</z-select-item>
              </z-select>
            </div>
            @if (attributeKind() === 'enum') {
              <div class="flex flex-col gap-1.5">
                <label class="text-sm" for="variant-new-first">{{
                  'editor.admin.settings.variants.firstValue' | transloco
                }}</label>
                <input
                  id="variant-new-first"
                  z-input
                  autocomplete="off"
                  maxlength="200"
                  data-field="variant-new-first"
                  [attr.aria-invalid]="shown().first ? 'true' : null"
                  [value]="first()"
                  (input)="first.set($any($event.target).value)"
                />
                @if (shown().first; as p) {
                  <p class="text-destructive m-0 text-xs">
                    {{ p | transloco }}
                  </p>
                }
              </div>
            } @else {
              <p class="text-muted-foreground m-0 text-xs">
                {{ 'editor.admin.settings.variants.versionHint' | transloco }}
              </p>
            }
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="closed.emit()">
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="variant-new-form"
          data-slot="variant-new-add"
        >
          {{ 'editor.admin.settings.option.add' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class VariantNewDialogComponent {
  /** What to add; null: closed. */
  readonly kind = input<NewVariantKind | null>(null);
  readonly attributes = input<readonly VariantAttribute[]>([]);
  /** The group a new value starts in (the attribute chosen on the page). */
  readonly startGroup = input<string | undefined>(undefined);

  readonly add = output<NewVariant>();
  readonly closed = output<void>();

  protected readonly groups = computed(() =>
    this.attributes().filter((a) => a.kind === 'enum'),
  );
  protected readonly group = signal('');
  protected readonly label = signal('');
  protected readonly id = signal('');
  protected readonly attributeKind = signal<'enum' | 'version'>('enum');
  protected readonly first = signal('');
  private readonly idTyped = signal(false);
  private readonly tried = signal(false);

  private readonly problems = computed(() => {
    const kind = this.kind();
    const taken =
      kind === 'attribute'
        ? this.attributes().map((a) => a.id)
        : (() => {
            const a = this.groups().find((g) => g.id === this.group());
            return a?.kind === 'enum' ? a.values.map((v) => v.id) : [];
          })();
    return {
      label: labelProblem(this.label()),
      id: idProblem(
        kind === 'attribute' ? 'variantAttributes' : 'variantValues',
        this.id(),
        taken,
      ),
      first:
        kind === 'attribute' && this.attributeKind() === 'enum'
          ? (labelProblem(this.first()) ??
            (keyFromLabel(this.first()) === ''
              ? 'editor.admin.settings.problems.valueKey'
              : null))
          : null,
      group:
        kind === 'value' && !this.groups().some((g) => g.id === this.group()),
    };
  });

  protected readonly shown = computed(() => {
    const p = this.problems();
    return this.tried()
      ? p
      : {
          label: null,
          id: this.id() === '' ? null : p.id,
          first: null,
          group: false,
        };
  });

  constructor() {
    // Each opening starts empty, in the chosen group.
    effect(() => {
      const kind = this.kind();
      if (!kind) return;
      untracked(() => {
        const start = this.startGroup();
        const groups = this.groups();
        this.group.set(
          groups.find((g) => g.id === start)?.id ?? groups[0]?.id ?? '',
        );
        this.label.set('');
        this.id.set('');
        this.first.set('');
        this.attributeKind.set('enum');
        this.idTyped.set(false);
        this.tried.set(false);
      });
    });
  }

  protected setLabel(value: string): void {
    this.label.set(value);
    if (!this.idTyped()) this.id.set(keyFromLabel(value));
  }

  protected setId(value: string): void {
    this.idTyped.set(value !== '');
    this.id.set(value.trim());
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.tried.set(true);
    const p = this.problems();
    if (p.label || p.id || p.first || p.group) return;
    const label = tidy(this.label());
    if (this.kind() === 'value') {
      this.add.emit({
        kind: 'value',
        attribute: this.group(),
        id: this.id(),
        label,
      });
      return;
    }
    const first = tidy(this.first());
    this.add.emit({
      kind: 'attribute',
      attribute:
        this.attributeKind() === 'enum'
          ? {
              id: this.id(),
              label,
              kind: 'enum',
              values: [{ id: keyFromLabel(first), label: first }],
            }
          : { id: this.id(), label, kind: 'version' },
    });
  }
}
