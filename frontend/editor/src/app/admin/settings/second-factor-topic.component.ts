import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { FadeInDirective } from '@openfolia/ui/smooth';

import type { ApiError, Schema } from '../../api';
import { SecondFactorDialogState } from '../../second-factor/second-factor-dialog-state';
import { InstallationChoiceComponent } from './installation-choice.component';

type SecondFactorRule =
  Schema<'InstallationSettingsResource'>['attributes']['secondFactor'];

/** Who must sign in with a second factor, each with its label and explanation. */
export const SECOND_FACTOR_OPTIONS: readonly {
  readonly value: SecondFactorRule;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: 'optional',
    label: 'editor.admin.settings.secondFactor.optional',
    hint: 'editor.admin.settings.secondFactor.optionalHint',
  },
  {
    value: 'admins',
    label: 'editor.admin.settings.secondFactor.admins',
    hint: 'editor.admin.settings.secondFactor.adminsHint',
  },
  {
    value: 'everyone',
    label: 'editor.admin.settings.secondFactor.everyone',
    hint: 'editor.admin.settings.secondFactor.everyoneHint',
  },
];

/**
 * Admin › Settings › Installation › Two-factor sign-in (#611): who must sign in with a second
 * factor. An admin who signs in with a password turns their own on first, so nobody can lock
 * themselves out: the refusal offers it right there.
 */
@Component({
  selector: 'of-settings-second-factor',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    FadeInDirective,
    InstallationChoiceComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideTriangleAlert })],
  host: { class: 'flex max-w-4xl min-w-0 flex-col gap-4' },
  template: `
    <of-installation-choice
      setting="secondFactor"
      group="second-factor"
      legend="editor.admin.settings.secondFactor.legend"
      note="editor.admin.settings.secondFactor.note"
      saidByPage="second-factor-own-first"
      [options]="options"
      (refused)="refused.set($event)"
    />
    @if (ownFirst()) {
      <div
        ofFadeIn
        role="alert"
        data-testid="second-factor-own-first"
        class="border-warning/40 bg-warning-muted flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center"
      >
        <p class="m-0 flex min-w-0 flex-1 items-start gap-2 break-words">
          <ng-icon
            name="lucideTriangleAlert"
            class="text-warning mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span class="min-w-0">{{
            'editor.apiErrors.codes.second-factor-own-first' | transloco
          }}</span>
        </p>
        <button
          z-button
          zType="outline"
          type="button"
          class="h-auto min-h-8 w-fit py-1 whitespace-normal"
          (click)="dialog.open.set(true)"
        >
          {{ 'editor.admin.settings.secondFactor.setUpOwn' | transloco }}
        </button>
      </div>
    }
  `,
})
export class SecondFactorTopicPage {
  protected readonly dialog = inject(SecondFactorDialogState);
  protected readonly options = SECOND_FACTOR_OPTIONS;
  protected readonly refused = signal<ApiError | null>(null);
  protected readonly ownFirst = computed(
    () => this.refused()?.code === 'second-factor-own-first',
  );

  constructor() {
    // Their own set up from here: the refusal is of before.
    effect(() => {
      if (!this.dialog.open()) this.refused.set(null);
    });
  }
}
