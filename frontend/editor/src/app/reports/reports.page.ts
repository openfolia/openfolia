import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { PageHeaderComponent } from '@openfolia/ui/shell';
import { RouteFadeDirective } from '@openfolia/ui/smooth';
import { ZardTabLinkComponent, ZardTabNavComponent } from '@openfolia/ui/tabs';

import { REPORT_TABS } from './report-tabs';

/**
 * Reports (#56): how complete each manual is per language, and where each module is used. Each
 * tab is a route (`/reports/translations`, `/reports/usage`), so the address and Back keep it;
 * the tab's filters, sort and page are its query parameters.
 */
@Component({
  selector: 'of-reports-page',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    PageHeaderComponent,
    RouteFadeDirective,
    ZardTabNavComponent,
    ZardTabLinkComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.nav.reports' | transloco" />
    <p class="text-muted-foreground -mt-2 mb-0 text-sm break-words">
      {{ 'editor.reports.intro' | transloco }}
    </p>
    <nav
      z-tab-nav
      [attr.aria-label]="'editor.reports.sections' | transloco"
      class="h-auto self-start rounded-lg"
    >
      @for (tab of tabs; track tab.path) {
        <a
          z-tab-link
          [routerLink]="tab.path"
          routerLinkActive
          ariaCurrentWhenActive="page"
          class="text-foreground data-active:text-foreground h-8 px-4 font-normal data-active:font-medium"
          >{{ tab.label | transloco }}</a
        >
      }
    </nav>
    <router-outlet ofRouteFade />
  `,
})
export class ReportsPage {
  protected readonly tabs = REPORT_TABS;
}
