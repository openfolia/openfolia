import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCode, lucideScale } from '@ng-icons/lucide';

import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';

import { AboutService } from './about.service';

/**
 * The account menu's links to the source code and the licence (#370), projected into
 * `of-account-menu`. Each opens in a new tab. Without a source address (`CCMS_SOURCE_URL`
 * unset) only the licence shows (#453): Admin → System holds the hint for the operator. Until
 * `GET /about` answers there is nothing, so a menu opened at once never shows a link that might
 * not be there.
 */
@Component({
  selector: 'of-about-menu-items',
  imports: [ZardDropdownImports, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCode, lucideScale })],
  host: { class: 'block' },
  template: `
    @if (service.about(); as about) {
      <z-dropdown-menu-separator />
      @if (about.sourceUrl) {
        <z-dropdown-menu-item
          data-testid="about-source"
          (click)="open(about.sourceUrl)"
        >
          <ng-icon name="lucideCode" [class]="iconClass" aria-hidden="true" />
          {{ 'editor.about.source' | transloco }}
        </z-dropdown-menu-item>
      }
      <z-dropdown-menu-item
        data-testid="about-licence"
        (click)="open(about.licenseUrl)"
      >
        <ng-icon name="lucideScale" [class]="iconClass" aria-hidden="true" />
        {{ 'editor.about.licence' | transloco: { license: about.license } }}
      </z-dropdown-menu-item>
    }
  `,
})
export class AboutMenuItemsComponent {
  protected readonly service = inject(AboutService);
  protected readonly iconClass = 'text-foreground size-4 shrink-0';

  constructor() {
    this.service.load();
  }

  /** Only http(s): `window.open` skips Angular's URL sanitising, whatever the API answered. */
  protected open(url: string): void {
    if (!URL.canParse(url)) return;
    const { protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
