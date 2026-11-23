import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { NoAccessStateComponent } from '@openfolia/ui/states';

import { PERMISSION_TEXTS } from '../admin/admin-model';
import { PermissionService } from '../permissions/permission.service';
import { type ApiPermission } from '../permissions/me';
import { ChangeSetUrl } from '../session/change-set-url';
import { DemoSession } from '../session/demo-session';

/** What the page says (`data.noAccess`): the section, and the permission it needs. */
export interface NoAccessData {
  /** The section's name, a translation key. */
  readonly section: string;
  readonly permission: string;
}

/**
 * What a guarded section shows a role that may not use it (`guarded` in `app.routes.ts`): the
 * address stays, and the page names the section and the permission it needs, with the way to
 * the start page and, in demo mode, the hint to switch user. Once the person holds the permission
 * (a switch in the account menu), the address is opened again, so the section itself appears.
 *
 * It reveals nothing the sidebar does not: the section's name and its permission are the app's
 * own configuration, never data from the API.
 */
@Component({
  selector: 'of-no-access-page',
  imports: [
    PageHeaderComponent,
    NoAccessStateComponent,
    ZardButtonComponent,
    RouterLink,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-4', 'data-testid': 'no-access-page' },
  template: `
    <of-page-header [title]="data.section | transloco" />
    <div class="border-border rounded-xl border">
      <of-no-access
        [heading]="'editor.noAccess.title' | transloco"
        [message]="message()"
      >
        <div class="flex flex-col items-center gap-3">
          @if (demo.enabled()) {
            <p
              class="text-muted-foreground m-0 max-w-80 text-sm break-words"
              data-testid="no-access-demo-hint"
            >
              {{ 'editor.noAccess.demoHint' | transloco }}
            </p>
          }
          @if (!atStart) {
            <a
              z-button
              zType="outline"
              routerLink="/"
              [queryParams]="changeSetUrl.paramsFor('/')"
              >{{ 'editor.noAccess.home' | transloco }}</a
            >
          }
        </div>
      </of-no-access>
    </div>
  `,
})
export class NoAccessPage {
  private readonly route = inject(ActivatedRoute).snapshot;
  protected readonly data = this.route.data['noAccess'] as NoAccessData;
  /** The start page opens Content (`''` redirects there): no link back to this very page. */
  protected readonly atStart = this.route.url[0]?.path === 'content';
  protected readonly demo = inject(DemoSession);
  protected readonly changeSetUrl = inject(ChangeSetUrl);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionService);
  private readonly t = injectTranslate();

  protected readonly message = computed(() => {
    const key = PERMISSION_TEXTS[this.data.permission as ApiPermission] as
      string | undefined;
    return this.t('editor.noAccess.message', {
      section: this.t(this.data.section),
      permission: key ? this.t(key) : this.data.permission,
    });
  });

  constructor() {
    // The person now holds the permission (another demo user): open the address again.
    effect(() => {
      const rule = { permission: this.data.permission };
      if (this.permissions.state(rule).kind === 'hidden') return;
      untracked(
        () =>
          void this.router.navigateByUrl(this.router.url, {
            onSameUrlNavigation: 'reload',
            replaceUrl: true,
          }),
      );
    });
  }
}
