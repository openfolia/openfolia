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

import {
  directRoleIds,
  EMAIL_MAX,
  ID_MAX,
  NAME_MAX,
  type RoleItem,
  type UserDraft,
  type UserItem,
  userIdOf,
  userProblems,
} from './admin-model';

/**
 * Adding a person by hand (until sign-in creates them) or changing one: name, email address and
 * roles; a new one also gets its ID, made from the email address (or the name) and editable.
 * The page saves what it hands over (`save`) and closes the dialog once the API has taken it, or
 * shows why not (`error`) and keeps it open.
 */
@Component({
  selector: 'of-user-dialog',
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
          (user()
            ? 'editor.admin.users.edit.title'
            : 'editor.admin.users.new.title'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.users.dialog.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="user-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="user-name">{{
              'editor.admin.users.fields.name' | transloco
            }}</label>
            <input
              id="user-name"
              z-input
              autocomplete="off"
              required
              [attr.maxlength]="nameMax"
              [attr.aria-invalid]="shown().name ? 'true' : null"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
            />
            @if (shown().name; as problem) {
              <p class="text-destructive m-0 text-xs">
                {{ problem | transloco }}
              </p>
            }
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="user-email">{{
              'editor.admin.users.fields.email' | transloco
            }}</label>
            <input
              id="user-email"
              z-input
              type="email"
              autocomplete="off"
              [attr.maxlength]="emailMax"
              [attr.aria-invalid]="shown().email ? 'true' : null"
              [value]="email()"
              (input)="email.set($any($event.target).value)"
            />
            @if (shown().email; as problem) {
              <p class="text-destructive m-0 text-xs">
                {{ problem | transloco }}
              </p>
            }
          </div>
          @if (!user()) {
            <div class="flex flex-col gap-1.5">
              <label class="text-sm" for="user-id">{{
                'editor.admin.users.fields.id' | transloco
              }}</label>
              <input
                id="user-id"
                z-input
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                [attr.maxlength]="idMax"
                [attr.aria-invalid]="shown().id ? 'true' : null"
                aria-describedby="user-id-hint"
                [value]="id()"
                (input)="typedId.set($any($event.target).value)"
              />
              <p
                id="user-id-hint"
                class="text-muted-foreground m-0 text-xs break-words"
                [class.text-destructive]="!!shown().id"
              >
                {{
                  shown().id ?? 'editor.admin.users.fields.idHint' | transloco
                }}
              </p>
            </div>
          }
          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.admin.users.fields.roles' | transloco
            }}</span>
            <z-select
              zMultiple
              zPosition="popper"
              [zMaxLabelCount]="3"
              [zAriaLabel]="'editor.admin.users.fields.roles' | transloco"
              [zPlaceholder]="'editor.admin.users.fields.noRoles' | transloco"
              [zValue]="roleIds()"
              (zSelectionChange)="setRoles($event)"
            >
              @for (r of roles(); track r.id) {
                <z-select-item
                  [zValue]="r.id"
                  [zDisabled]="groupOnly().has(r.id)"
                  >{{ r.attributes.name }}</z-select-item
                >
              }
            </z-select>
            @if (groupRoleNames(); as names) {
              <p
                class="text-muted-foreground m-0 text-xs break-words"
                data-testid="group-roles"
              >
                {{
                  'editor.admin.users.fields.groupRoles'
                    | transloco: { roles: names }
                }}
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
          form="user-form"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{
            (user() ? 'editor.admin.save' : 'editor.admin.users.new.create')
              | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class UserDialogComponent {
  readonly open = model(false);
  /** The user to change; null to add one. */
  readonly user = input<UserItem | null>(null);
  /** The roles to choose from. */
  readonly roles = input<readonly RoleItem[]>([]);
  /** Saving is under way: the button waits. */
  readonly busy = input(false);
  /** Why the last save failed, translated; empty when it did not. */
  readonly error = input('');
  readonly save = output<UserDraft>();

  protected readonly nameMax = NAME_MAX;
  protected readonly emailMax = EMAIL_MAX;
  protected readonly idMax = ID_MAX;
  protected readonly name = signal('');
  protected readonly email = signal('');
  /** The ID typed by hand; null while it follows the email address or the name. */
  protected readonly typedId = signal<string | null>(null);
  protected readonly roleIds = signal<string[]>([]);
  /** The names of the roles the user holds through groups (#37), shown, not edited; null: none. */
  protected readonly groupRoleNames = computed(() => {
    const ids = this.user()?.meta?.groupRoleIds ?? [];
    if (ids.length === 0) return null;
    const names = new Map(this.roles().map((r) => [r.id, r.attributes.name]));
    return ids.map((id) => names.get(id) ?? id).join(', ');
  });
  /** Roles held only through groups (`groupRoleIds` leaves out direct ones): not offered. */
  protected readonly groupOnly = computed(
    () => new Set(this.user()?.meta?.groupRoleIds ?? []),
  );
  private readonly submitted = signal(false);

  protected readonly id = computed(
    () => this.typedId() ?? userIdOf(this.name(), this.email()),
  );
  private readonly draft = computed((): UserDraft => ({
    id: this.id().trim(),
    name: this.name(),
    email: this.email(),
    roleIds: this.roleIds(),
  }));
  private readonly problems = computed(() =>
    userProblems(this.draft(), this.user() === null),
  );
  /** Problems once a save was tried. */
  protected readonly shown = computed(() =>
    this.submitted() ? this.problems() : {},
  );

  constructor() {
    // Every opening starts from the user (or empty).
    effect(() => {
      if (!this.open()) return;
      const user = this.user();
      untracked(() => {
        this.name.set(user?.attributes.name ?? '');
        this.email.set(user?.attributes.email ?? '');
        this.typedId.set(null);
        this.roleIds.set(user ? directRoleIds(user) : []);
        this.submitted.set(false);
      });
    });
  }

  protected setRoles(value: string | string[]): void {
    this.roleIds.set(Array.isArray(value) ? value : value ? [value] : []);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (Object.keys(this.problems()).length > 0 || this.busy()) return;
    const draft = this.draft();
    this.save.emit({
      ...draft,
      name: draft.name.trim().replace(/\s+/g, ' '),
      email: draft.email.trim(),
    });
  }
}
