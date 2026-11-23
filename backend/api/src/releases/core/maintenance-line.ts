import { BRANCH_PREFIX } from '../../change-sets/core/change-set.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { isReleaseId, newReleaseId } from './release.js';
import { isReleasePart, isReleaseTagPattern } from './release-tags.js';

/**
 * A maintenance line (#60): the branch an older product revision is fixed
 * on, started from one of its releases. Writers pick the line (the
 * product revision they fix), never a branch: change sets start on it
 * (`maintenanceLine`), merge into it, and releases are cut from its head.
 * Closing it keeps the branch but takes no new change sets.
 */
export interface MaintenanceLine {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  /** The base release's product. */
  readonly product: string;
  /** The base release's revision: the revision this line maintains. */
  readonly revision: string;
  /** The release it started from: its branch starts at that tag's commit. */
  readonly baseRelease: string;
  /** The commit the line started at (the base release's). */
  readonly baseCommit: string;
  /** Its branch, named by `CCMS_MAINTENANCE_BRANCH`. */
  readonly branch: string;
  readonly createdBy: ChangeSetAuthor;
  readonly createdAt: Date;
  /** Set once closed; null while open. */
  readonly closedAt: Date | null;
  readonly closedBy: ChangeSetAuthor | null;
}

/** Which lines to list; every field optional. */
export interface MaintenanceLineFilter {
  readonly product?: string;
  /** `open` (not closed) or `closed`. */
  readonly state?: MaintenanceLineState;
}

export const MAINTENANCE_LINE_STATES = ['open', 'closed'] as const;
export type MaintenanceLineState = (typeof MAINTENANCE_LINE_STATES)[number];

/** Where a line is: open until closed. */
export const stateOf = (line: Pick<MaintenanceLine, 'closedAt'>) =>
  line.closedAt === null ? 'open' : 'closed';

export const newMaintenanceLineId = newReleaseId;
export const isMaintenanceLineId = isReleaseId;

/** The default maintenance branch pattern (`CCMS_MAINTENANCE_BRANCH`). */
export const DEFAULT_MAINTENANCE_BRANCH = 'maintenance/{product}/{revision}';

/**
 * Whether `pattern` names maintenance branches: a release tag pattern
 * (`isReleaseTagPattern`: both placeholders once, as whole components)
 * that cannot name a change set's branch (`change-sets/…`, in any case).
 */
export function isMaintenanceBranchPattern(pattern: string): boolean {
  return (
    isReleaseTagPattern(pattern) &&
    pattern.split('/')[0]?.toLowerCase() !==
      BRANCH_PREFIX.slice(0, -1).toLowerCase()
  );
}

/**
 * The branch of the line maintaining `revision` of `product` by `pattern`;
 * undefined when they cannot be part of a branch name.
 */
export function maintenanceBranchName(
  pattern: string,
  product: string,
  revision: string,
): string | undefined {
  if (!isMaintenanceBranchPattern(pattern)) {
    throw new Error(`invalid maintenance branch pattern "${pattern}"`);
  }
  if (!isReleasePart(product) || !isReleasePart(revision)) return undefined;
  const name = pattern
    .split('/')
    .map((c) =>
      c === '{product}' ? product : c === '{revision}' ? revision : c,
    )
    .join('/');
  // A value as the first component could still say `refs` or `change-sets`.
  const first = name.split('/')[0]?.toLowerCase();
  return first === 'refs' ||
    first === BRANCH_PREFIX.slice(0, -1).toLowerCase() ||
    name.length > 256
    ? undefined
    : name;
}
