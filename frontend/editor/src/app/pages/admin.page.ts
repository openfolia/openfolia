import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { RouteFadeDirective } from '@openfolia/ui/smooth';
import { ZardSelectImports } from '@openfolia/ui/select';
import { TranslocoPipe } from '@jsverse/transloco';
import { filter, map, startWith } from 'rxjs';

import { AdminActions } from '../admin/admin-actions';
import { GuardDirective } from '../permissions/guard.directive';
import { PermissionService } from '../permissions/permission.service';
import { ChangeSetUrl } from '../session/change-set-url';
import { ADMIN_TABS, groupTabs, tabRule } from '../shell/nav';

/**
 * Admin pages share a side rail (#591): the pages the role may open under their group headings
 * (`ADMIN_GROUPS`), a group with none left out. Each page is a route, so the address and Back
 * work; a page the role cannot open is not in the rail, and its address shows the no-access page.
 * Below desktop width the rail is a select above the page, with the groups as option groups. The
 * open page names the page (its title is the heading, "Admin" the breadcrumb above it) and brings
 * its primary action, which goes through the permission helper. Project settings keeps its own
 * topic list inside its page; the rail marks it current on every topic.
 */
@Component({
  selector: 'of-admin',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    NgIcon,
    PageHeaderComponent,
    RouteFadeDirective,
    ZardButtonComponent,
    ZardSelectImports,
    GuardDirective,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The page's screen (in the outlet) answers the header's action.
  providers: [AdminActions],
  viewProviders: [provideIcons({ lucidePlus })],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="tab()?.title ?? 'editor.nav.admin' | transloco">
      @if (tab()?.action; as action) {
        <button
          z-button
          type="button"
          [ofGuard]="action.rule"
          (click)="actions.request(tab()?.path ?? '')"
        >
          <ng-icon
            name="lucidePlus"
            data-icon="inline-start"
            strokeWidth="1.5"
            aria-hidden="true"
          />
          {{ action.label | transloco }}
        </button>
      }
    </of-page-header>
    <div
      class="grid min-w-0 items-start gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8"
    >
      <nav
        class="hidden min-w-0 flex-col gap-4 lg:sticky lg:top-0 lg:flex"
        data-slot="admin-rail"
        [attr.aria-label]="'editor.admin.sections' | transloco"
      >
        @for (g of groups(); track g.group) {
          <div
            class="flex min-w-0 flex-col gap-0.5"
            role="group"
            [attr.aria-labelledby]="'admin-group-' + g.group"
          >
            <p
              class="text-muted-foreground m-0 px-3 pb-1 text-xs font-medium break-words"
              [id]="'admin-group-' + g.group"
            >
              {{ g.title | transloco }}
            </p>
            <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
              @for (t of g.tabs; track t.path) {
                <li class="min-w-0">
                  <a
                    class="hover:bg-muted focus-visible:ring-ring/50 data-active:bg-muted block rounded-md px-3 py-1.5 text-sm break-words transition-colors duration-150 outline-none focus-visible:ring-2 data-active:font-medium motion-reduce:transition-none"
                    [routerLink]="t.path"
                    [queryParams]="csLink.params()"
                    routerLinkActive
                    [routerLinkActiveOptions]="activeOptions"
                    #active="routerLinkActive"
                    [attr.data-active]="active.isActive ? '' : null"
                    ariaCurrentWhenActive="page"
                    [attr.data-page]="t.path"
                    >{{ t.label | transloco }}</a
                  >
                </li>
              }
            </ul>
          </div>
        }
      </nav>

      <div class="flex min-w-0 flex-col lg:hidden">
        <z-select
          zPosition="popper"
          data-slot="admin-rail-select"
          [zAriaLabel]="'editor.admin.sections' | transloco"
          [zValue]="selected()"
          (zSelectionChange)="go($any($event))"
        >
          @for (g of groups(); track g.group) {
            <z-select-group>
              <z-select-label>{{ g.title | transloco }}</z-select-label>
              @for (t of g.tabs; track t.path) {
                <z-select-item [zValue]="t.path">{{
                  t.label | transloco
                }}</z-select-item>
              }
            </z-select-group>
          }
        </z-select>
      </div>

      <div class="flex min-w-0 flex-col">
        <router-outlet ofRouteFade />
      </div>
    </div>
  `,
})
export class AdminPage {
  private readonly permissions = inject(PermissionService);
  /** The pages the role may open (a webhook manager without `admin.roles`: Webhooks alone). */
  private readonly tabs = computed(() =>
    ADMIN_TABS.filter(
      (t) => this.permissions.state(tabRule(t)).kind !== 'hidden',
    ),
  );
  /** Those pages under their groups; a group with none is left out. */
  protected readonly groups = computed(() => groupTabs(this.tabs()));
  protected readonly actions = inject(AdminActions);
  /** Links keep the chosen change set (`?cs=`). */
  protected readonly csLink = inject(ChangeSetUrl);
  /** A page is current on its own pages too (a settings topic, a page design), whatever its query. */
  protected readonly activeOptions = {
    paths: 'subset',
    queryParams: 'ignored',
    matrixParams: 'ignored',
    fragment: 'ignored',
  } as const;
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** The open page, from the child route's path. */
  protected readonly tab = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => {
        const path = this.route.snapshot.firstChild?.routeConfig?.path ?? '';
        // A page's own pages (a page design, `page-designs/:designId`) belong to the page.
        const [tab, ...rest] = path.split('/');
        const found = ADMIN_TABS.find((t) => t.path === tab);
        return found && rest.length > 0
          ? { ...found, action: undefined }
          : found;
      }),
    ),
    { initialValue: undefined },
  );

  /** The open page in the phone-width select; none on a page the role cannot open (no access). */
  protected readonly selected = computed(() => {
    const path = this.tab()?.path ?? '';
    return this.tabs().some((t) => t.path === path) ? path : '';
  });

  /** The phone-width select chose a page. */
  protected go(path: string): void {
    if (path === this.tab()?.path) return;
    if (!this.tabs().some((t) => t.path === path)) return;
    void this.router.navigate([path], {
      relativeTo: this.route,
      queryParams: this.csLink.params(),
    });
  }
}
