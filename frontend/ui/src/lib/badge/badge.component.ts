import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';

import type { ClassValue } from 'clsx';

import { mergeClasses } from '../ui/merge-classes';

import { badgeVariants, type ZardBadgeTypeVariants } from './badge.variants';

/** Zard UI's badge (installed the Zard way, with the theme's `success`, `warning` and `info` types added). */
@Component({
  selector: 'z-badge, span[z-badge]',
  template: `<ng-content />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    'data-slot': 'badge',
    '[class]': 'classes()',
  },
  exportAs: 'zBadge',
})
export class ZardBadgeComponent {
  readonly zType = input<ZardBadgeTypeVariants>('default');
  readonly class = input<ClassValue>('');

  protected readonly classes = computed(() =>
    mergeClasses(badgeVariants({ zType: this.zType() }), this.class()),
  );
}
