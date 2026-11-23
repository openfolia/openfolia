import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch } from '@ng-icons/lucide';

import { KbdComponent } from '@openfolia/ui/kbd';
import { isApplePlatform, ZardSidebarImports } from '@openfolia/ui/sidebar';

import { paletteShortcutLabel, SearchPalette } from './search-palette.service';

/**
 * The sidebar's way into the search palette, for the mouse: "Search" with the Cmd/Ctrl+K hint;
 * on the sidebar collapsed to icons, the icon with the same in a tooltip. Not shown when the
 * palette has nothing to offer the person.
 */
@Component({
  selector: 'of-search-trigger',
  imports: [ZardSidebarImports, NgIcon, KbdComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSearch })],
  host: { class: 'block' },
  template: `
    @if (palette.available()) {
      <ng-template #tip>
        {{ 'editor.search.open' | transloco }}
        <kbd
          data-slot="kbd"
          class="bg-background/20 rounded px-1.5 py-0.5 font-sans text-[11px] leading-none font-medium"
          >{{ shortcut }}</kbd
        >
      </ng-template>
      <ul z-sidebar-menu>
        <li z-sidebar-menu-item>
          <button
            type="button"
            z-sidebar-menu-button
            [zTooltip]="tip"
            [attr.aria-keyshortcuts]="keys"
            data-tip="shell.search"
            aria-haspopup="dialog"
            class="text-muted-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:sr-only [&_svg]:size-5"
            (click)="palette.open()"
          >
            <ng-icon
              name="lucideSearch"
              class="size-5"
              size="20"
              strokeWidth="1.5"
              aria-hidden="true"
            />
            <span class="flex-1 text-start">{{
              'editor.search.open' | transloco
            }}</span>
            <kbd
              of-kbd
              aria-hidden="true"
              class="group-data-[collapsible=icon]:hidden"
              >{{ shortcut }}</kbd
            >
          </button>
        </li>
      </ul>
    }
  `,
})
export class SearchTriggerComponent {
  protected readonly palette = inject(SearchPalette);
  protected readonly shortcut = paletteShortcutLabel();
  protected readonly keys = isApplePlatform() ? 'Meta+K' : 'Control+K';
}
