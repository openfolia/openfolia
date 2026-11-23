import type { Item } from '../api';
import {
  DESCRIPTION_MAX,
  ID_MAX,
  type RoleItem,
  USER_ID,
  userIdOf,
} from './admin-model';

export type ServiceAccountItem = Item<'/service-accounts'>;
export type ServiceTokenItem =
  Item<'/service-accounts/{serviceAccountId}/tokens'>;

/** A service account's ID has a user ID's format (`portal-build`, `ci.release`). */
export const SERVICE_ACCOUNT_ID = USER_ID;
/** Page sizes of the service accounts table. */
export const SERVICE_ACCOUNT_PAGE_SIZES = [25, 50, 100] as const;
/** Tokens of one service account listed on one page. */
export const TOKEN_PAGE_SIZE = 10;
export const SERVICE_ACCOUNT_STATUSES = ['active', 'deactivated'] as const;
export type ServiceAccountStatus = (typeof SERVICE_ACCOUNT_STATUSES)[number];
export const TOKEN_NAME_MAX = 100;
/** How long a new token lasts, in days, to choose from; the API takes at most 366. */
export const TOKEN_LIFETIMES = [30, 90, 180, 365] as const;
export type TokenLifetime = (typeof TOKEN_LIFETIMES)[number];
/** The API's default lifetime, chosen first. */
export const DEFAULT_TOKEN_LIFETIME: TokenLifetime = 90;

/** The permission no service account may hold (the API answers 422 for a role with it). */
const ADMIN = 'admin.roles';

/** Whether a service account may hold the role: only a role without `admin.roles`. */
export function assignableToService(role: RoleItem): boolean {
  return !role.attributes.permissions.includes(ADMIN);
}

/** A service account as the dialog edits it. */
export interface ServiceAccountDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly roleIds: readonly string[];
}

/** A service account's ID made from its name (`Portal build` is `portal-build`); empty when none can be. */
export function serviceAccountIdOf(name: string): string {
  return userIdOf(name, '');
}

/** What is wrong with a service account draft, by field; empty when nothing is. */
export function serviceAccountProblems(
  draft: ServiceAccountDraft,
  isNew: boolean,
): Partial<Record<'id' | 'name' | 'description', string>> {
  const problems: Partial<Record<'id' | 'name' | 'description', string>> = {};
  if (
    isNew &&
    (!SERVICE_ACCOUNT_ID.test(draft.id) || draft.id.length > ID_MAX)
  ) {
    problems.id = 'editor.admin.serviceAccounts.problems.id';
  }
  if (!draft.name.trim()) {
    problems.name = 'editor.admin.serviceAccounts.problems.name';
  }
  if (draft.description.trim().length > DESCRIPTION_MAX) {
    problems.description = 'editor.admin.serviceAccounts.problems.description';
  }
  return problems;
}

/** Where a token stands: revoked (for good), expired, or still able to act. */
export function tokenState(
  token: ServiceTokenItem,
  now: Date = new Date(),
): 'active' | 'expired' | 'revoked' {
  if (token.attributes.revokedAt) return 'revoked';
  return new Date(token.attributes.expiresAt).getTime() <= now.getTime()
    ? 'expired'
    : 'active';
}

/** When a token issued now with this lifetime expires, as the API takes it. */
export function expiryOf(days: TokenLifetime, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
