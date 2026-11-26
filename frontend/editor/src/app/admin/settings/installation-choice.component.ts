import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  input,
  type OnInit,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  SaveStatusComponent,
  type SaveStatus,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../../api';
import { apiErrorText } from '../../i18n';

/** The installation's settings (`/settings`). */
export type SettingsItem = Schema<'InstallationSettingsResource'>;
/** Those that are a choice among a few values. */
export type InstallationSettings = Pick<
  SettingsItem['attributes'],
  'selfApproval' | 'secondFactor' | 'singleSignOn'
>;
export type InstallationSetting = keyof InstallationSettings;

/** A value of a setting, with its label and explanation (translation keys). */
export interface InstallationOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
  /** Cannot be chosen (the saved one stays shown). */
  readonly disabled?: boolean;
}

/**
 * One installation setting as radio buttons (`GET`/`PATCH /settings`, `admin.roles`), never the
 * project configuration. A choice is shown at once and saved at once; a refusal puts the saved
 * one back, says why and tells the page (`refused`).
 */
@Component({
  selector: 'of-installation-choice',
  imports: [
    TranslocoPipe,
    ErrorStateComponent,
    FadeInDirective,
    SaveStatusComponent,
    ZardRadioGroupImports,
    ZardSkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @if (error(); as e) {
      <of-error-state [kind]="e.kind" [message]="e.message" (retry)="load()" />
    } @else if (value() === null) {
      <div ofFadeIn="delayed" class="flex flex-col gap-3" aria-hidden="true">
        <z-skeleton class="h-12 w-full" />
        <z-skeleton class="h-12 w-full" />
        <z-skeleton class="h-12 w-full" />
      </div>
    } @else {
      <fieldset
        ofFadeIn
        class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
        [attr.data-slot]="group()"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <legend class="m-0 p-0 text-sm font-medium break-words">
            {{ legend() | transloco }}
          </legend>
          @if (status(); as s) {
            <of-save-status class="ms-auto" [status]="s" />
          }
        </div>
        <z-radio-group
          class="border-border flex flex-col gap-0 divide-y rounded-lg border"
          [attr.aria-label]="legend() | transloco"
          [value]="value()"
          (valueChange)="choose($event)"
        >
          @for (o of options(); track o.value) {
            <label
              class="flex min-w-0 items-start gap-3 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none"
              [class]="
                off(o)
                  ? 'cursor-not-allowed'
                  : 'hover:bg-muted/50 cursor-pointer'
              "
              [attr.data-option]="o.value"
            >
              <z-radio
                class="mt-0.5"
                [value]="o.value"
                [zDisabled]="off(o)"
                [zId]="group() + '-' + o.value"
              />
              <span
                class="flex min-w-0 flex-col gap-0.5"
                [class.opacity-60]="off(o)"
              >
                <span class="text-sm font-medium break-words">{{
                  o.label | transloco
                }}</span>
                <span
                  class="text-muted-foreground text-[0.8125rem] leading-5 break-words"
                  >{{ o.hint | transloco }}</span
                >
              </span>
            </label>
          }
        </z-radio-group>
        <p
          class="text-muted-foreground m-0 max-w-prose text-[0.8125rem] leading-5 break-words"
        >
          {{ note() | transloco }}
        </p>
      </fieldset>
    }
  `,
})
export class InstallationChoiceComponent implements OnInit {
  readonly setting = input.required<InstallationSetting>();
  readonly options = input.required<readonly InstallationOption[]>();
  /** Names the group in the page (`data-slot`, the radio buttons' IDs). */
  readonly group = input.required<string>();
  readonly legend = input.required<string>();
  readonly note = input.required<string>();
  /** The refusals the page says itself (API error codes): no toast for them. */
  readonly saidByPage = input<string | readonly string[]>([]);
  /**
   * Asks before a choice is saved: answers whether it does (the saved one is shown meanwhile),
   * and calls `save` on a yes.
   */
  readonly ask = input<(value: string, save: () => void) => boolean>();
  /** The API refused a choice; null: one was made. */
  readonly refused = output<ApiError | null>();
  /** The settings, as the API just said: read, or with the choice saved. */
  readonly read = output<SettingsItem>();

  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);

  /** What is shown: the saved value, or the one being saved. Null until read. */
  protected readonly value = signal<string | null>(null);
  protected readonly status = signal<SaveStatus | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  /** The value as the API last said. */
  private saved: string | null = null;
  private sent = 0;

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/settings'));
      this.saved = doc.data.attributes[this.setting()];
      this.value.set(this.saved);
      this.read.emit(doc.data);
    } catch (e) {
      this.error.set(toApiError(e));
    }
  }

  /** Whether an option cannot be chosen; the saved one always shows as it is. */
  protected off(option: InstallationOption): boolean {
    return option.disabled === true && option.value !== this.value();
  }

  protected async choose(next: unknown): Promise<void> {
    if (next === this.value()) return;
    if (!this.options().some((o) => o.value === next && !this.off(o))) return;
    const value = next as string;
    if (this.ask()?.(value, () => void this.save(value))) {
      // The radio buttons moved: back, once they show it.
      this.value.set(value);
      afterNextRender(() => this.value.set(this.saved), {
        injector: this.injector,
      });
      return;
    }
    await this.save(value);
  }

  private async save(value: string): Promise<void> {
    const sent = ++this.sent;
    this.value.set(value);
    this.status.set('saving');
    this.refused.emit(null);
    try {
      const doc = await firstValueFrom(
        this.api.patch(
          '/settings',
          { path: {} as never },
          {
            data: {
              type: 'InstallationSettings',
              id: 'installation',
              attributes: { [this.setting()]: value },
            },
          },
        ),
      );
      // Every answer is what the API holds now; only the last choice's is shown.
      this.saved = doc.data.attributes[this.setting()];
      this.read.emit(doc.data);
      if (sent !== this.sent) return;
      this.value.set(this.saved);
      this.status.set('saved');
    } catch (e) {
      if (sent !== this.sent) return;
      this.value.set(this.saved);
      this.status.set('not-saved');
      const failure = toApiError(e);
      this.refused.emit(failure);
      if (![this.saidByPage()].flat().includes(failure.code)) {
        this.toast.error(apiErrorText(failure));
      }
    }
  }
}
