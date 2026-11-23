/**
 * The permission helper: the one place that decides what a control does for the current person.
 *
 * - `hidden`: the role can never do it (no such permission): do not render it.
 * - `disabled`: the role may, but it is blocked right now (for example "Create release" while
 *   checks fail): render it disabled and show the reason in a tooltip.
 * - `enabled`.
 */
export type PermissionState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'enabled' };

/** What a control needs: a permission, and optionally why it is blocked at the moment. */
export interface PermissionRule {
  readonly permission: string;
  /** Other permissions that grant it as well: any one of them, or `permission`, will do. */
  readonly anyOf?: readonly string[];
  /**
   * A non-empty reason blocks the action now; null or undefined means nothing blocks it. It is
   * a translation key, translated where it shows.
   */
  readonly blockedReason?: string | null;
}

export function decide(
  granted: ReadonlySet<string>,
  rule: PermissionRule,
): PermissionState {
  if (
    !granted.has(rule.permission) &&
    !(rule.anyOf ?? []).some((p) => granted.has(p))
  ) {
    return { kind: 'hidden' };
  }
  if (rule.blockedReason) {
    return { kind: 'disabled', reason: rule.blockedReason };
  }
  return { kind: 'enabled' };
}

/**
 * A contributor (#137): changes content without reading drafts (`content.edit` without
 * `content.read.draft`), so they see released content and only their own change sets. They
 * suggest changes, one change set per suggestion, through the focused module editor.
 */
export function suggestsOnly(granted: ReadonlySet<string>): boolean {
  return granted.has('content.edit') && !granted.has('content.read.draft');
}

/**
 * Whose work review labels "Contributor" (#137): their roles hold neither `content.review` nor
 * `content.approve`, derived from what the API lists for the person, never a stored flag.
 */
export function contributesOnly(granted: ReadonlySet<string>): boolean {
  return !granted.has('content.review') && !granted.has('content.approve');
}
