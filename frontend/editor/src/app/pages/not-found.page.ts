import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { EmptyStateComponent } from '@openfolia/ui/states';

import { ChangeSetUrl } from '../session/change-set-url';

/**
 * An address no screen has (the shell's catch-all): "Page not found", with the way to the start
 * page. Not the same as a section the role may not use, which is the no-access page.
 */
@Component({
  selector: 'of-not-found-page',
  imports: [
    PageHeaderComponent,
    EmptyStateComponent,
    ZardButtonComponent,
    RouterLink,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-4', 'data-testid': 'not-found-page' },
  template: `
    <of-page-header [title]="'editor.notFound.title' | transloco" />
    <div class="border-border rounded-xl border">
      <of-empty-state
        [title]="'editor.notFound.heading' | transloco"
        [description]="'editor.notFound.description' | transloco"
      >
        <a
          z-button
          zType="outline"
          routerLink="/"
          [queryParams]="changeSetUrl.paramsFor('/')"
          >{{ 'editor.notFound.home' | transloco }}</a
        >
      </of-empty-state>
    </div>
  `,
})
export class NotFoundPage {
  protected readonly changeSetUrl = inject(ChangeSetUrl);
}
