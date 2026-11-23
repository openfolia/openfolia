import {
  ChangeDetectionStrategy,
  Component,
  inject,
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

/** Who may approve their own change set (`/settings`, `selfApproval`). */
export type SelfApproval =
  Schema<'InstallationSettingsResource'>['attributes']['selfApproval'];

/** The rule's values in order, each with its label and explanation (translation keys). */
export const SELF_APPROVAL_OPTIONS: readonly {
  readonly value: SelfApproval;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: 'never',
    label: 'editor.admin.settings.review.never',
    hint: 'editor.admin.settings.review.neverHint',
  },
  {
    value: 'review',
    label: 'editor.admin.settings.review.review',
    hint: 'editor.admin.settings.review.reviewHint',
  },
  {
    value: 'review-and-sign-off',
    label: 'editor.admin.settings.review.all',
    hint: 'editor.admin.settings.review.allHint',
  },
];

const isSelfApproval = (value: unknown): value is SelfApproval =>
  SELF_APPROVAL_OPTIONS.some((o) => o.value === value);

/**
 * Admin › Settings › Installation › Review (#588): who may approve their own change set, an
 * installation setting kept by the API (`GET`/`PATCH /settings`, `admin.roles`), never the project
 * configuration. A choice is shown at once and saved at once; a refusal puts the saved one back
 * and says why. Self-contained: it reads and writes only `/settings`, so it can move elsewhere in
 * the admin navigation as it is.
 */
@Component({
  selector: 'of-settings-review-rule',
  imports: [
    TranslocoPipe,
    ErrorStateComponent,
    FadeInDirective,
    SaveStatusComponent,
    ZardRadioGroupImports,
    ZardSkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
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
        data-slot="self-approval"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <legend class="m-0 p-0 text-sm font-medium break-words">
            {{ 'editor.admin.settings.review.legend' | transloco }}
          </legend>
          @if (status(); as s) {
            <of-save-status class="ms-auto" [status]="s" />
          }
        </div>
        <z-radio-group
          class="border-border flex flex-col gap-0 divide-y rounded-lg border"
          [attr.aria-label]="'editor.admin.settings.review.legend' | transloco"
          [value]="value()"
          (valueChange)="choose($event)"
        >
          @for (o of options; track o.value) {
            <label
              class="hover:bg-muted/50 flex min-w-0 cursor-pointer items-start gap-3 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none"
              [attr.data-option]="o.value"
            >
              <z-radio
                class="mt-0.5"
                [value]="o.value"
                [zId]="'self-approval-' + o.value"
              />
              <span class="flex min-w-0 flex-col gap-0.5">
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
          {{ 'editor.admin.settings.review.note' | transloco }}
        </p>
      </fieldset>
    }
  `,
})
export class ReviewRuleTopicPage {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);

  protected readonly options = SELF_APPROVAL_OPTIONS;
  /** What is shown: the saved rule, or the one being saved. Null until read. */
  protected readonly value = signal<SelfApproval | null>(null);
  protected readonly status = signal<SaveStatus | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  /** The rule as the API last said. */
  private saved: SelfApproval | null = null;
  private sent = 0;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      const doc = await firstValueFrom(this.api.get('/settings'));
      this.saved = doc.data.attributes.selfApproval;
      this.value.set(this.saved);
    } catch (e) {
      this.error.set(toApiError(e));
    }
  }

  protected async choose(next: unknown): Promise<void> {
    if (!isSelfApproval(next) || next === this.value()) return;
    const sent = ++this.sent;
    this.value.set(next);
    this.status.set('saving');
    try {
      const doc = await firstValueFrom(
        this.api.patch(
          '/settings',
          { path: {} as never },
          {
            data: {
              type: 'InstallationSettings',
              id: 'installation',
              attributes: { selfApproval: next },
            },
          },
        ),
      );
      // Every answer is what the API holds now; only the last choice's is shown.
      this.saved = doc.data.attributes.selfApproval;
      if (sent !== this.sent) return;
      this.value.set(this.saved);
      this.status.set('saved');
    } catch (e) {
      if (sent !== this.sent) return;
      this.value.set(this.saved);
      this.status.set('not-saved');
      this.toast.error(apiErrorText(toApiError(e)));
    }
  }
}
