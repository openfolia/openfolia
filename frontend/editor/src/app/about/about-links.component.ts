import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { HelpService } from '../help/help.service';
import { AboutService } from './about.service';

/**
 * The source code and licence links as a line of text (#370), for pages outside the shell (the
 * sign-in page), so someone who cannot sign in is offered the source too. Without a source
 * address (`CCMS_SOURCE_URL` unset) only the licence shows (#453): Admin → System holds the hint
 * for the operator. First the page's own page of the user guide (#221: signing in), while help
 * links are on. Empty until `GET /about` answers; its height is kept meanwhile, so the page does
 * not move.
 */
@Component({
  selector: 'of-about-links',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'text-muted-foreground flex min-h-5 flex-wrap justify-center gap-x-3 gap-y-1 text-xs',
  },
  template: `
    @if (service.about(); as about) {
      @if (help.page(); as page) {
        <a
          [class]="linkClass"
          [href]="page.href"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="about-help"
          [attr.aria-label]="
            'ui.pageHelp.label' | transloco: { title: page.title }
          "
          >{{ 'editor.about.help' | transloco }}</a
        >
      }
      @if (about.sourceUrl) {
        <a
          [class]="linkClass"
          [href]="about.sourceUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="about-source"
          >{{ 'editor.about.source' | transloco }}</a
        >
      }
      <a
        [class]="linkClass"
        [href]="about.licenseUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="about-licence"
        >{{ 'editor.about.licence' | transloco: { license: about.license } }}</a
      >
    }
  `,
})
export class AboutLinksComponent {
  protected readonly service = inject(AboutService);
  protected readonly help = inject(HelpService);
  protected readonly linkClass =
    'hover:text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2';

  constructor() {
    this.help.load();
  }
}
