import { ChangeDetectionStrategy, Component } from '@angular/core';

import type { Schema } from '../../api';
import { InstallationChoiceComponent } from './installation-choice.component';

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

/**
 * Admin › Settings › Installation › Review (#588): who may approve their own change set, an
 * installation setting. Self-contained: it reads and writes only `/settings`, so it can move
 * elsewhere in the admin navigation as it is.
 */
@Component({
  selector: 'of-settings-review-rule',
  imports: [InstallationChoiceComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-4xl min-w-0' },
  template: `
    <of-installation-choice
      setting="selfApproval"
      group="self-approval"
      legend="editor.admin.settings.review.legend"
      note="editor.admin.settings.review.note"
      [options]="options"
    />
  `,
})
export class ReviewRuleTopicPage {
  protected readonly options = SELF_APPROVAL_OPTIONS;
}
