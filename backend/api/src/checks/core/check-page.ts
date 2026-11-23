import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../base/core/paging.js';
import {
  countBySeverity,
  severityOf,
  type Check,
  type CheckSeverity,
} from './check.js';
import type { Checked } from './content-checks.js';

export interface CheckFilter {
  readonly severity?: CheckSeverity;
}

/** One page of checks, the counts of all of them, and the commit checked. */
export interface CheckPage extends Paginated<Check> {
  /** Every check found (before `filter`), by severity. */
  readonly counts: Record<CheckSeverity, number>;
  /**
   * The modules checked (by ID, in any language), and how many of them no
   * check names (before `filter`).
   */
  readonly modules: {
    readonly checked: number;
    readonly withoutIssues: number;
  };
  /** The commit checked. */
  readonly commit: string;
}

/** Counted over all, then filtered and paged. */
export function pageOfChecks(
  { checks, modules }: Checked,
  filter: CheckFilter,
  page: PageRequest,
): Omit<CheckPage, 'commit'> {
  const named = new Set(
    checks.flatMap(({ subject }) =>
      subject.type === 'module' ? [subject.moduleId] : [],
    ),
  );
  const kept =
    filter.severity === undefined
      ? checks
      : checks.filter((check) => severityOf(check) === filter.severity);
  return {
    ...paginate(kept, page),
    counts: countBySeverity(checks),
    modules: {
      checked: modules.length,
      withoutIssues: modules.filter((id) => !named.has(id)).length,
    },
  };
}
