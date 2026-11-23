import { inject } from '@angular/core';
import {
  Router,
  type CanMatchFn,
  type Route,
  type Routes,
  type UrlSegment,
} from '@angular/router';

import type { NoAccessData } from './pages/no-access.page';
import {
  ManualPermissions,
  PermissionService,
} from './permissions/permission.service';
import type { PermissionRule } from './permissions/permissions';
import type { ChangeSetParamMode } from './session/change-set-url';

import { REPORT_TABS } from './reports/report-tabs';
import { ADMIN_TABS, NAV_ITEMS, tabRule } from './shell/nav';
import {
  nobodyActing,
  personActing,
  SIGN_IN_PATH,
} from './sign-in/sign-in.guards';

/** The sign-in pages' page of the user guide (#221). */
const SIGN_IN_HELP = 'guide.getting-started.sign-in';

/** Set by Angular's build: `false` in a production build, which then drops what it guards. */
declare const ngDevMode: unknown;

/**
 * The component showcase, a development aid. Guarded by `ngDevMode` rather than `isDevMode()`:
 * it renders every component of the library, which a production build then leaves out (#494).
 */
const showcaseRoutes: Routes =
  typeof ngDevMode === 'undefined' || ngDevMode
    ? [
        {
          path: 'showcase',
          title: 'editor.titles.showcase',
          loadComponent: () =>
            import('@openfolia/ui/showcase').then((m) => m.ShowcasePage),
        },
      ]
    : [];

/**
 * The block editor playground, a development aid. Guarded by `ngDevMode` rather than
 * `isDevMode()`, so a production build leaves out the route and its chunk (TipTap with it).
 */
const playgroundRoutes: Routes =
  typeof ngDevMode === 'undefined' || ngDevMode
    ? [
        {
          path: 'doc-editor',
          title: 'editor.docEditor.page.title',
          loadComponent: () =>
            import('./doc-editor/doc-editor.page').then((m) => m.DocEditorPage),
        },
      ]
    : [];

/** A route the role can never use does not match; `guarded` puts the no-access page after it. */
const allowed =
  (rule: PermissionRule): CanMatchFn =>
  () =>
    inject(PermissionService).state(rule).kind !== 'hidden';

/** The role can never use it: the address shows the no-access page instead (`guarded`). */
const denied =
  (rule: PermissionRule): CanMatchFn =>
  () =>
    inject(PermissionService).state(rule).kind === 'hidden';

const noAccess = () =>
  import('./pages/no-access.page').then((m) => m.NoAccessPage);

/**
 * A guarded section: its routes for a role that may use it, and for any other role the
 * no-access page at every address under it (a deep link into a tab too). The address stays, and
 * the page names the permission the section needs; an unknown address under a section the role
 * may use is still "Page not found" (the catch-all).
 */
function guarded(
  route: Route & { readonly path: string },
  rule: PermissionRule,
  section: string,
): Route[] {
  const noAccessData: NoAccessData = { section, permission: rule.permission };
  // The section's own data (`changeSetParam`) holds, but not its sidebar default: the page is
  // no work screen, so the sidebar stays as it is.
  const data = { ...route.data };
  delete data['sidebar'];
  return [
    { ...route, canMatch: [allowed(rule)] },
    {
      matcher: (segments: UrlSegment[]) =>
        segments[0]?.path === route.path ? { consumed: segments } : null,
      canMatch: [denied(rule)],
      title: 'editor.noAccess.title',
      // No work screen: shown even while the chosen change set's branch is gone.
      data: {
        ...data,
        breadcrumb: section,
        noAccess: noAccessData,
        changeSetFree: true,
        // Which role holds which permission: the page names the one it needs.
        help: 'guide.reference.roles',
      },
      loadComponent: noAccess,
    },
  ];
}

/**
 * Admin tabs that read nothing at the chosen change set (`data.changeSetFree`): the shell shows
 * them as they are while its branch is gone, not the message about it (#317).
 */
const CHANGE_SET_FREE_TABS: ReadonlySet<string> = new Set([
  'roles',
  'users',
  'group-mappings',
  'service-accounts',
  'webhooks',
  'branding',
  'backups',
  'system',
  'audit',
  // Imports check against the default branch, never the chosen change set's.
  'import',
]);

const placeholder = () =>
  import('./pages/placeholder.page').then((m) => m.PlaceholderPage);

/** The admin tabs built so far; the others are the placeholder. */
const ADMIN_SCREENS: Readonly<Record<string, Route['loadComponent']>> = {
  roles: () => import('./admin/roles.page').then((m) => m.RolesPage),
  users: () => import('./admin/users.page').then((m) => m.UsersPage),
  'group-mappings': () =>
    import('./admin/group-mappings/group-mappings.page').then(
      (m) => m.GroupMappingsPage,
    ),
  'service-accounts': () =>
    import('./admin/service-accounts.page').then((m) => m.ServiceAccountsPage),
  settings: () =>
    import('./admin/settings/project-settings.page').then(
      (m) => m.ProjectSettingsPage,
    ),
  variants: () =>
    import('./admin/variants/variants.page').then((m) => m.VariantsPage),
  webhooks: () =>
    import('./admin/webhooks/webhooks.page').then((m) => m.WebhooksPage),
  branding: () =>
    import('./admin/branding/branding.page').then((m) => m.BrandingPage),
  backups: () =>
    import('./admin/backups/backups.page').then((m) => m.BackupsPage),
  'page-designs': () =>
    import('./admin/page-designs/page-designs.page').then(
      (m) => m.PageDesignsPage,
    ),
  system: () => import('./admin/system/system.page').then((m) => m.SystemPage),
  audit: () =>
    import('./admin/audit/audit-log.page').then((m) => m.AuditLogPage),
  import: () => import('./admin/import/import.page').then((m) => m.ImportPage),
};

/**
 * Route titles and breadcrumbs are translation keys: `TranslatedTitleStrategy` and the shell
 * translate them, and follow a language switch.
 *
 * Each screen names its page of the user guide by article ID (`data.help`, #221): the page
 * header's help link and the account menu open it (`HelpService`), and `screen-help.spec.ts`
 * fails for a screen without one, or one the guide does not have.
 *
 * One route per sidebar section. The content browser opens with the sidebar expanded; every
 * other screen is a work screen and starts collapsed (`data.sidebar`). `data.breadcrumb` feeds
 * the breadcrumb.
 */
const sectionRoutes: Routes = NAV_ITEMS.flatMap((item): Route[] => {
  const section = (route: Route & { readonly path: string }) =>
    guarded(route, item.rule, item.label);
  const data = {
    breadcrumb: item.label,
    sidebar: item.path === 'content' ? 'expanded' : 'collapsed',
  };
  if (item.path === 'admin') {
    // A tab the role cannot open shows the no-access page, naming its permission.
    const adminTab = (
      tab: (typeof ADMIN_TABS)[number],
    ): Route & { readonly path: string } => ({
      path: tab.path,
      title: tab.title,
      // The document title reads "<tab> - Admin" (TranslatedTitleStrategy). A tab that reads
      // nothing at the change set stays usable while its branch is gone (#317).
      data: {
        nested: true,
        titleParent: item.label,
        ...(tab.help && { help: tab.help }),
        ...((CHANGE_SET_FREE_TABS.has(tab.path) ||
          ADMIN_SCREENS[tab.path] === undefined) && {
          changeSetFree: true,
        }),
      },
      // A screen with unsaved changes (a role) asks before it is left.
      canDeactivate: [
        (page: { leave?: () => Promise<boolean> }) =>
          page.leave ? page.leave() : true,
      ],
      loadComponent: ADMIN_SCREENS[tab.path] ?? placeholder,
      // Project settings: one page per topic (#318).
      ...(tab.path === 'settings' && {
        loadChildren: () =>
          import('./admin/settings/settings.routes').then(
            (m) => m.SETTINGS_ROUTES,
          ),
      }),
    });
    return section({
      path: item.path,
      title: item.label,
      data,
      loadComponent: () =>
        import('./pages/admin.page').then((m) => m.AdminPage),
      children: [
        {
          path: '',
          pathMatch: 'full',
          // The first tab the role may open (Webhooks alone for a webhook manager, #254).
          redirectTo: () => {
            const permissions = inject(PermissionService);
            return (
              ADMIN_TABS.find(
                (tab) => permissions.state(tabRule(tab)).kind !== 'hidden',
              )?.path ??
              ADMIN_TABS[0]?.path ??
              'roles'
            );
          },
        },
        ...ADMIN_TABS.flatMap((tab): Route[] => [
          // One page design's editor (#392), and one own template's files (#396), under its
          // tab: the tab's rule and title hold.
          ...(tab.path === 'page-designs'
            ? [
                {
                  ...adminTab(tab),
                  path: 'page-designs/templates/:templateId',
                  data: {
                    ...adminTab(tab).data,
                    help: 'guide.releases.page-design-templates',
                  },
                  canMatch: [allowed(tabRule(tab))],
                  loadComponent: () =>
                    import('./admin/page-designs/template-editor.page').then(
                      (m) => m.TemplateEditorPage,
                    ),
                },
                {
                  ...adminTab(tab),
                  path: 'page-designs/:designId',
                  canMatch: [allowed(tabRule(tab))],
                  loadComponent: () =>
                    import('./admin/page-designs/page-design-editor.page').then(
                      (m) => m.PageDesignEditorPage,
                    ),
                },
              ]
            : []),
          ...guarded(adminTab(tab), tabRule(tab), tab.title),
        ]),
      ],
    });
  }
  if (item.path === 'content') {
    return section({
      path: item.path,
      data,
      children: [
        {
          path: '',
          pathMatch: 'full',
          title: item.label,
          data: { help: 'guide.writing.content-browser' },
          loadComponent: () =>
            import('./content/content-browser.page').then(
              (m) => m.ContentBrowserPage,
            ),
        },
        {
          // A module's history (screen 13): its versions, compared, and restored as a draft.
          path: ':lang/:moduleId/history',
          title: 'editor.history.title',
          data: {
            breadcrumb: 'editor.history.title',
            sidebar: 'collapsed',
            help: 'guide.writing.history',
          },
          loadComponent: () =>
            import('./history/history.page').then((m) => m.HistoryPage),
        },
        {
          // The module editor (screen 2): leaving it makes a save point first.
          path: ':lang/:moduleId',
          title: 'editor.content.module.title',
          data: {
            breadcrumb: 'editor.content.module.title',
            sidebar: 'collapsed',
            help: 'guide.writing.edit-a-module',
          },
          canDeactivate: [
            (page: { leave?: () => Promise<boolean> }) =>
              page.leave ? page.leave() : true,
          ],
          loadComponent: () =>
            import('./module-editor/module-editor.page').then(
              (m) => m.ModuleEditorPage,
            ),
        },
      ],
    });
  }
  if (item.path === 'manuals') {
    return section({
      path: item.path,
      data,
      // A contributor reads manuals here, never builds them (#137).
      providers: [{ provide: PermissionService, useClass: ManualPermissions }],
      children: [
        {
          // The manual builder (screen 3): the manual, row, language, variant and change set
          // are query parameters. Leaving it makes a save point first.
          path: '',
          pathMatch: 'full',
          title: item.label,
          data: { help: 'guide.manuals.build' },
          canDeactivate: [
            (page: { leave?: () => Promise<boolean> }) =>
              page.leave ? page.leave() : true,
          ],
          loadComponent: () =>
            import('./manuals/manual-builder.page').then(
              (m) => m.ManualBuilderPage,
            ),
        },
        {
          // A manual's history (#321): its versions, compared, and restored as a draft.
          path: ':manualId/history',
          title: 'editor.history.title',
          data: {
            breadcrumb: 'editor.history.title',
            sidebar: 'collapsed',
            help: 'guide.manuals.history',
          },
          loadComponent: () =>
            import('./history/history.page').then((m) => m.HistoryPage),
        },
        {
          // `/manuals/<id>` (the search palette's link) is the builder on that manual.
          path: ':manualId',
          redirectTo: ({ params, queryParams }) =>
            inject(Router).createUrlTree(['/manuals'], {
              queryParams: { ...queryParams, manual: params['manualId'] },
            }),
        },
      ],
    });
  }
  if (item.path === 'review') {
    return section({
      path: item.path,
      title: item.label,
      // `?cs=` here is the change set under review, the page's own choice (`ChangeSetUrl`).
      data: {
        ...data,
        changeSetParam: 'own' satisfies ChangeSetParamMode,
        help: 'guide.review.list',
      },
      loadComponent: () =>
        import('./review/review.page').then((m) => m.ReviewPage),
    });
  }
  if (item.path === 'reports') {
    // Translation coverage and module usage (#56): a tab each, a route each; filters, sort and
    // page are query parameters.
    return section({
      path: item.path,
      title: item.label,
      data,
      loadComponent: () =>
        import('./reports/reports.page').then((m) => m.ReportsPage),
      children: [
        { path: '', pathMatch: 'full', redirectTo: REPORT_TABS[0].path },
        ...REPORT_TABS.map((tab): Route => ({
          path: tab.path,
          title: tab.label,
          data: { nested: true, titleParent: item.label, help: tab.help },
          loadComponent: tab.load,
        })),
      ],
    });
  }
  if (item.path === 'translations') {
    // Screen 5 (#87): the Status tab (`/translations`, its filters, page, chosen cell and rows
    // in the address) and the Jobs tab (`/translations/jobs`). Screen 17 (#244): importing a
    // translation (`/translations/import`), a page of its own under Translations.
    return section({
      path: item.path,
      data,
      children: [
        {
          path: 'import',
          title: 'editor.translations.importScreen.title',
          data: {
            breadcrumb: 'editor.translations.importScreen.title',
            help: 'guide.translations.import',
          },
          // Leaving with a validation not imported yet asks first.
          canDeactivate: [
            (page: { leave?: () => Promise<boolean> }) =>
              page.leave ? page.leave() : true,
          ],
          loadComponent: () =>
            import('./translations/translation-import.page').then(
              (m) => m.TranslationImportPage,
            ),
        },
        {
          path: '',
          title: item.label,
          loadComponent: () =>
            import('./translations/translations.page').then(
              (m) => m.TranslationsPage,
            ),
          children: [
            {
              path: '',
              pathMatch: 'full',
              title: 'editor.translations.tabs.status',
              data: {
                nested: true,
                titleParent: item.label,
                help: 'guide.translations.status',
              },
              loadComponent: () =>
                import('./translations/translation-status.page').then(
                  (m) => m.TranslationStatusPage,
                ),
            },
            {
              path: 'jobs',
              title: 'editor.translations.tabs.jobs',
              data: {
                nested: true,
                titleParent: item.label,
                help: 'guide.translations.export',
              },
              loadComponent: () =>
                import('./translations/translation-jobs.page').then(
                  (m) => m.TranslationJobsPage,
                ),
            },
          ],
        },
      ],
    });
  }
  if (item.path === 'releases') {
    // Screens 15 and 16: the list (filters, page, chosen release and the open dialog in the
    // address), the download centre (#139) and a release's page. None reads at the chosen
    // revision.
    return section({
      path: item.path,
      data: { ...data, changeSetFree: true },
      children: [
        {
          path: '',
          pathMatch: 'full',
          title: item.label,
          data: { help: 'guide.releases.overview' },
          loadComponent: () =>
            import('./releases/releases.page').then((m) => m.ReleasesPage),
        },
        {
          // The download centre (#139): before `:releaseId`, which it would read as one.
          path: 'downloads',
          title: 'editor.releases.downloads.title',
          data: {
            breadcrumb: 'editor.releases.downloads.title',
            help: 'guide.releases.downloads',
          },
          loadComponent: () =>
            import('./releases/downloads.page').then((m) => m.DownloadsPage),
        },
        {
          path: ':releaseId',
          title: 'editor.releases.detail.title',
          data: {
            breadcrumb: 'editor.releases.detail.title',
            help: 'guide.releases.overview',
          },
          loadComponent: () =>
            import('./releases/release-detail.page').then(
              (m) => m.ReleaseDetailPage,
            ),
        },
      ],
    });
  }
  if (item.path === 'media') {
    // Screen 23: the view, filters, page and open file are query parameters.
    return section({
      path: item.path,
      title: 'editor.media.title',
      data: { ...data, help: 'guide.media.library' },
      loadComponent: () =>
        import('./media/media-library.page').then((m) => m.MediaLibraryPage),
    });
  }
  if (item.path === 'terminology') {
    // #246: the filters, page and open term are query parameters. Leaving it makes the open
    // term's save point first.
    return section({
      path: item.path,
      title: 'editor.terminology.title',
      data: { ...data, help: 'guide.writing.terminology' },
      canDeactivate: [
        (page: { leave?: () => Promise<boolean> }) =>
          page.leave ? page.leave() : true,
      ],
      loadComponent: () =>
        import('./terminology/terminology.page').then((m) => m.TerminologyPage),
    });
  }
  // Not built yet: reads nothing at a change set (#317).
  return section({
    path: item.path,
    title: item.label,
    data: { ...data, changeSetFree: true },
    loadComponent: placeholder,
  });
});

export const routes: Routes = [
  // Outside the shell: the design reference screens.
  {
    path: 'theme',
    title: 'editor.theme.title',
    loadComponent: () =>
      import('./pages/theme/theme.page').then((m) => m.ThemePage),
  },
  ...showcaseRoutes,
  ...playgroundRoutes,
  {
    // "Forgot password" (#610), before signing in.
    path: 'forgot-password',
    data: { help: SIGN_IN_HELP },
    title: 'editor.signIn.forgot.title',
    canMatch: [nobodyActing],
    loadComponent: () =>
      import('./sign-in/forgot-password.page').then(
        (m) => m.ForgotPasswordPage,
      ),
  },
  {
    // "Email me a code" (#634), and the page a code's email link opens, before signing in.
    path: 'sign-in-code',
    data: { help: SIGN_IN_HELP },
    title: 'editor.signIn.emailCode.title',
    canMatch: [nobodyActing],
    loadComponent: () =>
      import('./sign-in/email-code.page').then((m) => m.EmailCodePage),
  },
  {
    // The page an invite or reset link opens (#610): signed in or not, the link decides.
    path: 'set-password',
    data: { help: SIGN_IN_HELP },
    title: 'editor.signIn.setPassword.resetTitle',
    loadComponent: () =>
      import('./sign-in/set-password.page').then((m) => m.SetPasswordPage),
  },
  {
    // Where nobody acting is sent (`personActing`); a person acting goes on past it.
    path: SIGN_IN_PATH,
    data: { help: SIGN_IN_HELP },
    title: 'editor.signIn.title',
    canMatch: [nobodyActing],
    loadComponent: () =>
      import('./sign-in/sign-in.page').then((m) => m.SignInPage),
  },
  {
    path: '',
    // Only for a person: it waits for `GET /me`, and nobody acting goes to the sign-in page.
    canMatch: [personActing],
    // Every screen in the shell keeps the session's change set in `?cs=` (`ChangeSetUrl`).
    data: { changeSetParam: 'session' satisfies ChangeSetParamMode },
    loadComponent: () =>
      import('./shell/shell.layout').then((m) => m.ShellLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'content' },
      ...sectionRoutes,
      // Screen 14: the checks of a manual (`?manual=`) or of the chosen change set. Reached
      // from the review screen and the manual builder, not from the sidebar.
      ...guarded(
        {
          path: 'checks',
          title: 'editor.checks.title',
          data: {
            breadcrumb: 'editor.checks.breadcrumb',
            sidebar: 'collapsed',
            help: 'guide.checks.run-checks',
          },
          loadComponent: () =>
            import('./checks/checks.page').then((m) => m.ChecksPage),
        },
        { permission: 'content.read' },
        'editor.checks.breadcrumb',
      ),
      // Screen 11: a module (`?module=`) or manual (`?manual=`) as a reader sees it, per
      // language, variant and output. Reached from the module editor and the manual builder.
      ...guarded(
        {
          path: 'preview',
          title: 'editor.preview.title',
          data: {
            breadcrumb: 'editor.preview.breadcrumb',
            sidebar: 'collapsed',
            help: 'guide.writing.preview',
          },
          loadComponent: () =>
            import('./preview/preview.page').then((m) => m.PreviewPage),
        },
        { permission: 'content.read' },
        'editor.preview.breadcrumb',
      ),
      {
        // An address no screen has: "Page not found" (not "No access", which `guarded` shows).
        path: '**',
        title: 'editor.notFound.title',
        data: {
          breadcrumb: 'editor.notFound.title',
          changeSetFree: true,
          help: 'guide.getting-started.find-your-way',
        },
        loadComponent: () =>
          import('./pages/not-found.page').then((m) => m.NotFoundPage),
      },
    ],
  },
];
