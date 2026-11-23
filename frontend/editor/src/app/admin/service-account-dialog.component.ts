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
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import {
  DESCRIPTION_MAX,
  ID_MAX,
  NAME_MAX,
  type RoleItem,
} from './admin-model';
import {
  assignableToService,
  type ServiceAccountDraft,
  type ServiceAccountItem,
  serviceAccountIdOf,
  serviceAccountProblems,
} from './service-accounts-model';

/**
 * Adding a service account or changing one: name, description and roles; a new one also gets
 * its ID, made from the name and editable. The role picker offers only roles a service account
 * may hold (none with `admin.roles`). The page saves what it hands over (`save`) and closes the
 * dialog once the API has taken it, or shows why not (`error`) and keeps it open.
 */
@Component({
  selector: 'of-service-account-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardTextareaComponent,
    ZardSelectImports,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[34rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          (account()
            ? 'editor.admin.serviceAccounts.edit.title'
            : 'editor.admin.serviceAccounts.new.title'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.serviceAccounts.dialog.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="service-account-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="service-account-name">{{
              'editor.admin.serviceAccounts.fields.name' | transloco
            }}</label>
            <input
              id="service-account-name"
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
          @if (!account()) {
            <div class="flex flex-col gap-1.5">
              <label class="text-sm" for="service-account-id">{{
                'editor.admin.serviceAccounts.fields.id' | transloco
              }}</label>
              <input
                id="service-account-id"
                z-input
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                [attr.maxlength]="idMax"
                [attr.aria-invalid]="shown().id ? 'true' : null"
                aria-describedby="service-account-id-hint"
                [value]="id()"
                (input)="typedId.set($any($event.target).value)"
              />
              <p
                id="service-account-id-hint"
                class="text-muted-foreground m-0 text-xs break-words"
                [class.text-destructive]="!!shown().id"
              >
                {{
                  shown().id ?? 'editor.admin.serviceAccounts.fields.idHint'
                    | transloco
                }}
              </p>
            </div>
          }
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="service-account-description">{{
              'editor.admin.serviceAccounts.fields.description' | transloco
            }}</label>
            <textarea
              id="service-account-description"
              z-textarea
              rows="2"
              [attr.maxlength]="descriptionMax"
              [attr.aria-invalid]="shown().description ? 'true' : null"
              [placeholder]="
                'editor.admin.serviceAccounts.fields.descriptionHint'
                  | transloco
              "
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
            @if (shown().description; as problem) {
              <p class="text-destructive m-0 text-xs">
                {{ problem | transloco }}
              </p>
            }
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="text-sm">{{
              'editor.admin.serviceAccounts.fields.roles' | transloco
            }}</span>
            <z-select
              zMultiple
              zPosition="popper"
              [zMaxLabelCount]="3"
              [zAriaLabel]="
                'editor.admin.serviceAccounts.fields.roles' | transloco
              "
              [zPlaceholder]="
                'editor.admin.serviceAccounts.fields.noRoles' | transloco
              "
              [zValue]="roleIds()"
              (zSelectionChange)="setRoles($event)"
            >
              @for (r of offered(); track r.id) {
                <z-select-item [zValue]="r.id">{{
                  r.attributes.name
                }}</z-select-item>
              }
            </z-select>
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.admin.serviceAccounts.fields.rolesHint' | transloco }}
            </p>
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
          form="service-account-form"
          [zDisabled]="busy()"
          [zLoading]="busy()"
        >
          {{
            (account()
              ? 'editor.admin.save'
              : 'editor.admin.serviceAccounts.new.create'
            ) | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class ServiceAccountDialogComponent {
  readonly open = model(false);
  /** The service account to change; null to add one. */
  readonly account = input<ServiceAccountItem | null>(null);
  /** Every role; only those a service account may hold are offered. */
  readonly roles = input<readonly RoleItem[]>([]);
  /** Saving is under way: the button waits. */
  readonly busy = input(false);
  /** Why the last save failed, translated; empty when it did not. */
  readonly error = input('');
  readonly save = output<ServiceAccountDraft>();

  protected readonly nameMax = NAME_MAX;
  protected readonly idMax = ID_MAX;
  protected readonly descriptionMax = DESCRIPTION_MAX;
  protected readonly name = signal('');
  protected readonly description = signal('');
  /** The ID typed by hand; null while it follows the name. */
  protected readonly typedId = signal<string | null>(null);
  protected readonly roleIds = signal<string[]>([]);
  private readonly submitted = signal(false);

  protected readonly offered = computed(() =>
    this.roles().filter(assignableToService),
  );
  protected readonly id = computed(
    () => this.typedId() ?? serviceAccountIdOf(this.name()),
  );
  private readonly draft = computed((): ServiceAccountDraft => ({
    id: this.id().trim(),
    name: this.name(),
    description: this.description(),
    roleIds: this.roleIds(),
  }));
  private readonly problems = computed(() =>
    serviceAccountProblems(this.draft(), this.account() === null),
  );
  /** Problems once a save was tried. */
  protected readonly shown = computed(() =>
    this.submitted() ? this.problems() : {},
  );

  constructor() {
    // Every opening starts from the service account (or empty).
    effect(() => {
      if (!this.open()) return;
      const account = this.account();
      untracked(() => {
        this.name.set(account?.attributes.name ?? '');
        this.description.set(account?.attributes.description ?? '');
        this.typedId.set(null);
        this.roleIds.set(
          account?.relationships.roles.data.map((r) => r.id) ?? [],
        );
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
      description: draft.description.trim(),
    });
  }
}
