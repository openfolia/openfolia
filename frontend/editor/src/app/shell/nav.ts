import type { PermissionRule } from '../permissions/permissions';

/** Labels and titles here are translation keys, translated where they show. */
export interface NavItem {
  readonly label: string;
  /** Route path, relative to the root. */
  readonly path: string;
  /** ng-icons name, registered in the shell. */
  readonly icon: string;
  readonly rule: PermissionRule;
}

/** The sections of the sidebar, in order. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: 'editor.nav.content',
    path: 'content',
    icon: 'lucideFile',
    rule: { permission: 'content.read' },
  },
  {
    label: 'editor.nav.manuals',
    path: 'manuals',
    icon: 'lucideBook',
    rule: { permission: 'content.read' },
  },
  {
    label: 'editor.nav.review',
    path: 'review',
    icon: 'lucideCircleCheck',
    // Authors submit their change sets here too, and reviewers and publishers read drafts.
    rule: { permission: 'content.read.draft' },
  },
  {
    label: 'editor.nav.translations',
    path: 'translations',
    icon: 'lucideGlobe',
    rule: { permission: 'translation.manage' },
  },
  {
    label: 'editor.nav.releases',
    path: 'releases',
    icon: 'lucidePackage',
    // Releases are released content: every reader sees them; publishing needs `release.publish`.
    rule: { permission: 'content.read' },
  },
  {
    // Translation coverage and module usage (#56), for leads.
    label: 'editor.nav.reports',
    path: 'reports',
    icon: 'lucideChartColumn',
    rule: { permission: 'content.read.draft' },
  },
  {
    label: 'editor.nav.media',
    path: 'media',
    icon: 'lucideImage',
    rule: { permission: 'content.edit' },
  },
  {
    // The terms (#246): every reader reads them; editing them needs `content.edit`.
    label: 'editor.nav.terminology',
    path: 'terminology',
    icon: 'lucideBookA',
    rule: { permission: 'content.read' },
  },
  {
    label: 'editor.nav.admin',
    path: 'admin',
    icon: 'lucideShield',
    // Its pages need `admin.roles`, but Webhooks only `webhook.manage` (#254), Branding only
    // `admin.branding` (#169), Backups only `admin.backups` (#529) and Page design only
    // `content.read.draft` (#392).
    rule: {
      permission: 'admin.roles',
      anyOf: [
        'webhook.manage',
        'admin.branding',
        'admin.backups',
        'content.read.draft',
      ],
    },
  },
];

/**
 * The groups of the admin rail, in order (#591). A heading is a label, not a menu: every page of
 * every group is one click away. The audit sink's status (#379) will join `integrations`, once a
 * page shows it.
 */
export const ADMIN_GROUPS = [
  'people',
  'content',
  'look',
  'integrations',
  'operations',
] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

/** Each group's heading (a translation key). */
export const ADMIN_GROUP_TITLES: Readonly<Record<AdminGroup, string>> = {
  people: 'editor.admin.groups.people',
  content: 'editor.admin.groups.content',
  look: 'editor.admin.groups.look',
  integrations: 'editor.admin.groups.integrations',
  operations: 'editor.admin.groups.operations',
};

export interface AdminTab {
  /** The page's name in the rail, the phone-width select and the palette. */
  readonly label: string;
  readonly path: string;
  /** The rail's group the page is listed under. */
  readonly group: AdminGroup;
  /** The page title above the page while it is open. */
  readonly title: string;
  /** The page's primary action in the page header, and the permission it needs. */
  readonly action?: { readonly label: string; readonly rule: PermissionRule };
  /** Who sees the page and may open it; `ADMIN_RULE` when left out. */
  readonly rule?: PermissionRule;
  /** The page's page of the user guide, by article ID (#221); none while the page is not built. */
  readonly help?: string;
}

/** What an admin page needs unless it says otherwise. */
export const ADMIN_RULE: PermissionRule = { permission: 'admin.roles' };

/** What `tab` needs to be shown and opened. */
export const tabRule = (tab: AdminTab): PermissionRule =>
  tab.rule ?? ADMIN_RULE;

/** One group of the rail with the pages left in it. */
export interface AdminTabGroup {
  readonly group: AdminGroup;
  readonly title: string;
  readonly tabs: readonly AdminTab[];
}

/** `tabs` (in `ADMIN_TABS` order) under their groups, in rail order; a group left empty is left out. */
export function groupTabs(tabs: readonly AdminTab[]): readonly AdminTabGroup[] {
  return ADMIN_GROUPS.map((group) => ({
    group,
    title: ADMIN_GROUP_TITLES[group],
    tabs: tabs.filter((tab) => tab.group === group),
  })).filter((g) => g.tabs.length > 0);
}

/**
 * The admin pages, in rail order (#591): each names its group. Roles and Users are built (#39),
 * Group mappings (#592), Service accounts (#289), Project settings (#259), Variants (#91),
 * Webhooks (#254), System (#404) and the Audit log (#269) too. Every page needs `admin.roles` but Webhooks, which
 * `webhook.manage` opens, Branding (#169), which `admin.branding` opens, Backups (#529), which
 * `admin.backups` opens, and Page design (#392), which reading drafts opens. `/admin` opens the
 * first page the role may open.
 */
export const ADMIN_TABS: readonly AdminTab[] = [
  {
    label: 'editor.admin.tabs.users',
    path: 'users',
    help: 'guide.admin.users-and-roles',
    group: 'people',
    title: 'editor.admin.titles.users',
    action: {
      label: 'editor.admin.actions.newUser',
      rule: { permission: 'admin.roles' },
    },
  },
  {
    label: 'editor.admin.tabs.roles',
    path: 'roles',
    help: 'guide.admin.users-and-roles',
    group: 'people',
    title: 'editor.admin.titles.roles',
    action: {
      label: 'editor.admin.actions.newRole',
      rule: { permission: 'admin.roles' },
    },
  },
  {
    // Which identity-provider group's members hold which role (#592), as `/group-mappings`.
    label: 'editor.admin.tabs.groupMappings',
    path: 'group-mappings',
    help: 'guide.admin.group-mappings',
    group: 'people',
    title: 'editor.admin.titles.groupMappings',
    action: {
      label: 'editor.admin.actions.addMapping',
      rule: { permission: 'admin.roles' },
    },
  },
  {
    label: 'editor.admin.tabs.serviceAccounts',
    path: 'service-accounts',
    help: 'guide.admin.service-accounts',
    group: 'people',
    title: 'editor.admin.titles.serviceAccounts',
    action: {
      label: 'editor.admin.actions.newServiceAccount',
      rule: { permission: 'admin.roles' },
    },
  },
  {
    label: 'editor.admin.tabs.settings',
    path: 'settings',
    help: 'guide.admin.project-settings',
    group: 'content',
    title: 'editor.admin.titles.settings',
  },
  {
    label: 'editor.admin.tabs.variants',
    path: 'variants',
    help: 'guide.admin.variants',
    group: 'content',
    title: 'editor.admin.titles.variants',
    action: {
      label: 'editor.admin.actions.newValue',
      rule: { permission: 'admin.roles' },
    },
  },
  {
    // The PDF's page designs (#392): everyone who reads drafts sees them; changing one is a
    // change in a change set (`content.edit`), the project's default a setting.
    label: 'editor.admin.tabs.pageDesigns',
    path: 'page-designs',
    help: 'guide.releases.page-designs',
    group: 'content',
    title: 'editor.admin.titles.pageDesigns',
    rule: { permission: 'content.read.draft' },
    action: {
      label: 'editor.admin.actions.newDesign',
      rule: { permission: 'content.edit' },
    },
  },
  {
    // Content brought in from elsewhere (#93): importer, file, options, dry run, import.
    label: 'editor.admin.tabs.import',
    path: 'import',
    help: 'guide.admin.import',
    group: 'content',
    title: 'editor.admin.titles.import',
  },
  {
    // The product name, logos, icons and colours (#169); `admin.branding`, as `PATCH /branding`.
    label: 'editor.admin.tabs.branding',
    path: 'branding',
    help: 'guide.admin.branding',
    group: 'look',
    title: 'editor.admin.titles.branding',
    rule: { permission: 'admin.branding' },
  },
  {
    label: 'editor.admin.tabs.webhooks',
    path: 'webhooks',
    help: 'guide.admin.webhooks',
    group: 'integrations',
    title: 'editor.admin.titles.webhooks',
    rule: { permission: 'webhook.manage' },
    action: {
      label: 'editor.admin.actions.addSubscriber',
      rule: { permission: 'webhook.manage' },
    },
  },
  {
    // The instance and the storage it uses (#404); `admin.roles`, as `GET /storage-usage`.
    label: 'editor.admin.tabs.system',
    path: 'system',
    help: 'guide.admin.system',
    group: 'operations',
    title: 'editor.admin.titles.system',
  },
  {
    // Scheduled, encrypted, verified backups (#529); `admin.backups`, as every `/backup-*` route.
    label: 'editor.admin.tabs.backups',
    path: 'backups',
    help: 'guide.admin.backups',
    group: 'operations',
    title: 'editor.admin.titles.backups',
    rule: { permission: 'admin.backups' },
  },
  {
    // Reading the log needs `admin.roles`, as the whole Admin section does.
    label: 'editor.admin.tabs.audit',
    path: 'audit',
    help: 'guide.admin.audit-log',
    group: 'operations',
    title: 'editor.admin.titles.audit',
  },
];
