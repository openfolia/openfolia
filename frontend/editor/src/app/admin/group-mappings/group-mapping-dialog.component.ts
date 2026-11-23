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
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import type { RoleItem } from '../admin-model';
import {
  GROUP_MAX,
  type MappingDraft,
  mappingProblems,
  trimmedGroup,
} from './group-mappings-model';

/**
 * Adding a group mapping (#592): the group's name exactly as the identity provider sends it, and
 * the role its members hold. The page saves what it hands over (`save`) and closes the dialog
 * once the API has taken it, or shows why not (`error`) and keeps it open.
 */
@Component({
  selector: 'of-group-mapping-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[34rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.admin.groupMappings.dialog.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.groupMappings.dialog.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="group-mapping-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="group-mapping-group">{{
              'editor.admin.groupMappings.fields.group' | transloco
            }}</label>
            <input
              id="group-mapping-group"
              z-input
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              required
              [attr.maxlength]="groupMax"
              [attr.aria-invalid]="shown().group ? 'true' : null"
              aria-describedby="group-mapping-group-hint"
              [value]="group()"
              (input)="group.set($any($event.target).value)"
            />
            <p
              id="group-mapping-group-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!shown().group"
            >
              {{
                shown().group ?? 'editor.admin.groupMappings.fields.groupHint'
                  | transloco
              }}
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.admin.groupMappings.fields.role' | transloco
            }}</span>
            <z-select
              zSearchable
              zPosition="popper"
              [zAriaLabel]="
                'editor.admin.groupMappings.fields.role' | transloco
              "
              [zPlaceholder]="
                'editor.admin.groupMappings.fields.rolePlaceholder' | transloco
              "
              [zValue]="roleId()"
              (zSelectionChange)="setRole($event)"
            >
              @for (r of roles(); track r.id) {
                <z-select-item [zValue]="r.id">{{
                  r.attributes.name
                }}</z-select-item>
              }
            </z-select>
            @if (shown().role; as problem) {
              <p class="text-destructive m-0 text-xs">
                {{ problem | transloco }}
              </p>
            }
          </div>
          @if (error(); as message) {
            <p
              class="text-destructive m-0 text-sm break-words"
              role="alert"
              aria-live="assertive"
            >
              {{ message }}
            </p>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="group-mapping-form"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{ 'editor.admin.groupMappings.dialog.add' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class GroupMappingDialogComponent {
  readonly open = model(false);
  /** The roles to choose from. */
  readonly roles = input<readonly RoleItem[]>([]);
  /** The role chosen when the dialog opens (the page's role filter); empty for none. */
  readonly initialRole = input('');
  /** Saving is under way: the button waits. */
  readonly busy = input(false);
  /** Why the last save failed, translated; empty when it did not. */
  readonly error = input('');
  readonly save = output<MappingDraft>();

  protected readonly groupMax = GROUP_MAX;
  protected readonly group = signal('');
  protected readonly roleId = signal('');
  private readonly submitted = signal(false);

  private readonly problems = computed(() =>
    mappingProblems({ group: this.group(), roleId: this.roleId() }),
  );
  /** Problems once a save was tried. */
  protected readonly shown = computed(() =>
    this.submitted() ? this.problems() : {},
  );

  constructor() {
    // Every opening starts empty, with the filtered role chosen.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.group.set('');
        this.roleId.set(this.initialRole());
        this.submitted.set(false);
      });
    });
  }

  protected setRole(value: string | string[]): void {
    this.roleId.set(Array.isArray(value) ? (value[0] ?? '') : value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (Object.keys(this.problems()).length > 0 || this.busy()) return;
    this.save.emit({
      group: trimmedGroup(this.group()),
      roleId: this.roleId(),
    });
  }
}
