import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import {
  MANUFACTURER_ADDRESS_LINES,
  MANUFACTURER_LINE_MAX,
  manufacturerForm,
  manufacturerProblem,
  setCheckManufacturer,
  setManufacturer,
  type ManufacturerForm,
} from './config-model';
import { SettingsContext } from './settings-context';

/** The form's fields, in order, each with its label and hint (translation keys). */
const FIELDS: readonly {
  readonly key: keyof ManufacturerForm;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    key: 'name',
    label: 'editor.admin.settings.manufacturer.name',
    hint: 'editor.admin.settings.manufacturer.nameHint',
  },
  {
    key: 'address',
    label: 'editor.admin.settings.manufacturer.address',
    hint: 'editor.admin.settings.manufacturer.addressHint',
  },
  {
    key: 'contact',
    label: 'editor.admin.settings.manufacturer.contact',
    hint: 'editor.admin.settings.manufacturer.contactHint',
  },
  {
    key: 'website',
    label: 'editor.admin.settings.manufacturer.website',
    hint: 'editor.admin.settings.manufacturer.websiteHint',
  },
];

/**
 * Settings › Manufacturer (#395): who makes the product and how to reach them (`manufacturer`),
 * which a page design's back page prints and its `manufacturer-*` placeholders show, and whether
 * every manual's checks warn while there are none (`release.checkManufacturer`). A field is saved
 * when it is left, with Undo; details the configuration would refuse (no name, a website that is
 * no address) are said beside the form and not saved. Emptying every field removes them.
 */
@Component({
  selector: 'of-settings-manufacturer',
  imports: [
    TranslocoPipe,
    ZardInputComponent,
    ZardSwitchComponent,
    ZardTextareaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
  template: `
    @if (ctx.config(); as c) {
      <div class="flex min-w-0 flex-col gap-5" data-slot="manufacturer">
        <div
          class="border-border bg-card grid min-w-0 gap-4 rounded-xl border p-4 sm:grid-cols-2"
        >
          @for (f of fields; track f.key) {
            <div
              class="flex min-w-0 flex-col gap-1.5"
              [class.sm:col-span-2]="f.key === 'name'"
              [class.sm:row-span-2]="f.key === 'address'"
            >
              <label
                class="text-sm font-medium"
                [attr.for]="'manufacturer-' + f.key"
                >{{ f.label | transloco }}</label
              >
              @if (f.key === 'address') {
                <textarea
                  z-textarea
                  id="manufacturer-address"
                  rows="4"
                  autocomplete="off"
                  class="min-h-24 resize-y"
                  data-field="address"
                  [attr.aria-describedby]="'manufacturer-address-hint'"
                  [attr.aria-invalid]="problemField() === 'address' || null"
                  [disabled]="!ctx.editable()"
                  [value]="form().address"
                  (change)="edit('address', $any($event.target).value)"
                ></textarea>
              } @else {
                <input
                  z-input
                  type="text"
                  autocomplete="off"
                  [id]="'manufacturer-' + f.key"
                  [attr.data-field]="f.key"
                  [attr.maxlength]="f.key === 'website' ? 2000 : lineMax"
                  [attr.inputmode]="f.key === 'website' ? 'url' : null"
                  [attr.aria-describedby]="'manufacturer-' + f.key + '-hint'"
                  [attr.aria-invalid]="problemField() === f.key || null"
                  [disabled]="!ctx.editable()"
                  [value]="form()[f.key]"
                  (change)="edit(f.key, $any($event.target).value)"
                  (keydown.enter)="$any($event.target).blur()"
                />
              }
              <span
                class="text-muted-foreground text-xs break-words"
                [id]="'manufacturer-' + f.key + '-hint'"
                >{{ f.hint | transloco: { lines: addressLines } }}</span
              >
            </div>
          }
          @if (problem(); as p) {
            <p
              class="text-destructive m-0 text-xs break-words sm:col-span-2"
              role="alert"
              data-slot="manufacturer-problem"
            >
              {{ p | transloco: { max: lineMax, lines: addressLines } }}
            </p>
          }
        </div>
        <div
          class="border-border flex min-w-0 flex-col gap-1 border-y py-3"
          data-slot="manufacturer-check"
        >
          <z-switch
            class="text-sm"
            [zDisabled]="!ctx.editable()"
            [zChecked]="c.release?.checkManufacturer === true"
            (zCheckedChange)="setCheck($event)"
            >{{
              'editor.admin.settings.manufacturer.check' | transloco
            }}</z-switch
          >
          <span class="text-muted-foreground max-w-prose text-xs break-words">{{
            'editor.admin.settings.manufacturer.checkHint' | transloco
          }}</span>
        </div>
      </div>
    }
  `,
})
export class ManufacturerTopicPage {
  protected readonly ctx = inject(SettingsContext);
  protected readonly fields = FIELDS;
  protected readonly lineMax = MANUFACTURER_LINE_MAX;
  protected readonly addressLines = MANUFACTURER_ADDRESS_LINES;

  /** What the form shows: the saved details, or what was typed and could not be saved. */
  protected readonly form = signal<ManufacturerForm>({
    name: '',
    address: '',
    contact: '',
    website: '',
  });
  /** Why what was typed is not saved (a key), or null. */
  protected readonly problem = signal<string | null>(null);
  /** The field the problem is about. */
  protected readonly problemField = signal<keyof ManufacturerForm | null>(null);

  constructor() {
    // The saved details whenever they change (a save, Undo, another change set); a change of
    // another setting (the check) keeps what was typed and could not be saved.
    let shown = '';
    effect(() => {
      const c = this.ctx.config();
      if (!c) return;
      const saved = manufacturerForm(c);
      const key = JSON.stringify(saved);
      if (key === shown) return;
      shown = key;
      untracked(() => {
        this.form.set(saved);
        this.problem.set(null);
        this.problemField.set(null);
      });
    });
  }

  protected edit(key: keyof ManufacturerForm, value: string): void {
    const c = this.ctx.config();
    if (!c || !this.ctx.editable()) return;
    const next = { ...this.form(), [key]: value };
    this.form.set(next);
    const problem = manufacturerProblem(next);
    this.problem.set(problem);
    this.problemField.set(problem ? fieldOf(problem) : null);
    if (problem) return;
    const saved = manufacturerForm(c);
    const updated = setManufacturer(c, next);
    if (
      JSON.stringify(manufacturerForm(updated)) === JSON.stringify(saved) &&
      (updated.manufacturer === undefined) === (c.manufacturer === undefined)
    ) {
      return;
    }
    const removed = updated.manufacturer === undefined;
    this.ctx.save(
      updated,
      translated(
        removed
          ? 'editor.admin.settings.changes.manufacturerRemoved'
          : 'editor.admin.settings.changes.manufacturer',
      ),
      {
        part: 'manufacturer',
        done: translated(
          removed
            ? 'editor.admin.settings.done.manufacturerRemoved'
            : 'editor.admin.settings.done.manufacturer',
        ),
      },
    );
  }

  protected setCheck(on: boolean): void {
    const c = this.ctx.config();
    if (!c || (c.release?.checkManufacturer === true) === on) return;
    this.ctx.save(
      setCheckManufacturer(c, on),
      translated(
        on
          ? 'editor.admin.settings.changes.manufacturerCheckOn'
          : 'editor.admin.settings.changes.manufacturerCheckOff',
      ),
    );
  }
}

/** The field a problem is about, so it can say so to assistive technology. */
function fieldOf(problem: string): keyof ManufacturerForm | null {
  if (problem.endsWith('.name')) return 'name';
  if (problem.endsWith('.website')) return 'website';
  if (problem.endsWith('.address')) return 'address';
  return null;
}
