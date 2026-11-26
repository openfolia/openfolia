import { UserEmail, UserId, UserName } from './actor.js';
import { GroupName, MAX_GROUPS } from './group-mappings.js';
import type { ExternalIdentity } from './identity-provider.js';

/** A user ID's most characters before a `-<n>` is added to make it unique. */
const ID_BASE_MAX = 56;

/**
 * The ID a new user signing in for the first time gets (#37), before it is
 * made unique: their login name, else the local part of their email
 * address, else `user`, in `UserId`'s format (lowercase letters, digits,
 * ".", "_" and "-"; anything else becomes "-").
 */
export function userIdBase(
  identity: Pick<ExternalIdentity, 'username' | 'email'>,
): string {
  const from =
    identity.username ??
    (identity.email ? identity.email.split('@')[0] : undefined) ??
    '';
  const id = from
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .slice(0, ID_BASE_MAX)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return UserId.safeParse(id).success && id !== '' ? id : 'user';
}

/** `base`, then `base-2`, `base-3` …: the candidates for a new user's ID, `count` of them. */
export function userIdCandidates(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i === 0 ? base : `${base}-${i + 1}`,
  );
}

/** The name shown for someone signing in: their name, else login name, else email, else ID. */
export function displayNameOf(
  identity: ExternalIdentity,
  fallback: string,
): string {
  for (const candidate of [
    identity.name,
    identity.username,
    identity.email,
    fallback,
  ]) {
    const parsed = UserName.safeParse(candidate?.slice(0, 200));
    if (parsed.success) return parsed.data;
  }
  return fallback;
}

/**
 * The email address to keep for someone signing in: only one the provider
 * vouches for (`email_verified`) and in `UserEmail`'s format; else null.
 */
export function verifiedEmailOf(identity: ExternalIdentity): string | null {
  if (!identity.emailVerified || identity.email === null) return null;
  const parsed = UserEmail.safeParse(identity.email.trim());
  return parsed.success ? parsed.data : null;
}

/**
 * The groups worth keeping: well-formed (`GroupName`), each once, at most
 * `MAX_GROUPS`; anything else is left out.
 */
export function groupsOf(identity: ExternalIdentity): string[] {
  const kept = new Set<string>();
  for (const group of identity.groups) {
    if (kept.size >= MAX_GROUPS) break;
    if (GroupName.safeParse(group).success) kept.add(group);
  }
  return [...kept];
}
