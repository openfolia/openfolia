import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A key or shortcut as people read it (`Esc`, `⌘K`, `Ctrl+K`): a small keycap. Use on `<kbd>`.
 * It is text, not an icon, so a screen reader reads it as written.
 */
@Component({
  selector: 'kbd[of-kbd]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'kbd',
    class:
      'border-border bg-background text-muted-foreground inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[calc(var(--radius)-5px)] border px-1.5 font-sans text-[11px] leading-none font-medium whitespace-nowrap',
  },
  template: `<ng-content />`,
})
export class KbdComponent {}
