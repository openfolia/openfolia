import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLanguages, lucideMoon, lucideSun } from '@ng-icons/lucide';

import { ZardDropdownImports } from '../dropdown-menu/dropdown.imports';
import { ZardDropdownService } from '../dropdown-menu/dropdown.service';
import { LanguageService } from '../i18n/language.service';
import { ZardTooltipDirective } from '../tooltip/tooltip';
import { themeIconMotion } from '../theme/theme-fade';
import { type ThemePreference, ThemeService } from '../theme/theme.service';

const THEMES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'ui.theme.light' },
  { value: 'dark', label: 'ui.theme.dark' },
  { value: 'system', label: 'ui.theme.system' },
];

/**
 * The account menu at the foot of the sidebar: a button showing the person (round initials and
 * the name, or only the initials when the sidebar is collapsed) that opens a Dropdown Menu above
 * it. The menu shows who is signed in, the theme choice (Light, Dark or System, as menu radio
 * items: arrow keys, Home, End and type-ahead move, Enter or Space chooses), the interface
 * language in the same segmented style (each language named in itself) and the entries the app
 * projects (`z-dropdown-menu-item`s). Escape closes it and returns the focus to
 * the button.
 */
@Component({
  selector: 'of-account-menu',
  imports: [ZardDropdownImports, NgIcon, ZardTooltipDirective, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSun, lucideMoon, lucideLanguages })],
  host: { class: 'relative block' },
  template: `
    <button
      type="button"
      #tt="zTooltip"
      z-dropdown
      [zDropdownMenu]="menu"
      class="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring aria-expanded:bg-sidebar-accent flex items-center gap-2 rounded-md text-start text-sm outline-none focus-visible:ring-2"
      [class]="collapsed() ? 'size-10 justify-center' : 'h-8 w-full px-2'"
      [attr.aria-label]="
        collapsed()
          ? ('ui.account.labelCollapsed' | transloco: { name: name() })
          : name()
      "
      [zTooltip]="tooltip()"
      zPosition="right"
      (click)="tt.dismiss()"
    >
      <span
        class="bg-foreground text-background flex shrink-0 items-center justify-center rounded-full font-semibold"
        [class]="collapsed() ? 'size-7 text-[10px]' : 'size-5 text-[9px]'"
        aria-hidden="true"
        >{{ initials() }}</span
      >
      @if (!collapsed()) {
        <span class="min-w-0 flex-1 truncate">{{ name() }}</span>
      }
    </button>
    <z-dropdown-menu-content
      #menu
      zSide="top"
      zAlign="start"
      class="max-h-[34rem] w-64 max-w-[calc(100vw-2rem)]"
    >
      <div class="px-2 py-1.5" role="presentation">
        <p class="m-0 truncate text-sm font-medium">{{ name() }}</p>
        @if (role()) {
          <p class="text-muted-foreground m-0 truncate text-xs">
            {{ role() }}
          </p>
        }
      </div>
      <z-dropdown-menu-separator />
      <z-dropdown-menu-label class="flex items-center gap-2">
        <ng-icon
          [name]="theme.resolved() === 'dark' ? 'lucideMoon' : 'lucideSun'"
          [class]="iconClass"
          aria-hidden="true"
        />
        {{ 'ui.theme.label' | transloco }}
      </z-dropdown-menu-label>
      <z-dropdown-menu-radio-group
        class="bg-muted mx-1 mb-1 flex rounded-lg p-[3px]"
        [zValue]="theme.preference()"
        (zValueChange)="choose($event)"
        [attr.aria-label]="'ui.theme.label' | transloco"
      >
        @for (option of themes; track option.value) {
          <z-dropdown-menu-radio-item
            class="data-[state=checked]:bg-background h-7 flex-1 justify-center px-2 ps-2 data-[state=checked]:font-medium data-[state=checked]:shadow-sm [&>span:first-child]:hidden"
            [zValue]="option.value"
            [zCloseOnSelect]="false"
            >{{ option.label | transloco }}</z-dropdown-menu-radio-item
          >
        }
      </z-dropdown-menu-radio-group>
      <z-dropdown-menu-label class="flex items-center gap-2">
        <ng-icon
          name="lucideLanguages"
          class="text-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        {{ 'ui.language.label' | transloco }}
      </z-dropdown-menu-label>
      <z-dropdown-menu-radio-group
        class="bg-muted mx-1 mb-1 flex flex-wrap rounded-lg p-[3px]"
        [zValue]="language.active()"
        (zValueChange)="chooseLanguage($event)"
        [attr.aria-label]="'ui.language.label' | transloco"
      >
        @for (option of language.languages; track option.id) {
          <z-dropdown-menu-radio-item
            class="data-[state=checked]:bg-background h-7 flex-1 justify-center px-2 ps-2 whitespace-nowrap data-[state=checked]:font-medium data-[state=checked]:shadow-sm [&>span:first-child]:hidden"
            [zValue]="option.id"
            [zCloseOnSelect]="false"
            [attr.lang]="option.id"
            >{{ option.label }}</z-dropdown-menu-radio-item
          >
        }
      </z-dropdown-menu-radio-group>
      <ng-content />
    </z-dropdown-menu-content>
  `,
})
export class AccountMenuComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly themes = THEMES;
  protected readonly language = inject(LanguageService);
  protected readonly iconClass = `size-4 shrink-0 text-foreground ${themeIconMotion}`;

  readonly name = input.required<string>();
  /** The person's role, shown under the name. */
  readonly role = input('');
  readonly collapsed = input(false);

  private readonly dropdown = inject(ZardDropdownService);
  private readonly tip = viewChild(ZardTooltipDirective);

  /** The name, on the collapsed button only (where the initials alone say little), never over its open menu. */
  protected readonly tooltip = computed(() =>
    this.collapsed() && !this.dropdown.isOpen() ? this.name() : null,
  );

  protected readonly initials = computed(() =>
    this.name()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join(''),
  );

  constructor() {
    // A tooltip already showing (or about to) when the menu opens goes away with it.
    effect(() => {
      if (this.dropdown.isOpen()) {
        this.tip()?.dismiss();
      }
    });
  }

  protected choose(value: string | undefined): void {
    if (value === 'light' || value === 'dark' || value === 'system') {
      this.theme.choose(value);
    }
  }

  protected chooseLanguage(value: string | undefined): void {
    if (value) void this.language.choose(value);
  }
}
