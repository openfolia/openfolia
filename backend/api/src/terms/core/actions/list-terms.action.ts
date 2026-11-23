import { Injectable } from '@nestjs/common';
import {
  foldText,
  termMatches,
  validateTerm,
  type Issue,
  type Term,
  type TermStatus,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/** What `GET /terms` narrows the list to; every filter given has to hold. */
export interface TermFilter {
  /** Terms holding this language; `q` is looked for in it only. */
  readonly lang?: string | undefined;
  readonly status?: TermStatus | undefined;
  /** Terms of this domain, case, diacritics and runs of white space aside. */
  readonly domain?: string | undefined;
  /** Part of a variant or the definition, folded as search folds (`termMatches`). */
  readonly q?: string | undefined;
}

/** A term with the problems found checking it against the configuration, or a file that is no term. */
export type TermEntry =
  { id: string; term: Term; issues: Issue[] } | { id: string; error: string };

/** Whether any filter is given: then files that are no term are left out. */
export function filtersTerms(filter: TermFilter): boolean {
  return Object.values(filter).some((value) => value !== undefined);
}

const sameDomain = (a: string | undefined, b: string) =>
  a !== undefined && foldText(a).trim() === foldText(b).trim();

/** Whether `term` passes every filter given. */
export function matchesTermFilter(term: Term, filter: TermFilter): boolean {
  if (filter.lang !== undefined && term.languages[filter.lang] === undefined) {
    return false;
  }
  if (filter.status !== undefined && term.status !== filter.status) {
    return false;
  }
  if (filter.domain !== undefined && !sameDomain(term.domain, filter.domain)) {
    return false;
  }
  return (
    filter.q === undefined ||
    termMatches(
      term,
      filter.q,
      filter.lang === undefined ? undefined : [filter.lang],
    )
  );
}

/**
 * One page of the terms at the snapshot's commit, by ID. The filters run
 * before paging, so `total` counts what they let through. Without a
 * filter, a file in `terms/` that is no term is listed too (with why), so
 * it does not hide; a filter says nothing about such a file, so it leaves
 * it out. Terms carry no audience: every reader of the commit reads them.
 */
@Injectable()
export class ListTermsAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    filter: TermFilter;
    page: PageRequest;
  },
  Paginated<TermEntry>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    filter,
    page,
  }: {
    snapshot: ReadableContent;
    filter: TermFilter;
    page: PageRequest;
  }): Promise<Paginated<TermEntry>> {
    const [listed, config] = await Promise.all([
      snapshot.terms(),
      snapshot.config(),
    ]);
    const filtered = filtersTerms(filter);
    const entries = listed.flatMap((entry): TermEntry[] => {
      if ('error' in entry) return filtered ? [] : [entry];
      if (!matchesTermFilter(entry.term, filter)) return [];
      return [
        {
          id: entry.id,
          term: entry.term,
          issues: validateTerm(entry.term, config),
        },
      ];
    });
    return paginate(entries, page);
  }
}
