import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
} from '@angular/core';

import { ZARD_SIDEBAR_KEYBOARD_SHORTCUT } from './sidebar.constants';

/** True on Apple platforms, where the sidebar shortcut is Cmd+B rather than Ctrl+B. */
export function isApplePlatform(
  nav: Pick<Navigator, 'platform'> & {
    userAgentData?: { platform?: string };
  } = globalThis.navigator,
): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The sidebar toggle shortcut as people read it: `⌘B` on Apple platforms, `Ctrl+B` elsewhere. */
export function sidebarShortcutLabel(apple = isApplePlatform()): string {
  const key = ZARD_SIDEBAR_KEYBOARD_SHORTCUT.toUpperCase();
  return apple ? `\u2318${key}` : `Ctrl+${key}`;
}

/** The shortcut as a key hint, for the inside of a tooltip (the tooltip styles `data-slot="kbd"`). */
@Component({
  selector: 'of-sidebar-shortcut',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `<kbd
    data-slot="kbd"
    class="bg-background/20 rounded px-1.5 py-0.5 font-sans text-[11px] leading-none font-medium"
    >{{ label }}</kbd
  >`,
})
export class SidebarShortcutComponent {
  protected readonly label = sidebarShortcutLabel();
}
