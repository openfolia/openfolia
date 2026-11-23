import { injectTranslate } from '../i18n/text.pipe';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { ZardBadgeComponent } from '../badge/badge.component';
import { type ZardBadgeTypeVariants } from '../badge/badge.variants';

export type ContentStatus =
  'draft' | 'in-review' | 'approved' | 'released' | 'deprecated';

export const contentStatuses: readonly ContentStatus[] = [
  'draft',
  'in-review',
  'approved',
  'released',
  'deprecated',
];

const labels: Record<ContentStatus, string> = {
  draft: 'ui.badges.status.draft',
  'in-review': 'ui.badges.status.inReview',
  approved: 'ui.badges.status.approved',
  released: 'ui.badges.status.released',
  deprecated: 'ui.badges.status.deprecated',
};
const types: Record<ContentStatus, ZardBadgeTypeVariants> = {
  draft: 'secondary',
  'in-review': 'info',
  approved: 'success',
  released: 'default',
  deprecated: 'destructive',
};

/** A workflow status: always the word (the colour only helps) on a badge. */
@Component({
  selector: 'of-status-badge',
  imports: [ZardBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-status]': 'status()', class: 'inline-flex' },
  template: `
    <span z-badge [zType]="type()">
      {{ text() }}
    </span>
  `,
})
export class StatusBadgeComponent {
  readonly status = input.required<ContentStatus>();
  /** Replaces the default word. */
  readonly label = input('');
  private readonly t = injectTranslate();
  protected readonly text = computed(
    () => this.label() || this.t(labels[this.status()]),
  );
  protected readonly type = computed(() => types[this.status()]);
}
