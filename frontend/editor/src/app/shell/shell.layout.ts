import { CdkScrollable } from '@angular/cdk/scrolling';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBook,
  lucideBookA,
  lucideCircleCheck,
  lucideFile,
  lucideGlobe,
  lucideChartColumn,
  lucideImage,
  lucidePackage,
  lucidePanelLeftOpen,
  lucideShield,
} from '@ng-icons/lucide';
import { ZardBreadcrumbImports } from '@openfolia/ui/breadcrumb';
import { LogoComponent } from '@openfolia/ui/logo';
import { ZardSeparatorComponent } from '@openfolia/ui/separator';
import { AccountMenuComponent, PAGE_HELP } from '@openfolia/ui/shell';
import {
  SidebarShortcutComponent,
  ZardSidebarImports,
} from '@openfolia/ui/sidebar';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RouteFadeDirective } from '@openfolia/ui/smooth';
import { ErrorStateComponent } from '@openfolia/ui/states';
import { ToasterComponent } from '@openfolia/ui/toast';
import { ZardTooltipDirective } from '@openfolia/ui/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import { filter, map, startWith } from 'rxjs';

import { BrandingService } from '../branding/branding.service';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { ChangeSetBranchMissingComponent } from '../session/change-set-branch-missing.component';
import { changeSetModeOf, ChangeSetUrl } from '../session/change-set-url';
import { ChangeSetSession } from '../session/change-set-session';
import { DemoSession } from '../session/demo-session';
import { DemoUserSwitchComponent } from '../session/demo-user-switch.component';
import { SignOutMenuItemComponent } from '../session/sign-out-menu-item.component';
import { NotificationsMenuItemComponent } from '../notifications/notifications-menu-item.component';
import { NotificationSettingsService } from '../notifications/notification-settings.service';
import {
  ChangePasswordDialogComponent,
  ChangePasswordMenuItemComponent,
} from '../session/change-password.component';
import {
  SecondFactorDialogComponent,
  SecondFactorMenuItemComponent,
} from '../second-factor/second-factor-dialog.component';
import { ChangeSetBaseRewrittenComponent } from '../session/change-set-base-rewritten.component';
import { CarryForwardConflictsComponent } from '../session/carry-forward-conflicts.component';
import { ChangeSetConflictsComponent } from '../session/change-set-conflicts.component';
import { ChangeSetControlComponent } from '../session/change-set-control.component';
import { AboutMenuItemsComponent } from '../about/about-menu-items.component';
import { HelpMenuItemsComponent } from '../help/help-menu-items.component';
import { HelpService } from '../help/help.service';
import { ShortcutsOverlayComponent } from '../shortcuts/shortcuts-overlay.component';
import { TipsController } from '../tips/tips.controller';
import { SearchPaletteComponent } from '../search/search-palette.component';
import { SearchTriggerComponent } from '../search/search-trigger.component';
import { NotificationBellComponent } from '../notifications/notification-bell.component';
import { NotificationsSheetComponent } from '../notifications/notifications-sheet.component';
import { NAV_ITEMS } from './nav';
import { breadcrumbsOf, sidebarModeOf } from './breadcrumbs';
import { ShellState } from './shell-state';
import { SandboxBannerComponent } from '../sandbox/sandbox-banner.component';
import { SandboxSession } from '../sandbox/sandbox-session';
import { SignInSession } from '../session/sign-in-session';
import { signInTree } from '../sign-in/sign-in.guards';

/** Whether the active screen reads at the session's change set (`ShellLayout.readsChangeSet`). */
function readsChangeSet(root: ActivatedRouteSnapshot): boolean {
  if (changeSetModeOf(root) !== 'session') return false;
  for (
    let node: ActivatedRouteSnapshot | null = root;
    node;
    node = node.firstChild
  ) {
    if (node.routeConfig?.data?.['changeSetFree'] === true) return false;
  }
  return true;
}

/** Placeholder rows for the nav while `GET /me` has not named the person. */
const NAV_PLACEHOLDERS = [1, 2, 3, 4, 5];

/**
 * The frame of every screen: Zard's floating sidebar on the left, full height (expanded with the
 * logo and labels, or collapsed to icons with the logo mark and the account initials), and the
 * page on the right under its breadcrumb. Below tablet width the sidebar is a drawer opened from
 * the menu button above the page. The page column never scrolls sideways (`min-w-0`; long content
 * wraps or scrolls inside its own box).
 */
@Component({
  selector: 'of-shell',
  imports: [
    SandboxBannerComponent,
    CdkScrollable,
    RouterOutlet,
    RouteFadeDirective,
    FadeInDirective,
    RouterLink,
    RouterLinkActive,
    ZardSidebarImports,
    ZardBreadcrumbImports,
    ZardSeparatorComponent,
    AccountMenuComponent,
    LogoComponent,
    ToasterComponent,
    NgIcon,
    SidebarShortcutComponent,
    ZardTooltipDirective,
    TranslocoPipe,
    ErrorStateComponent,
    ZardSkeletonComponent,
    ChangeSetControlComponent,
    ChangeSetBranchMissingComponent,
    ChangeSetConflictsComponent,
    CarryForwardConflictsComponent,
    ChangeSetBaseRewrittenComponent,
    DemoUserSwitchComponent,
    SignOutMenuItemComponent,
    NotificationsMenuItemComponent,
    ChangePasswordMenuItemComponent,
    ChangePasswordDialogComponent,
    SecondFactorMenuItemComponent,
    SecondFactorDialogComponent,
    AboutMenuItemsComponent,
    HelpMenuItemsComponent,
    ShortcutsOverlayComponent,
    SearchTriggerComponent,
    SearchPaletteComponent,
    NotificationBellComponent,
    NotificationsSheetComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Every screen's page header links to its page of the user guide (issue 221).
  providers: [
    { provide: PAGE_HELP, useFactory: () => inject(HelpService).page },
    // The tips and the first-run tour run while the shell is on screen (issue 222).
    TipsController,
  ],
  viewProviders: [
    provideIcons({
      lucideFile,
      lucideBook,
      lucideBookA,
      lucideCircleCheck,
      lucideGlobe,
      lucidePackage,
      lucideChartColumn,
      lucideImage,
      lucideShield,
      lucidePanelLeftOpen,
    }),
  ],
  template: `
    <ng-template #expandTip>
      {{ 'editor.shell.expandSidebar' | transloco }} <of-sidebar-shortcut />
    </ng-template>
    <ng-template #collapseTip>
      {{ 'editor.shell.collapseSidebar' | transloco }}
      <of-sidebar-shortcut />
    </ng-template>
    <z-sidebar-provider
      #provider="zSidebarProvider"
      class="bg-background text-foreground h-dvh overflow-hidden"
      [zDefaultOpen]="true"
      [zOpen]="!state.collapsed()"
      (zOpenChange)="state.setOpen($event)"
    >
      <z-sidebar zVariant="floating" zCollapsible="icon">
        @let iconOnly =
          state.collapsed() && !provider.sidebarService.isMobile();
        <!-- Both header states stay rendered, stacked in one grid cell, and crossfade in step with
             the sidebar's width (200 ms, linear): the hidden one is inert. The cell keeps one
             height, so nothing below it moves (issue 484). -->
        <z-sidebar-header class="grid px-2 pt-3 pb-2">
          <div
            data-header="full"
            class="col-start-1 row-start-1 flex h-10 min-w-0 items-center justify-between overflow-x-clip px-2 transition-opacity duration-200 ease-linear motion-reduce:transition-none"
            [class.opacity-0]="iconOnly"
            [class.pointer-events-none]="iconOnly"
            [attr.inert]="iconOnly ? '' : null"
          >
            <a
              routerLink="/"
              [queryParams]="csLink.params()"
              (click)="provider.sidebarService.setOpenMobile(false)"
              class="focus-visible:ring-sidebar-ring flex h-10 shrink-0 items-center rounded-md outline-none focus-visible:ring-2"
            >
              <of-logo
                variant="full"
                [productName]="brand().productName"
                [small]="brand().logo.small"
                [smallDark]="brand().logo.smallDark"
                [full]="brand().logo.full"
                [fullDark]="brand().logo.fullDark"
              />
            </a>
            <button
              z-sidebar-trigger
              class="text-muted-foreground size-8 shrink-0 [&_ng-icon]:size-[18px]! [&_svg]:size-[18px]!"
              [attr.aria-label]="
                (provider.sidebarService.isMobile()
                  ? 'editor.shell.closeSidebar'
                  : 'editor.shell.collapseSidebar'
                ) | transloco
              "
              [zTooltip]="
                provider.sidebarService.isMobile() ? null : collapseTip
              "
              zPosition="bottom"
              (click)="focusAfterToggle($event, '[data-header=mark] button')"
            ></button>
          </div>
          @if (!provider.sidebarService.isMobile()) {
            <!-- Anchored where the collapsed cell centres it, so it fades in place while the
                 sidebar narrows instead of sliding with the cell's centre. -->
            <div
              data-header="mark"
              class="col-start-1 row-start-1 ms-[calc((var(--sidebar-width-icon)-(--spacing(4))-(--spacing(7)))/2)] flex h-10 items-center justify-self-start transition-opacity duration-200 ease-linear motion-reduce:transition-none"
              [class.opacity-0]="!iconOnly"
              [class.pointer-events-none]="!iconOnly"
              [attr.inert]="iconOnly ? null : ''"
            >
              <!-- The mark doubles as the way back: it crossfades into the expand icon on hover
                   (a pointer that can hover: Tailwind's hover variant) and keyboard focus. -->
              <button
                type="button"
                class="group/mark text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring grid size-7 place-items-center rounded-lg outline-none focus-visible:ring-2"
                [attr.aria-label]="'editor.shell.expandSidebar' | transloco"
                [zTooltip]="expandTip"
                zPosition="right"
                (click)="
                  state.toggle();
                  focusAfterToggle($event, '[data-header=full] button')
                "
              >
                <span
                  data-mark="logo"
                  class="col-start-1 row-start-1 flex transition-opacity duration-150 ease-out group-hover/mark:opacity-0 group-focus-visible/mark:opacity-0 motion-reduce:transition-none"
                >
                  <of-logo
                    variant="small"
                    [productName]="brand().productName"
                    [small]="brand().logo.small"
                    [smallDark]="brand().logo.smallDark"
                  />
                </span>
                <span
                  data-mark="icon"
                  class="col-start-1 row-start-1 flex scale-90 opacity-0 transition-[opacity,scale] duration-150 ease-out group-hover/mark:scale-100 group-hover/mark:opacity-100 group-focus-visible/mark:scale-100 group-focus-visible/mark:opacity-100 motion-reduce:transition-none"
                  aria-hidden="true"
                >
                  <ng-icon
                    name="lucidePanelLeftOpen"
                    size="18"
                    strokeWidth="1.5"
                  />
                </span>
              </button>
            </div>
          }
        </z-sidebar-header>

        <z-sidebar-content>
          <of-search-trigger [class]="iconOnly ? 'px-2 pt-1' : 'px-3 pt-1'" />
          <nav
            [attr.aria-label]="'editor.shell.mainNav' | transloco"
            z-sidebar-group
            [class]="iconOnly ? 'px-2 pt-1 pb-3' : 'px-3 pt-1 pb-3'"
          >
            @if (!known()) {
              <!-- Who is acting decides the sections: placeholders until /me names them. -->
              <ul
                z-sidebar-menu
                role="status"
                aria-busy="true"
                data-state="loading"
              >
                <li class="sr-only">{{ 'ui.states.loading' | transloco }}</li>
                @for (row of navPlaceholders; track row) {
                  <li z-sidebar-menu-item aria-hidden="true">
                    <z-sidebar-menu-skeleton
                      zShowIcon
                      [class]="
                        iconOnly
                          ? 'size-10 justify-center [&>*:last-child]:hidden'
                          : 'h-10'
                      "
                    />
                  </li>
                }
              </ul>
            }
            <ul z-sidebar-menu [hidden]="!known()">
              @for (item of items(); track item.path) {
                <li z-sidebar-menu-item>
                  <a
                    z-sidebar-menu-button
                    #link="routerLinkActive"
                    [routerLink]="'/' + item.path"
                    [queryParams]="csLink.paramsFor(item.path)"
                    [routerLinkActiveOptions]="activeOptions"
                    routerLinkActive
                    ariaCurrentWhenActive="page"
                    [zActive]="link.isActive"
                    [zTooltip]="item.label | transloco"
                    [attr.data-tip]="'nav.' + item.path"
                    (click)="provider.sidebarService.setOpenMobile(false)"
                    class="group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>span]:sr-only [&_svg]:size-5"
                  >
                    <ng-icon
                      [name]="item.icon"
                      class="size-5"
                      size="20"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    />
                    <span>{{ item.label | transloco }}</span>
                  </a>
                </li>
              }
            </ul>
          </nav>
        </z-sidebar-content>

        <z-sidebar-footer
          [class]="
            iconOnly ? 'items-center gap-0 px-2 pb-2' : 'gap-0 px-3 pb-3'
          "
        >
          @if (!iconOnly) {
            <z-separator
              class="bg-sidebar-border mx-1 mb-2 data-[orientation=horizontal]:w-auto"
            />
          }
          @if (known()) {
            <of-account-menu
              [name]="me().name"
              [role]="me().role"
              [collapsed]="iconOnly"
            >
              <!-- How notifications reach the person (issue 884): a person's own, never the token's. -->
              @if (me().kind === 'user') {
                <of-notifications-menu-item />
              }
              <!-- Help for the screen on show and the keyboard shortcuts (issue 221). -->
              <of-help-menu-items />
              <!-- The source code and the licence (AGPL-3.0 section 13); above the demo's
                   user list, which can be long, so they never sit below the fold. -->
              <of-about-menu-items />
              <!-- Only when the API is in demo mode; otherwise there is no trace of it. -->
              @if (demo.enabled()) {
                <of-demo-user-switch />
              }
              <!-- Only for a signed-in session (#37): never in demo mode or for the token. -->
              @if (me().session; as session) {
                <!-- Only for a session begun with a password (issue 610). -->
                @if (session.provider === 'password') {
                  <of-change-password-menu-item />
                }
                <!-- Only for a session begun here (issue 611): single sign-on has its own. -->
                @if (
                  session.provider === 'password' ||
                  session.provider === 'email-code'
                ) {
                  <of-second-factor-menu-item />
                }
                <of-sign-out-menu-item />
              }
            </of-account-menu>
          } @else {
            <div
              [class]="
                iconOnly
                  ? 'flex size-10 items-center justify-center'
                  : 'flex h-8 w-full items-center gap-2 px-2'
              "
              ofFadeIn="delayed"
              role="status"
              aria-busy="true"
              data-state="loading"
            >
              <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
              <z-skeleton
                [class]="
                  iconOnly
                    ? 'size-7 shrink-0 rounded-full'
                    : 'size-5 shrink-0 rounded-full'
                "
              />
              @if (!iconOnly) {
                <z-skeleton class="h-3 flex-1" />
              }
            </div>
          }
        </z-sidebar-footer>
      </z-sidebar>

      <main
        z-sidebar-inset
        cdkScrollable
        class="min-w-0 overflow-y-auto p-4 md:pt-6 md:pr-6 md:pb-6 md:pl-2 md:peer-data-[state=collapsed]:pt-5 md:peer-data-[state=collapsed]:pr-5 md:peer-data-[state=collapsed]:pl-1"
        tabindex="-1"
      >
        <!-- A public sandbox's banner (issue 826): the page column's first line, nothing otherwise. -->
        <!-- A centred tour step keeps clear of it (data-tip-keep-clear, issue 868). -->
        @if (sandbox.on()) {
          <of-sandbox-banner
            class="mb-3"
            [measure]="true"
            data-tip-keep-clear
          />
        }
        @if (provider.sidebarService.isMobile()) {
          <!-- A tour step about the sidebar points here while it is closed (issue 868). -->
          <button
            z-sidebar-trigger
            data-tip="shell.menu"
            class="text-muted-foreground mb-2 size-8"
            [attr.aria-label]="'editor.shell.openSidebar' | transloco"
          ></button>
        }
        <div
          class="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
        >
          <z-breadcrumb
            zSize="sm"
            zSeparator="/"
            [zLabel]="'ui.breadcrumb.label' | transloco"
            class="text-muted-foreground text-xs/5 [&_ol]:gap-1 sm:[&_ol]:gap-1"
          >
            @for (crumb of crumbs(); track $index) {
              <z-breadcrumb-item>
                @if (crumb.current) {
                  <span z-breadcrumb-page class="text-muted-foreground">{{
                    crumb.literal ? crumb.label : (crumb.label | transloco)
                  }}</span>
                } @else {
                  <a
                    z-breadcrumb-link
                    [routerLink]="crumb.link"
                    [queryParams]="csLink.paramsFor(crumb.link)"
                    class="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
                    >{{
                      crumb.literal ? crumb.label : (crumb.label | transloco)
                    }}</a
                  >
                }
              </z-breadcrumb-item>
            }
          </z-breadcrumb>
          <div class="flex min-w-0 items-center gap-1">
            <!-- A contributor has no picker: each suggestion makes its own change set (issue 137). -->
            @if (!suggestsOnly()) {
              <of-change-set-control />
            }
            @if (known()) {
              <of-notification-bell
                [open]="notifications.visible()"
                (pressed)="notifications.toggle()"
              />
            }
          </div>
        </div>
        @if (presence() === 'failed') {
          <of-error-state
            [kind]="meFailure()?.kind ?? 'unknown'"
            (retry)="retry()"
          />
        } @else if (branchMissing()) {
          <!-- The chosen change set's branch is gone: said once here, not as each screen's load error. -->
          <of-change-set-branch-missing />
        } @else {
          @if (rewrittenNotice(); as chosen) {
            <!-- Its base was rewritten: said up front, with the way out. -->
            <div class="pb-4">
              <of-change-set-base-rewritten
                [changeSetId]="chosen.id"
                [title]="chosen.title"
                [state]="chosen.state"
                [authorId]="chosen.authorId"
              />
            </div>
          }
          <router-outlet ofRouteFade />
        }
      </main>
      <of-change-password-dialog />
      <of-second-factor-dialog />
      <of-toaster />
      <of-search-palette />
      <!-- The keyboard shortcuts, on ? or from the account menu (issue 221). -->
      <of-shortcuts-overlay />
      <!-- What an update from main left to resolve (#22). -->
      <of-change-set-conflicts />
      <!-- What carrying a fix forward to main left to do by hand. -->
      <of-carry-forward-conflicts />
      <of-notifications-sheet #notifications />
    </z-sidebar-provider>
  `,
})
export class ShellLayout {
  protected readonly state = inject(ShellState);
  protected readonly sandbox = inject(SandboxSession);
  protected readonly brand = inject(BrandingService).branding;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly signIn = inject(SignInSession);
  private readonly permissions = inject(PermissionService);
  private readonly meService = inject(MeService);
  /** Constructed with the shell: it offers the tips and the tour (#222). */
  private readonly tips = inject(TipsController);
  /** Keeps the email's language and time zone to the person's (#884). */
  private readonly notificationSettings = inject(NotificationSettingsService);

  protected readonly demo = inject(DemoSession);
  /** App links keep the change set (`?cs=`). */
  protected readonly csLink = inject(ChangeSetUrl);
  /** A section is active whatever its query (`?cs=`, filters). */
  protected readonly activeOptions = {
    paths: 'subset',
    queryParams: 'ignored',
    matrixParams: 'ignored',
    fragment: 'ignored',
  } as const;
  protected readonly me = this.meService.me;
  protected readonly presence = this.meService.presence;
  protected readonly suggestsOnly = this.permissions.suggestsOnly;
  protected readonly meFailure = this.meService.error;
  /** The person is named: the nav and the account menu show them, never empty. */
  protected readonly known = computed(() => this.presence() === 'person');
  protected readonly navPlaceholders = NAV_PLACEHOLDERS;
  /** Only what the role can ever see; a hidden section is not rendered at all. */
  protected readonly items = computed(() =>
    NAV_ITEMS.filter((i) => this.permissions.state(i.rule).kind !== 'hidden'),
  );

  private readonly changeSets = inject(ChangeSetSession);
  /**
   * The active screen reads at the session's change set: its route says `cs` is the session's
   * (not the review screen's own), and none on the way says `changeSetFree` (screens that read
   * nothing at a change set: roles, users, service accounts, the not-found and no-access pages).
   */
  private readonly readsChangeSet = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => readsChangeSet(this.router.routerState.snapshot.root)),
    ),
    { initialValue: false },
  );
  /** The chosen change set, for its base-rewritten notice (#471), on a screen that reads at it. */
  protected readonly rewrittenNotice = computed(() => {
    const chosen = this.changeSets.selectedOption();
    if (!this.readsChangeSet() || !chosen || chosen.pending) return null;
    return chosen;
  });
  /** The chosen change set's branch is gone (#317), on a screen that reads at it. */
  protected readonly branchMissing = computed(
    () => this.readsChangeSet() && this.changeSets.branchMissing(),
  );

  /** The route the breadcrumb is made of, after each navigation. */
  private readonly routeRoot = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => this.router.routerState.snapshot.root),
    ),
    { initialValue: null },
  );
  /** The breadcrumb, under the product's name (which the branding may change at any time). */
  protected readonly crumbs = computed(() => {
    const root = this.routeRoot();
    return root ? breadcrumbsOf(root, this.brand().productName) : [];
  });

  constructor() {
    // Nobody acting any more (a refused identity, the token's service): the sign-in page.
    effect(() => {
      if (this.presence() !== 'nobody') return;
      untracked(() => {
        this.signIn.ended.set(true);
        void this.router.navigateByUrl(
          signInTree(this.router, this.router.url),
        );
      });
    });
    // The route default only matters until the person has chosen (ShellState); it is still
    // set per section, so it applies as soon as a stored choice is absent.
    let section: string | undefined;
    const apply = () => {
      const root = this.router.routerState.snapshot.root;
      const key = root.firstChild?.firstChild?.url[0]?.path ?? '';
      if (key === section) return;
      section = key;
      const mode = sidebarModeOf(root);
      if (mode) this.state.setDefault(mode);
    };
    apply();
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(apply);
  }

  /**
   * The retry of a failed `GET /me`: asks again (whether this is demo mode too, when that could
   * not be asked), then matches the address again, so the sections see the person.
   */
  protected async retry(): Promise<void> {
    if (this.demo.status() === 'failed') await this.demo.probe();
    await this.demo.reload();
    if (this.presence() === 'person') {
      await this.router.navigateByUrl(this.router.url, {
        onSameUrlNavigation: 'reload',
      });
    }
  }

  /**
   * Toggling from the keyboard (a click without a pointer: `detail` 0) hides the control that
   * was pressed, as the header's other state becomes the visible one: focus moves to that
   * state's control once it is no longer inert, instead of falling back to the page.
   */
  protected focusAfterToggle(event: MouseEvent, selector: string): void {
    if (event.detail !== 0) return;
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
