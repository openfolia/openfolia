import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';

import { RelativeTimePipe } from '../i18n/format.pipes';
import { injectTranslate } from '../i18n/text.pipe';
import { SegmentedComponent } from '../segmented/segmented.component';
import { MeterBarComponent } from '../meter-bar/meter-bar.component';

import { StatusBadgeComponent } from '../badges/status-badge.component';
import { ZardAlertDialogImports } from '../alert-dialog/alert-dialog.imports';
import { ZardButtonComponent } from '../button/button.component';
import { ZardCheckboxComponent } from '../checkbox/checkbox.component';
import { ZardCommandImports } from '../command/command.imports';
import { HighlightedTextComponent } from '../highlighted-text/highlighted-text.component';
import { CodeEditorComponent } from '../code-editor/code-editor.component';
import { KbdComponent } from '../kbd/kbd.component';
import { AvatarComponent } from '../avatar/avatar.component';
import { ZardDialogImports } from '../dialog/dialog.imports';
import { ZardDropdownImports } from '../dropdown-menu/dropdown.imports';
import { ZardInputComponent } from '../input/input.component';
import { ZardInputGroupImports } from '../input-group/input-group.imports';
import { ZardPopoverImports } from '../popover/popover.imports';
import { ZardRadioGroupImports } from '../radio-group/radio-group.imports';
import { ZardSelectImports } from '../select/select.imports';
import { ZardSheetImports } from '../sheet/sheet.imports';
import { ZardSwitchComponent } from '../switch/switch.component';
import { ZardTableImports } from '../table/table.imports';
import { ZardTextareaComponent } from '../textarea/textarea.component';
import { ZardTooltipDirective } from '../tooltip/tooltip';

/** The forced look of a keyboard focus, to show it without a keyboard (the real one is `:focus-visible`). */
const FOCUS = 'border-ring ring-3 ring-ring/50';
const HOUR = 3600 * 1000;

/**
 * The base components: table, input, textarea, select, checkbox, radio group, switch, dialog,
 * alert dialog, sheet, command, popover, tooltip and dropdown menu, each in its variants and
 * states. The overlays open from a button (closed is the page as it is, open is what the button
 * shows). Hover and the real focus ring come from the pointer and the keyboard; where a state
 * cannot be had without them the page forces its look and says so.
 */
@Component({
  selector: 'of-base-showcase',
  imports: [
    FormsModule,
    TranslocoPipe,
    RelativeTimePipe,
    SegmentedComponent,
    MeterBarComponent,
    StatusBadgeComponent,
    ZardAlertDialogImports,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardCommandImports,
    HighlightedTextComponent,
    CodeEditorComponent,
    KbdComponent,
    AvatarComponent,
    ZardDialogImports,
    ZardDropdownImports,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardPopoverImports,
    ZardRadioGroupImports,
    ZardSelectImports,
    ZardSheetImports,
    ZardSwitchComponent,
    ZardTableImports,
    ZardTextareaComponent,
    ZardTooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-8' },
  template: `
    <section class="flex flex-col gap-3" aria-labelledby="showcase-table">
      <h2 id="showcase-table" class="text-lg font-medium">
        {{ 'ui.showcase.base.table.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'ui.showcase.base.table.hint' | transloco }}
      </p>
      @for (variant of tableVariants; track variant.label) {
        <div class="border-border max-w-full overflow-hidden rounded-lg border">
          <div
            class="max-w-full overflow-x-auto"
            role="region"
            tabindex="0"
            [attr.aria-label]="
              'ui.showcase.base.table.region'
                | transloco: { name: (variant.label | transloco) }
            "
          >
            <table
              z-table
              [zType]="variant.type"
              [zSize]="variant.size"
              class="min-w-[36rem]"
            >
              <caption z-table-caption>
                {{
                  variant.label | transloco
                }}
              </caption>
              <thead z-table-header>
                <tr z-table-row>
                  <th z-table-head class="w-8">
                    <z-checkbox
                      [zAriaLabel]="
                        'ui.showcase.base.table.selectAll' | transloco
                      "
                    />
                  </th>
                  <th z-table-head>
                    {{ 'ui.showcase.base.table.name' | transloco }}
                  </th>
                  <th z-table-head>
                    {{ 'ui.showcase.base.table.type' | transloco }}
                  </th>
                  <th z-table-head>
                    {{ 'ui.showcase.base.table.status' | transloco }}
                  </th>
                  <th z-table-head class="text-end">
                    {{ 'ui.showcase.base.table.changed' | transloco }}
                  </th>
                </tr>
              </thead>
              <tbody z-table-body>
                @for (row of rows; track row.name; let i = $index) {
                  <tr
                    z-table-row
                    [attr.data-state]="i === 1 ? 'selected' : null"
                  >
                    <td z-table-cell>
                      <z-checkbox
                        [zAriaLabel]="
                          'ui.showcase.base.table.select'
                            | transloco: { name: (row.name | transloco) }
                        "
                      />
                    </td>
                    <td z-table-cell class="font-medium">
                      {{ row.name | transloco }}
                    </td>
                    <td z-table-cell class="text-muted-foreground">
                      {{ row.type | transloco }}
                    </td>
                    <td z-table-cell>
                      <of-status-badge [status]="row.status" />
                    </td>
                    <td z-table-cell class="text-muted-foreground text-end">
                      {{ row.changed | ofRelativeTime }}
                    </td>
                  </tr>
                }
              </tbody>
              @if (variant.footer) {
                <tfoot z-table-footer>
                  <tr z-table-row>
                    <td z-table-cell colspan="4">
                      {{ 'ui.showcase.base.table.total' | transloco }}
                    </td>
                    <td z-table-cell class="text-end">{{ rows.length }}</td>
                  </tr>
                </tfoot>
              }
            </table>
          </div>
        </div>
      }
      <div class="border-border max-w-full overflow-x-auto rounded-lg border">
        <table z-table>
          <caption z-table-caption>
            {{
              'ui.showcase.base.table.empty' | transloco
            }}
          </caption>
          <thead z-table-header>
            <tr z-table-row>
              <th z-table-head>
                {{ 'ui.showcase.base.table.name' | transloco }}
              </th>
              <th z-table-head>
                {{ 'ui.showcase.base.table.type' | transloco }}
              </th>
            </tr>
          </thead>
          <tbody z-table-body>
            <tr z-table-row>
              <td
                z-table-cell
                colspan="2"
                class="text-muted-foreground py-6 text-center"
              >
                {{ 'ui.showcase.base.table.noRows' | transloco }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-input">
      <h2 id="showcase-input" class="text-lg font-medium">
        {{ 'ui.showcase.base.input.heading' | transloco }}
      </h2>
      <div class="grid gap-4 [&>*]:min-w-0 sm:grid-cols-2">
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.default' | transloco }}
          <input
            z-input
            [placeholder]="'ui.showcase.base.input.placeholder' | transloco"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.withValue' | transloco }}
          <input z-input [value]="'ui.showcase.base.input.typed' | transloco" />
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.focus' | transloco }}
          <input
            z-input
            [class]="focus"
            [placeholder]="'ui.showcase.base.input.focused' | transloco"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.disabled' | transloco }}
          <input
            z-input
            disabled
            [value]="'ui.showcase.base.input.notEditable' | transloco"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.invalid' | transloco }}
          <input
            z-input
            aria-invalid="true"
            aria-describedby="showcase-input-error"
            [value]="'ui.showcase.base.input.notAnAddress' | transloco"
          />
          <span id="showcase-input-error" class="text-destructive text-xs">{{
            'ui.showcase.base.input.validAddress' | transloco
          }}</span>
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.readOnly' | transloco }}
          <input
            z-input
            readonly
            [value]="'ui.showcase.base.input.readOnlyValue' | transloco"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-sm sm:col-span-2">
          {{ 'ui.showcase.base.input.textarea' | transloco }}
          <textarea
            z-textarea
            rows="3"
            [placeholder]="'ui.showcase.base.input.longer' | transloco"
          ></textarea>
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.textareaDisabled' | transloco }}
          <textarea
            z-textarea
            disabled
            rows="2"
            [value]="'ui.showcase.base.input.notEditable' | transloco"
          ></textarea>
        </label>
        <label class="flex flex-col gap-1.5 text-sm">
          {{ 'ui.showcase.base.input.textareaInvalid' | transloco }}
          <textarea
            z-textarea
            aria-invalid="true"
            rows="2"
            [value]="'ui.showcase.base.input.tooShort' | transloco"
          ></textarea>
        </label>
        <div class="flex flex-col gap-1.5 text-sm sm:col-span-2">
          <span id="showcase-group-label">{{
            'ui.showcase.base.input.group' | transloco
          }}</span>
          <z-input-group aria-labelledby="showcase-group-label">
            <z-input-group-addon>
              <span z-input-group-text>{{ scheme }}</span>
            </z-input-group-addon>
            <input
              z-input
              [attr.aria-label]="'ui.showcase.base.input.address' | transloco"
              [placeholder]="host"
            />
            <z-input-group-addon zAlign="inline-end">
              <button z-input-group-button>
                {{ 'ui.showcase.base.input.clear' | transloco }}
              </button>
            </z-input-group-addon>
          </z-input-group>
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-select">
      <h2 id="showcase-select" class="text-lg font-medium">
        {{ 'ui.showcase.base.select.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'ui.showcase.base.select.hint' | transloco }}
      </p>
      <div class="grid gap-4 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-3">
        <div class="flex flex-col gap-1.5 text-sm">
          <span id="sel-1">{{
            'ui.showcase.base.select.placeholder' | transloco
          }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.select.placeholder' | transloco"
            [zPlaceholder]="'ui.showcase.base.select.pickSize' | transloco"
            [(zValue)]="size"
          >
            @for (item of sizes; track item) {
              <z-select-item [zValue]="item">{{
                sizeKeys[item] | transloco
              }}</z-select-item>
            }
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.select.searchable' | transloco }}</span>
          <z-select
            id="select-searchable"
            zSearchable
            [zAriaLabel]="'ui.showcase.base.select.searchable' | transloco"
            [zPlaceholder]="'ui.showcase.base.select.pickCity' | transloco"
            [(zValue)]="city"
          >
            @for (item of cities; track item) {
              <z-select-item [zValue]="item">{{ item }}</z-select-item>
            }
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.input.withValue' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.input.withValue' | transloco"
            zValue="medium"
          >
            @for (item of sizes; track item) {
              <z-select-item [zValue]="item">{{
                sizeKeys[item] | transloco
              }}</z-select-item>
            }
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.disabled' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.disabled' | transloco"
            zDisabled
            zValue="medium"
          >
            <z-select-item zValue="medium">{{
              sizeKeys.medium | transloco
            }}</z-select-item>
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.invalid' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.invalid' | transloco"
            zInvalid
            [zPlaceholder]="'ui.showcase.base.select.required' | transloco"
          >
            @for (item of sizes; track item) {
              <z-select-item [zValue]="item">{{
                sizeKeys[item] | transloco
              }}</z-select-item>
            }
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.select.groups' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.select.groupsLabel' | transloco"
            [zPlaceholder]="'ui.showcase.base.select.pickKind' | transloco"
          >
            <z-select-group>
              <z-select-label>{{
                'ui.showcase.base.select.kinds' | transloco
              }}</z-select-label>
              <z-select-item zValue="concept">{{
                'ui.showcase.base.kind.concept' | transloco
              }}</z-select-item>
              <z-select-item zValue="procedure">{{
                'ui.showcase.base.kind.procedure' | transloco
              }}</z-select-item>
            </z-select-group>
            <z-select-separator />
            <z-select-group>
              <z-select-label>{{
                'ui.showcase.base.select.other' | transloco
              }}</z-select-label>
              <z-select-item zValue="faq" zDisabled>{{
                'ui.showcase.base.select.faqDisabled' | transloco
              }}</z-select-item>
              <z-select-item zValue="reference">{{
                'ui.showcase.base.kind.reference' | transloco
              }}</z-select-item>
            </z-select-group>
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.select.multiple' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.select.multiple' | transloco"
            zMultiple
            [zMaxLabelCount]="2"
            [zPlaceholder]="'ui.showcase.base.select.pickSome' | transloco"
            [zValue]="['concept', 'faq']"
          >
            <z-select-item zValue="concept">{{
              'ui.showcase.base.kind.concept' | transloco
            }}</z-select-item>
            <z-select-item zValue="procedure">{{
              'ui.showcase.base.kind.procedure' | transloco
            }}</z-select-item>
            <z-select-item zValue="faq">{{
              'ui.showcase.base.kind.faq' | transloco
            }}</z-select-item>
          </z-select>
        </div>
        <div class="flex flex-col gap-1.5 text-sm">
          <span>{{ 'ui.showcase.base.select.popper' | transloco }}</span>
          <z-select
            [zAriaLabel]="'ui.showcase.base.select.longLabel' | transloco"
            zPosition="popper"
            zValue="long"
          >
            <z-select-item zValue="long">{{
              'ui.showcase.base.select.long' | transloco
            }}</z-select-item>
            <z-select-item zValue="short">{{
              'ui.showcase.base.select.short' | transloco
            }}</z-select-item>
          </z-select>
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-choices">
      <h2 id="showcase-choices" class="text-lg font-medium">
        {{ 'ui.showcase.base.choices.heading' | transloco }}
      </h2>
      <div class="grid gap-6 [&>*]:min-w-0 sm:grid-cols-3">
        <fieldset class="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
          <legend class="mb-1 font-medium">
            {{ 'ui.showcase.base.choices.checkbox' | transloco }}
          </legend>
          <z-checkbox [(ngModel)]="checked">{{
            'ui.showcase.base.choices.uncheckedOrChecked' | transloco
          }}</z-checkbox>
          <z-checkbox [ngModel]="true">{{
            'ui.showcase.base.choices.checked' | transloco
          }}</z-checkbox>
          <z-checkbox zDisabled>{{
            'ui.showcase.base.disabled' | transloco
          }}</z-checkbox>
          <z-checkbox zDisabled [ngModel]="true">{{
            'ui.showcase.base.choices.disabledChecked' | transloco
          }}</z-checkbox>
          <z-checkbox zInvalid>{{
            'ui.showcase.base.invalid' | transloco
          }}</z-checkbox>
        </fieldset>
        <fieldset class="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
          <legend class="mb-1 font-medium">
            {{ 'ui.showcase.base.choices.radio' | transloco }}
          </legend>
          <z-radio-group
            [attr.aria-label]="
              'ui.showcase.base.choices.sampleChoice' | transloco
            "
            [(ngModel)]="choice"
          >
            <label class="flex items-center gap-2"
              ><z-radio value="a" />
              {{ 'ui.showcase.base.choices.first' | transloco }}</label
            >
            <label class="flex items-center gap-2"
              ><z-radio value="b" />
              {{ 'ui.showcase.base.choices.second' | transloco }}</label
            >
            <label class="flex items-center gap-2"
              ><z-radio value="c" zDisabled />
              {{ 'ui.showcase.base.disabled' | transloco }}</label
            >
          </z-radio-group>
          <z-radio-group
            [attr.aria-label]="
              'ui.showcase.base.choices.invalidChoice' | transloco
            "
            ngModel
          >
            <label class="flex items-center gap-2"
              ><z-radio value="x" zInvalid />
              {{ 'ui.showcase.base.invalid' | transloco }}</label
            >
          </z-radio-group>
          <z-radio-group
            [attr.aria-label]="
              'ui.showcase.base.choices.disabledGroup' | transloco
            "
            zDisabled
            [ngModel]="'a'"
          >
            <label class="flex items-center gap-2"
              ><z-radio value="a" />
              {{ 'ui.showcase.base.choices.groupDisabled' | transloco }}</label
            >
          </z-radio-group>
        </fieldset>
        <fieldset class="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
          <legend class="mb-1 font-medium">
            {{ 'ui.showcase.base.choices.switch' | transloco }}
          </legend>
          <z-switch [(zChecked)]="on">{{
            'ui.showcase.base.choices.offOrOn' | transloco
          }}</z-switch>
          <z-switch [zChecked]="true">{{
            'ui.showcase.base.choices.on' | transloco
          }}</z-switch>
          <z-switch zSize="sm">{{
            'ui.showcase.base.size.small' | transloco
          }}</z-switch>
          <z-switch zDisabled>{{
            'ui.showcase.base.disabled' | transloco
          }}</z-switch>
          <z-switch zDisabled [zChecked]="true">{{
            'ui.showcase.base.choices.disabledOn' | transloco
          }}</z-switch>
          <z-switch zInvalid>{{
            'ui.showcase.base.invalid' | transloco
          }}</z-switch>
        </fieldset>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-segmented">
      <h2 id="showcase-segmented" class="text-lg font-medium">
        {{ 'ui.showcase.base.segmented.heading' | transloco }}
      </h2>
      <of-segmented
        [label]="'ui.showcase.base.segmented.heading' | transloco"
        [options]="segmentedOptions()"
        [(value)]="segmented"
      />
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-meter">
      <h2 id="showcase-meter" class="text-lg font-medium">
        {{ 'ui.showcase.base.meter.heading' | transloco }}
      </h2>
      <div class="flex max-w-sm flex-col gap-3">
        @for (share of meterShares; track share) {
          <div class="flex items-center gap-3">
            <of-meter-bar
              class="flex-1"
              [value]="share"
              [label]="'ui.showcase.base.meter.heading' | transloco"
              [valueText]="
                'ui.showcase.base.meter.value' | transloco: { share }
              "
            />
            <span class="w-12 text-end text-sm tabular-nums">{{
              'ui.showcase.base.meter.value' | transloco: { share }
            }}</span>
          </div>
        }
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-code">
      <h2 id="showcase-code" class="text-lg font-medium">
        {{ 'ui.showcase.base.codeEditor.heading' | transloco }}
      </h2>
      <of-code-editor
        class="h-56 max-w-2xl"
        path="manual.typ"
        describedBy="showcase-code-hint"
        [label]="'ui.showcase.base.codeEditor.label' | transloco"
        [value]="codeSample"
        [markers]="[{ line: 6, message: 'unknown variable: colour' }]"
      />
      <p id="showcase-code-hint" class="text-muted-foreground m-0 text-xs">
        {{ 'ui.showcase.base.codeEditor.hint' | transloco }}
      </p>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-avatar">
      <h2 id="showcase-avatar" class="text-lg font-medium">
        {{ 'ui.showcase.base.avatar.heading' | transloco }}
      </h2>
      <div class="flex items-center gap-3">
        @let person = 'ui.showcase.base.avatar.sample' | transloco;
        <of-avatar [name]="person" size="sm" />
        <of-avatar [name]="person" />
        <of-avatar [name]="person" size="lg" />
        <span class="text-sm">{{ person }}</span>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-dialogs">
      <h2 id="showcase-dialogs" class="text-lg font-medium">
        {{ 'ui.showcase.base.dialogs.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'ui.showcase.base.dialogs.hint' | transloco }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <button z-button zType="outline" (click)="dialogOpen.set(true)">
          {{ 'ui.showcase.base.dialogs.openDialog' | transloco }}
        </button>
        <button z-button zType="destructive" (click)="alertOpen.set(true)">
          {{ 'ui.showcase.base.dialogs.openAlert' | transloco }}
        </button>
        @for (side of sheetSides; track side) {
          <button z-button zType="outline" (click)="sheet.set(side)">
            {{
              'ui.showcase.base.dialogs.openSheet'
                | transloco: { side: (sideKeys[side] | transloco) }
            }}
          </button>
        }
        <button z-button zType="secondary" (click)="paletteOpen.set(true)">
          {{ 'ui.showcase.base.dialogs.openPalette' | transloco }}
        </button>
      </div>

      <z-dialog [(zVisible)]="dialogOpen">
        <z-dialog-header>
          <z-dialog-title>{{
            'ui.showcase.base.dialogs.newItem' | transloco
          }}</z-dialog-title>
          <z-dialog-description>{{
            'ui.showcase.base.dialogs.fillIn' | transloco
          }}</z-dialog-description>
        </z-dialog-header>
        <div class="flex flex-col gap-3 text-sm">
          <label class="flex flex-col gap-1.5"
            >{{ 'ui.showcase.base.dialogs.title' | transloco }}
            <input
              z-input
              [placeholder]="'ui.showcase.base.dialogs.aTitle' | transloco"
          /></label>
          <div class="flex flex-col gap-1.5">
            <span>{{ 'ui.showcase.base.dialogs.kind' | transloco }}</span>
            <z-select
              [zAriaLabel]="'ui.showcase.base.dialogs.kind' | transloco"
              [zPlaceholder]="'ui.showcase.base.select.pickKind' | transloco"
            >
              <z-select-item zValue="concept">{{
                'ui.showcase.base.kind.concept' | transloco
              }}</z-select-item>
              <z-select-item zValue="procedure">{{
                'ui.showcase.base.kind.procedure' | transloco
              }}</z-select-item>
            </z-select>
          </div>
          <z-checkbox>{{
            'ui.showcase.base.dialogs.fromCopy' | transloco
          }}</z-checkbox>
        </div>
        <z-dialog-footer>
          <button z-button zType="ghost" z-dialog-close>
            {{ 'ui.dialog.cancel' | transloco }}
          </button>
          <button z-button z-dialog-close>
            {{ 'ui.showcase.base.dialogs.create' | transloco }}
          </button>
        </z-dialog-footer>
      </z-dialog>

      <z-alert-dialog [(zVisible)]="alertOpen" zSize="sm">
        <z-alert-dialog-header>
          <z-alert-dialog-title>{{
            'ui.showcase.base.dialogs.deleteTitle' | transloco
          }}</z-alert-dialog-title>
          <z-alert-dialog-description>{{
            'ui.showcase.base.dialogs.deleteText' | transloco
          }}</z-alert-dialog-description>
        </z-alert-dialog-header>
        <z-alert-dialog-footer>
          <button z-button zType="outline" z-alert-dialog-close>
            {{ 'ui.dialog.cancel' | transloco }}
          </button>
          <button z-button zType="destructive" z-alert-dialog-close>
            {{ 'ui.showcase.base.menu.delete' | transloco }}
          </button>
        </z-alert-dialog-footer>
      </z-alert-dialog>

      @for (side of sheetSides; track side) {
        <z-sheet
          [zVisible]="sheet() === side"
          (zVisibleChange)="!$event && sheet.set(null)"
          [zSide]="side"
        >
          <z-sheet-header>
            <z-sheet-title>{{
              'ui.showcase.base.dialogs.sheetFrom'
                | transloco: { side: (sideKeys[side] | transloco) }
            }}</z-sheet-title>
            <z-sheet-description>{{
              'ui.showcase.base.dialogs.sheetText' | transloco
            }}</z-sheet-description>
          </z-sheet-header>
          <div class="flex flex-col gap-3 p-4 pt-0 text-sm">
            <p class="m-0">
              {{ 'ui.showcase.base.dialogs.sheetContent' | transloco }}
            </p>
            <label class="flex flex-col gap-1.5"
              >{{ 'ui.showcase.base.dialogs.note' | transloco }}
              <input
                z-input
                [placeholder]="'ui.showcase.base.dialogs.aNote' | transloco"
            /></label>
          </div>
          <z-sheet-footer>
            <button z-button z-sheet-close>
              {{ 'ui.showcase.base.dialogs.done' | transloco }}
            </button>
          </z-sheet-footer>
        </z-sheet>
      }

      <z-dialog
        [(zVisible)]="paletteOpen"
        [zClosable]="false"
        zWidth="32rem"
        class="overflow-hidden p-0"
      >
        <z-dialog-header class="sr-only">
          <z-dialog-title>{{
            'ui.showcase.base.command.palette' | transloco
          }}</z-dialog-title>
          <z-dialog-description>{{
            'ui.showcase.base.command.searchFor' | transloco
          }}</z-dialog-description>
        </z-dialog-header>
        @if (paletteOpen()) {
          <z-command
            class="rounded-none border-0 shadow-none"
            (zCommandSelected)="
              paletteOpen.set(false); lastCommand.set($event.label)
            "
          >
            <z-command-input zVariant="palette">
              <kbd of-kbd data-slot="command-input-trailing">{{
                'ui.showcase.base.command.escape' | transloco
              }}</kbd>
            </z-command-input>
            <z-command-list>
              <z-command-option-group
                [zLabel]="'ui.showcase.base.command.goTo' | transloco"
              >
                <z-command-option
                  zValue="content"
                  [zLabel]="'ui.showcase.base.command.content' | transloco"
                  zShortcut="G C"
                >
                  <!-- A richer label: the match highlighted, a second line. -->
                  <span
                    data-slot="command-option-label"
                    class="flex flex-col gap-0.5"
                  >
                    <of-highlighted-text
                      class="font-medium"
                      [text]="'ui.showcase.base.command.content' | transloco"
                      [matches]="[{ start: 0, end: 4 }]"
                    />
                    <span class="text-muted-foreground text-xs">{{
                      'ui.showcase.base.command.contentHint' | transloco
                    }}</span>
                  </span>
                </z-command-option>
                <z-command-option
                  zValue="manuals"
                  [zLabel]="'ui.showcase.base.command.manuals' | transloco"
                  zShortcut="G M"
                />
              </z-command-option-group>
              <z-command-divider />
              <z-command-option-group
                [zLabel]="'ui.showcase.base.menu.actions' | transloco"
              >
                <z-command-option
                  zValue="new"
                  [zLabel]="'ui.showcase.base.dialogs.newItem' | transloco"
                />
                <z-command-option
                  zValue="off"
                  [zLabel]="'ui.showcase.base.command.notAvailable' | transloco"
                  zDisabled
                />
              </z-command-option-group>
            </z-command-list>
          </z-command>
        }
      </z-dialog>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-command">
      <h2 id="showcase-command" class="text-lg font-medium">
        {{ 'ui.showcase.base.command.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm" aria-live="polite">
        {{
          'ui.showcase.base.command.hint'
            | transloco
              : {
                  last: lastCommand() || ('ui.showcase.base.none' | transloco),
                }
        }}
      </p>
      <z-command
        class="border-border max-w-md rounded-lg border"
        (zCommandSelected)="lastCommand.set($event.label)"
      >
        <z-command-input
          [placeholder]="'ui.showcase.base.command.search' | transloco"
        />
        <z-command-list>
          <z-command-option-group
            [zLabel]="'ui.showcase.base.command.suggestions' | transloco"
          >
            <z-command-option
              zValue="content"
              [zLabel]="'ui.showcase.base.command.content' | transloco"
            />
            <z-command-option
              zValue="manuals"
              [zLabel]="'ui.showcase.base.command.manuals' | transloco"
            />
            <z-command-option
              zValue="review"
              [zLabel]="'ui.showcase.base.command.review' | transloco"
            />
          </z-command-option-group>
          <z-command-divider />
          <z-command-option-group
            [zLabel]="'ui.showcase.base.command.settings' | transloco"
          >
            <z-command-option
              zValue="profile"
              [zLabel]="'ui.showcase.base.command.profile' | transloco"
              zShortcut="P"
            />
            <z-command-option
              zValue="locked"
              [zLabel]="'ui.showcase.base.command.locked' | transloco"
              zDisabled
            />
          </z-command-option-group>
        </z-command-list>
      </z-command>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-popover">
      <h2 id="showcase-popover" class="text-lg font-medium">
        {{ 'ui.showcase.base.popover.heading' | transloco }}
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        @for (side of popSides; track side) {
          <button
            z-button
            zType="outline"
            zPopover
            [zContent]="pop"
            [zPlacement]="side"
          >
            {{
              'ui.showcase.base.popover.button'
                | transloco: { side: (sideKeys[side] | transloco) }
            }}
          </button>
        }
      </div>
      <ng-template #pop>
        <z-popover>
          <div z-popover-header>
            <h3 z-popover-title>
              {{ 'ui.showcase.base.popover.title' | transloco }}
            </h3>
            <p z-popover-description>
              {{ 'ui.showcase.base.popover.text' | transloco }}
            </p>
          </div>
          <label class="mt-2 flex flex-col gap-1.5 text-sm"
            >{{ 'ui.showcase.base.popover.width' | transloco }}
            <input z-input value="100"
          /></label>
        </z-popover>
      </ng-template>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-tooltip">
      <h2 id="showcase-tooltip" class="text-lg font-medium">
        {{ 'ui.showcase.base.tooltip.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'ui.showcase.base.tooltip.hint' | transloco }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        @for (side of tipSides; track side) {
          <button
            z-button
            zType="outline"
            [zTooltip]="
              'ui.showcase.base.tooltip.on'
                | transloco: { side: (sideKeys[side] | transloco) }
            "
            [zPosition]="side"
          >
            {{ sideKeys[side] | transloco }}
          </button>
        }
        <button
          z-button
          zType="outline"
          aria-disabled="true"
          class="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          [zTooltip]="'ui.showcase.base.tooltip.blockedReason' | transloco"
        >
          {{ 'ui.showcase.base.tooltip.blocked' | transloco }}
        </button>
        <button z-button zType="ghost" zDisabled>
          {{ 'ui.showcase.base.disabled' | transloco }}
        </button>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="showcase-dropdown">
      <h2 id="showcase-dropdown" class="text-lg font-medium">
        {{ 'ui.showcase.base.menu.heading' | transloco }}
      </h2>
      <p class="text-muted-foreground m-0 text-sm">
        {{ 'ui.showcase.base.menu.hint' | transloco }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <button z-button zType="outline" z-dropdown [zDropdownMenu]="menu">
          {{ 'ui.showcase.base.menu.open' | transloco }}
        </button>
        <button
          z-button
          zType="outline"
          z-dropdown
          [zDropdownMenu]="menu"
          zDisabled
        >
          {{ 'ui.showcase.base.menu.disabled' | transloco }}
        </button>
        <span class="text-muted-foreground text-sm">{{
          'ui.showcase.base.menu.state'
            | transloco
              : {
                  last: lastItem() || 'ui.showcase.base.none' | transloco,
                  notes: notes(),
                  sort: sort(),
                }
        }}</span>
      </div>
      <z-dropdown-menu-content #menu class="w-56">
        <z-dropdown-menu-label>{{
          'ui.showcase.base.menu.actions' | transloco
        }}</z-dropdown-menu-label>
        <z-dropdown-menu-item
          (click)="lastItem.set('ui.showcase.base.menu.openItem')"
        >
          {{ 'ui.showcase.base.menu.openItem' | transloco }}
          <z-dropdown-menu-shortcut>{{
            openShortcut
          }}</z-dropdown-menu-shortcut>
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          (click)="lastItem.set('ui.showcase.base.menu.rename')"
          >{{
            'ui.showcase.base.menu.rename' | transloco
          }}</z-dropdown-menu-item
        >
        <z-dropdown-menu-item zDisabled>{{
          'ui.showcase.base.disabled' | transloco
        }}</z-dropdown-menu-item>
        <z-dropdown-menu-separator />
        <z-dropdown-menu-checkbox-item [(zChecked)]="notes">{{
          'ui.showcase.base.menu.showNotes' | transloco
        }}</z-dropdown-menu-checkbox-item>
        <z-dropdown-menu-separator />
        <z-dropdown-menu-radio-group [(zValue)]="sort">
          <z-dropdown-menu-radio-item zValue="name">{{
            'ui.showcase.base.menu.sortName' | transloco
          }}</z-dropdown-menu-radio-item>
          <z-dropdown-menu-radio-item zValue="date">{{
            'ui.showcase.base.menu.sortDate' | transloco
          }}</z-dropdown-menu-radio-item>
        </z-dropdown-menu-radio-group>
        <z-dropdown-menu-separator />
        <z-dropdown-menu-sub-trigger [zSubMenu]="sub">{{
          'ui.showcase.base.menu.more' | transloco
        }}</z-dropdown-menu-sub-trigger>
        <z-dropdown-menu-separator />
        <z-dropdown-menu-item
          zType="destructive"
          (click)="lastItem.set('ui.showcase.base.menu.delete')"
          >{{
            'ui.showcase.base.menu.delete' | transloco
          }}</z-dropdown-menu-item
        >
      </z-dropdown-menu-content>
      <z-dropdown-menu-sub-content #sub>
        <z-dropdown-menu-item
          (click)="lastItem.set('ui.showcase.base.menu.export')"
          >{{
            'ui.showcase.base.menu.export' | transloco
          }}</z-dropdown-menu-item
        >
        <z-dropdown-menu-item
          (click)="lastItem.set('ui.showcase.base.menu.share')"
          >{{ 'ui.showcase.base.menu.share' | transloco }}</z-dropdown-menu-item
        >
      </z-dropdown-menu-sub-content>
    </section>
  `,
})
export class BaseShowcaseComponent {
  protected readonly focus = FOCUS;
  /** Not texts: a URL scheme, a host name and a key. */
  protected readonly scheme = 'https://';
  protected readonly host = 'example.test';
  protected readonly openShortcut = 'O';
  /** Place names, not texts: a long list with accents to search in. */
  protected readonly cities = [
    'Amsterdam',
    'Athens',
    'Barcelona',
    'Berlin',
    'Bratislava',
    'Brussels',
    'Budapest',
    'Cologne',
    'Copenhagen',
    'Düsseldorf',
    'Dublin',
    'Frankfurt',
    'Geneva',
    'Hamburg',
    'Helsinki',
    'Kraków',
    'Lisbon',
    'Ljubljana',
    'London',
    'Madrid',
    'Málaga',
    'Munich',
    'Oslo',
    'Paris',
    'Prague',
    'Rome',
    'Stockholm',
    'Vienna',
    'Warsaw',
    'Zürich',
  ];
  protected readonly city = signal<string | string[]>('');
  protected readonly sizes = ['small', 'medium', 'large'] as const;
  protected readonly sizeKeys = {
    small: 'ui.showcase.base.size.small',
    medium: 'ui.showcase.base.size.medium',
    large: 'ui.showcase.base.size.large',
  } as const;
  protected readonly sideKeys = {
    top: 'ui.showcase.base.side.top',
    bottom: 'ui.showcase.base.side.bottom',
    left: 'ui.showcase.base.side.left',
    right: 'ui.showcase.base.side.right',
  } as const;
  protected readonly size = signal<string | string[]>('');
  private readonly t = injectTranslate();
  protected readonly meterShares = [0, 40, 75, 100] as const;
  protected readonly codeSample = [
    '// The title page of an own template.',
    '#import "design.typ": *',
    '',
    '#let title-page(manual) = {',
    '  set text(size: 24pt, weight: "bold")',
    '  text(fill: colour)[#manual.title]',
    '}',
    '',
    '= Notes',
  ].join('\n');
  protected readonly segmented = signal('inline');
  protected readonly segmentedOptions = computed(() => [
    { value: 'inline', label: this.t('ui.showcase.base.segmented.inline') },
    {
      value: 'side',
      label: this.t('ui.showcase.base.segmented.sideBySide'),
    },
    {
      value: 'rendered',
      label: this.t('ui.showcase.base.segmented.rendered'),
    },
  ]);
  protected readonly checked = signal(false);
  protected readonly choice = signal('a');
  protected readonly on = signal(false);
  protected readonly dialogOpen = signal(false);
  protected readonly alertOpen = signal(false);
  protected readonly paletteOpen = signal(false);
  protected readonly sheet = signal<'left' | 'right' | 'top' | 'bottom' | null>(
    null,
  );
  protected readonly sheetSides = ['right', 'left', 'top', 'bottom'] as const;
  protected readonly popSides = ['top', 'bottom', 'left', 'right'] as const;
  protected readonly tipSides = ['top', 'bottom', 'left', 'right'] as const;
  protected readonly lastCommand = signal('');
  protected readonly lastItem = signal('');
  protected readonly notes = signal(true);
  protected readonly sort = signal<string | undefined>('name');

  private readonly now = Date.now();
  protected readonly rows = [
    {
      name: 'ui.showcase.base.table.item1',
      type: 'ui.showcase.base.kind.concept',
      status: 'released',
      changed: new Date(this.now - 2 * HOUR),
    },
    {
      name: 'ui.showcase.base.table.item2',
      type: 'ui.showcase.base.kind.procedure',
      status: 'in-review',
      changed: new Date(this.now - 24 * HOUR),
    },
    {
      name: 'ui.showcase.base.table.item3',
      type: 'ui.showcase.base.kind.reference',
      status: 'draft',
      changed: new Date(this.now - 72 * HOUR),
    },
  ] as const;
  protected readonly tableVariants = [
    {
      label: 'ui.showcase.base.input.default',
      type: 'default',
      size: 'default',
      footer: true,
    },
    {
      label: 'ui.showcase.base.table.compact',
      type: 'striped',
      size: 'compact',
      footer: false,
    },
    {
      label: 'ui.showcase.base.table.comfortable',
      type: 'bordered',
      size: 'comfortable',
      footer: false,
    },
  ] as const;
}
