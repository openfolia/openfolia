import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleHelp,
  lucideKeyboard,
  lucideMap,
  lucideRotateCcw,
} from '@ng-icons/lucide';

import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { KbdComponent } from '@openfolia/ui/kbd';
import { ToastService, translated } from '@openfolia/ui/startup';

import { ShortcutsOverlay } from '../shortcuts/shortcuts-overlay.component';
import { PreferencesService } from '../tips/preferences.service';
import { TipsController } from '../tips/tips.controller';
import { HelpService } from './help.service';

/**
 * The account menu's help (#221), projected into `of-account-menu`: "Help for this page"
 * opens the screen's page of the user guide in a new tab (only while help links are on and the
 * screen has one), and "Keyboard shortcuts" opens the shortcut overlay, its key `?` beside it.
 * Then the tips (#222): "Show tips" turns tips and the tour on or off, "Take the tour" starts the
 * first-run tour again and "Reset tips" shows every tip again (only in the shell, which runs them).
 */
@Component({
  selector: 'of-help-menu-items',
  imports: [ZardDropdownImports, NgIcon, KbdComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleHelp,
      lucideKeyboard,
      lucideMap,
      lucideRotateCcw,
    }),
  ],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-separator />
    @if (help.page(); as page) {
      <z-dropdown-menu-item data-testid="help-page" (click)="open(page.href)">
        <ng-icon
          name="lucideCircleHelp"
          [class]="iconClass"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">{{
          'editor.help.menu.page' | transloco
        }}</span>
      </z-dropdown-menu-item>
    }
    <z-dropdown-menu-item
      data-testid="help-shortcuts"
      aria-keyshortcuts="?"
      (click)="overlay.open()"
    >
      <ng-icon name="lucideKeyboard" [class]="iconClass" aria-hidden="true" />
      <span class="min-w-0 flex-1 break-words">{{
        'editor.help.menu.shortcuts' | transloco
      }}</span>
      <kbd of-kbd aria-hidden="true">?</kbd>
    </z-dropdown-menu-item>
    @if (tips) {
      <z-dropdown-menu-checkbox-item
        data-testid="tips-show"
        [zChecked]="preferences.showTips()"
        (zCheckedChange)="tips.setShowTips($event)"
      >
        <span class="min-w-0 flex-1 break-words">{{
          'editor.help.menu.showTips' | transloco
        }}</span>
      </z-dropdown-menu-checkbox-item>
      <z-dropdown-menu-item
        data-testid="tips-tour"
        (click)="tips.restartTour()"
      >
        <ng-icon name="lucideMap" [class]="iconClass" aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words">{{
          'editor.help.menu.tour' | transloco
        }}</span>
      </z-dropdown-menu-item>
      <z-dropdown-menu-item data-testid="tips-reset" (click)="reset()">
        <ng-icon
          name="lucideRotateCcw"
          [class]="iconClass"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">{{
          'editor.help.menu.resetTips' | transloco
        }}</span>
      </z-dropdown-menu-item>
    }
  `,
})
export class HelpMenuItemsComponent {
  protected readonly help = inject(HelpService);
  protected readonly overlay = inject(ShortcutsOverlay);
  protected readonly tips = inject(TipsController, { optional: true });
  protected readonly preferences = inject(PreferencesService);
  private readonly toast = inject(ToastService);
  protected readonly iconClass = 'text-foreground size-4 shrink-0';

  constructor() {
    // The shell shows these once the person is known: the help is read from then on.
    this.help.load();
  }

  protected reset(): void {
    this.tips?.resetTips();
    this.toast.success(translated('editor.help.tipsReset'));
  }

  /** `window.open` skips Angular's URL sanitising: only the help service's `http(s)` addresses come here. */
  protected open(href: string): void {
    if (!URL.canParse(href)) return;
    const { protocol } = new URL(href);
    if (protocol !== 'http:' && protocol !== 'https:') return;
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}
