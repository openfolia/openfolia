import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLinkActive } from '@angular/router';
import type { ClassValue } from 'clsx';

import { mergeClasses } from '../ui/merge-classes';

import {
  tabButtonVariants,
  tabNavVariants,
  type ZardTabVariants,
} from './tabs.variants';

/**
 * Zard's tab list for tabs that are routes: a `<nav>` of links, so each tab has an address and
 * Back works (the content tabs of `z-tab-group` are buttons over panels on one page). It looks
 * like `z-tab-group`'s list; the current tab is the link `routerLinkActive` marks, with
 * `aria-current="page"`.
 *
 * ```html
 * <nav z-tab-nav aria-label="Admin sections">
 *   <a z-tab-link routerLink="roles" routerLinkActive ariaCurrentWhenActive="page">Roles</a>
 * </nav>
 * ```
 */
@Component({
  selector: 'nav[z-tab-nav]',
  template: `<ng-content />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    'data-slot': 'tabs-list',
    'data-orientation': 'horizontal',
    '[attr.data-variant]': 'zVariant()',
    '[class]': 'classes()',
  },
})
export class ZardTabNavComponent {
  readonly zVariant = input<ZardTabVariants['zVariant']>('default');
  readonly class = input<ClassValue>('');

  protected readonly classes = computed(() =>
    mergeClasses(
      // Scrolls sideways only. `overflow-x-auto` alone turns vertical overflow into a scrollbar too,
      // and each tab's underline (`after:`, 5px below the list) overflows it. The line variant
      // makes room for that underline, which it shows.
      'group/tabs max-w-full overflow-x-auto overflow-y-hidden data-[variant=line]:pb-[5px]',
      tabNavVariants({ zVariant: this.zVariant() }),
      this.class(),
    ),
  );
}

/**
 * One tab of a `z-tab-nav`: a router link with `routerLinkActive` on it, or with `zActive` when
 * the page decides which tab is current (one told apart by a query parameter, which
 * `routerLinkActive` cannot); `zActive` wins when given, and then also sets `aria-current="page"`
 * on the current tab (leave out `ariaCurrentWhenActive`), so the look and what a screen reader
 * hears never disagree.
 */
@Component({
  selector: 'a[z-tab-link]',
  template: `<ng-content />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    'data-slot': 'tab',
    '[attr.data-active]': "current() ? '' : null",
    '[attr.aria-current]':
      "zActive() === undefined ? null : zActive() ? 'page' : null",
    '[class]': 'classes()',
  },
})
export class ZardTabLinkComponent {
  readonly class = input<ClassValue>('');
  /** Whether this is the current tab; undefined: as `routerLinkActive` says. */
  readonly zActive = input<boolean | undefined>(undefined);

  protected readonly active = signal(false);
  protected readonly current = computed(() => this.zActive() ?? this.active());
  protected readonly classes = computed(() =>
    mergeClasses(tabButtonVariants(), 'flex-none', this.class()),
  );

  constructor() {
    // Without `routerLinkActive` on the link, it is simply never marked active.
    const linkActive = inject(RouterLinkActive, { self: true, optional: true });
    const subscription = linkActive?.isActiveChange.subscribe((active) =>
      this.active.set(active),
    );
    inject(DestroyRef).onDestroy(() => subscription?.unsubscribe());
  }
}
