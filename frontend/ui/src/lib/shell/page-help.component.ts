import {
  ChangeDetectionStrategy,
  Component,
  inject,
  InjectionToken,
  type Signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleHelp } from '@ng-icons/lucide';

import { ZardButtonComponent } from '../button/button.component';
import { FadeInDirective } from '../smooth/fade-in.directive';
import { ZardTooltipDirective } from '../tooltip/tooltip';

/** The help page of the screen on show: where it is (an `http(s)` address) and its title. */
export interface PageHelpLink {
  readonly href: string;
  readonly title: string;
}

/**
 * The app's help for the screen on show (#221), or null when it has none (or the operator
 * turned the links off). The library knows no routes: the app provides this, and without it
 * no page shows a help link.
 */
export const PAGE_HELP = new InjectionToken<Signal<PageHelpLink | null>>(
  'PAGE_HELP',
);

/**
 * A screen's help link (#221): a quiet question-mark button that opens the screen's page of the
 * user guide in a new tab, its title in the tooltip and the accessible name. `of-page-header`
 * shows it beside the title; a screen with a heading of its own puts it there. Nothing while the
 * app has no page for the screen (`PAGE_HELP`); it fades in when one arrives, at the end of the
 * title's row, so nothing moves.
 */
@Component({
  selector: 'of-page-help',
  imports: [
    ZardButtonComponent,
    NgIcon,
    ZardTooltipDirective,
    TranslocoPipe,
    FadeInDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCircleHelp })],
  host: { class: 'contents' },
  template: `
    @if (help?.(); as link) {
      <a
        z-button
        zType="ghost"
        zSize="icon-sm"
        ofFadeIn
        data-slot="page-help"
        class="text-muted-foreground"
        [href]="link.href"
        target="_blank"
        rel="noopener noreferrer"
        [attr.aria-label]="
          'ui.pageHelp.label' | transloco: { title: link.title }
        "
        [zTooltip]="'ui.pageHelp.tooltip' | transloco: { title: link.title }"
        zPosition="bottom"
      >
        <ng-icon
          name="lucideCircleHelp"
          size="18"
          strokeWidth="1.75"
          aria-hidden="true"
        />
      </a>
    }
  `,
})
export class PageHelpComponent {
  protected readonly help = inject(PAGE_HELP, { optional: true });
}
