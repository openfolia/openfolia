import type { Item, Schema } from '../api';
import { moduleIdOf } from '../content/module-id';
import { ALL_PERMISSIONS, type ApiPermission } from '../permissions/me';

export type RoleItem = Item<'/roles'>;
export type UserItem = Item<'/users'>;

/**
 * The roles given to the user directly: what the user dialog edits. Those held through the
 * identity provider's groups (#37, `meta.groupRoleIds`) follow the group mappings.
 */
export function directRoleIds(user: UserItem): string[] {
  const viaGroups = new Set<string>(user.meta?.groupRoleIds ?? []);
  return user.relationships.roles.data
    .map((r) => r.id)
    .filter((id) => !viaGroups.has(id));
}
export type RoleScope = Schema<'Scope'>;

/** A role's ID, as the API takes it: a lowercase key (`safety-approver`). */
export const ROLE_ID = /^[a-z][a-z0-9-]*$/;
/** A user's ID, as the API takes it (`jane.doe`, `sample-author`). */
export const USER_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
/** The longest role or user ID the API takes. */
export const ID_MAX = 64;
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 500;
export const EMAIL_MAX = 254;
/** One "@", something on both sides, no spaces: the API checks the rest. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Page sizes of the users table. */
export const USER_PAGE_SIZES = [25, 50, 100] as const;
/** Roles listed on one page of the list on the left. */
export const ROLE_PAGE_SIZE = 50;
/** Holders of a role listed on one page. */
export const HOLDER_PAGE_SIZE = 25;
export const USER_STATUSES = ['active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** What each permission lets a role do, said for the people assigning it (whole keys). */
export const PERMISSION_TEXTS: Readonly<Record<ApiPermission, string>> = {
  'content.read': 'editor.admin.permissions.contentRead',
  'content.read.draft': 'editor.admin.permissions.contentReadDraft',
  'content.edit': 'editor.admin.permissions.contentEdit',
  'content.review': 'editor.admin.permissions.contentReview',
  'content.approve': 'editor.admin.permissions.contentApprove',
  'release.publish': 'editor.admin.permissions.releasePublish',
  'translation.manage': 'editor.admin.permissions.translationManage',
  'webhook.manage': 'editor.admin.permissions.webhookManage',
  'admin.roles': 'editor.admin.permissions.adminRoles',
  'admin.branding': 'editor.admin.permissions.adminBranding',
  'admin.backups': 'editor.admin.permissions.adminBackups',
  'scim.provision': 'editor.admin.permissions.scimProvision',
};

export const PERMISSIONS: readonly ApiPermission[] = ALL_PERMISSIONS;

/** Only reading content (`reading`), or doing more (`editing`): the hint next to a role's name. */
export function roleKind(
  permissions: readonly string[],
): 'reading' | 'editing' {
  return permissions.every(
    (p) => p === 'content.read' || p === 'content.read.draft',
  )
    ? 'reading'
    : 'editing';
}

/** A role's ID made from its name (`Safety approver` is `safety-approver`); empty when none can be. */
export function roleIdOf(name: string): string {
  return moduleIdOf(name)
    .replace(/^[0-9-]+/, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '');
}

/**
 * A user's ID made from an email address (the part before "@") or else the name:
 * `jane.doe@example.org` is `jane.doe`, `Jane Doe` is `jane-doe`. Empty when none can be.
 */
export function userIdOf(name: string, email: string): string {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const fromEmail = local
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, ID_MAX)
    .replace(/[._-]+$/, '');
  if (fromEmail && USER_ID.test(fromEmail)) return fromEmail;
  return moduleIdOf(name).slice(0, ID_MAX).replace(/-+$/, '');
}

/** A role being edited: what the form holds. */
export interface RoleDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly ApiPermission[];
  readonly languages: readonly string[];
  readonly moduleTypes: readonly string[];
  /** Empty: every audience level. */
  readonly maxAudience: string;
  /** Per facet, the values covered; a facet without values is not restricted. */
  readonly facets: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_ROLE: RoleDraft = {
  id: '',
  name: '',
  description: '',
  permissions: [],
  languages: [],
  moduleTypes: [],
  maxAudience: '',
  facets: {},
};

/** The form of a stored role. */
export function draftOf(role: RoleItem): RoleDraft {
  const { name, description, permissions, scope } = role.attributes;
  return {
    id: role.id,
    name,
    description: description ?? '',
    permissions: [...permissions],
    languages: [...(scope.languages ?? [])],
    moduleTypes: [...(scope.moduleTypes ?? [])],
    maxAudience: scope.maxAudience ?? '',
    facets: Object.fromEntries(
      Object.entries(scope.facets ?? {}).map(([k, v]) => [k, [...v]]),
    ),
  };
}

/** The scope a draft stands for, as the API takes it: a dimension left empty is left out (all). */
export function scopeOf(draft: RoleDraft): RoleScope {
  const facets = Object.fromEntries(
    Object.entries(draft.facets).filter(([, values]) => values.length > 0),
  ) as Record<string, string[]>;
  return {
    ...(draft.languages.length > 0 && { languages: [...draft.languages] }),
    ...(draft.moduleTypes.length > 0 && {
      moduleTypes: [...draft.moduleTypes],
    }),
    ...(draft.maxAudience && { maxAudience: draft.maxAudience }),
    ...(Object.keys(facets).length > 0 && { facets }),
  };
}

/** The attributes a draft sends, permissions in their listed order. */
export function attributesOf(draft: RoleDraft) {
  return {
    name: draft.name.trim().replace(/\s+/g, ' '),
    description: draft.description.trim() || null,
    permissions: PERMISSIONS.filter((p) => draft.permissions.includes(p)),
    scope: scopeOf(draft),
  };
}

/** Whether two drafts send the same role. */
export function sameRole(a: RoleDraft, b: RoleDraft): boolean {
  return (
    JSON.stringify(sorted(attributesOf(a))) ===
    JSON.stringify(sorted(attributesOf(b)))
  );
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

/** What is wrong with a draft, as translation keys by field; empty when nothing is. */
export function roleProblems(
  draft: RoleDraft,
  isNew: boolean,
): Partial<Record<'id' | 'name' | 'description' | 'permissions', string>> {
  const problems: Partial<
    Record<'id' | 'name' | 'description' | 'permissions', string>
  > = {};
  if (isNew && (!ROLE_ID.test(draft.id) || draft.id.length > ID_MAX)) {
    problems.id = 'editor.admin.roles.problems.id';
  }
  if (!draft.name.trim()) problems.name = 'editor.admin.roles.problems.name';
  if (draft.description.trim().length > DESCRIPTION_MAX) {
    problems.description = 'editor.admin.roles.problems.description';
  }
  if (draft.permissions.length === 0) {
    problems.permissions = 'editor.admin.roles.problems.permissions';
  }
  return problems;
}

/** A user as the dialog edits it. */
export interface UserDraft {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly roleIds: readonly string[];
}

/** What is wrong with a user draft, by field; empty when nothing is. */
export function userProblems(
  draft: UserDraft,
  isNew: boolean,
): Partial<Record<'id' | 'name' | 'email', string>> {
  const problems: Partial<Record<'id' | 'name' | 'email', string>> = {};
  if (isNew && (!USER_ID.test(draft.id) || draft.id.length > ID_MAX)) {
    problems.id = 'editor.admin.users.problems.id';
  }
  if (!draft.name.trim()) problems.name = 'editor.admin.users.problems.name';
  const email = draft.email.trim();
  // A user created here has an email address; one seeded without may keep none.
  if (
    (isNew || email !== '') &&
    (!EMAIL.test(email) || email.length > EMAIL_MAX)
  ) {
    problems.email = 'editor.admin.users.problems.email';
  }
  return problems;
}
