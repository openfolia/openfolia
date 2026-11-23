import {
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
  type ResolveIssue,
} from '@openfolia/content-model';
import { UnprocessableError } from '../../base/core/errors.js';

/**
 * 422 `expansion-too-large` for a resolution that stopped at one of the limits of #679
 * (`MAX_EXPANDED_NODES`, `MAX_EXPANDED_CHARS`, `MAX_EXPANDED_TABLE_CELLS`, `MAX_NESTING_DEPTH`): it holds nothing, so
 * nothing is made of it (no resolved manual, PDF, page, preview or package). `meta` names the
 * limits (`nodes`, `chars`, `tableCells`, `depth`). The manual's checks report it as a blocking check instead,
 * with the resolver's message saying which limit it passed.
 */
export function refuseTooLarge(resolution: {
  readonly issues: readonly Pick<ResolveIssue, 'code'>[];
}): void {
  if (
    !resolution.issues.some((issue) => issue.code === 'expansion-too-large')
  ) {
    return;
  }
  throw new UnprocessableError(
    'expansion-too-large',
    `The manual is too large to make: once its module references are included it holds more than ${MAX_EXPANDED_NODES.toLocaleString('en')} content nodes, ${MAX_EXPANDED_CHARS.toLocaleString('en')} characters or ${MAX_EXPANDED_TABLE_CELLS.toLocaleString('en')} table cells (rows × columns) (a module referred to over several paths counts once per path), or its blocks and references nest more than ${MAX_NESTING_DEPTH} deep. Refer to fewer modules, over fewer paths, or nest them less deeply; its checks say which limit it passed.`,
    {
      nodes: MAX_EXPANDED_NODES,
      chars: MAX_EXPANDED_CHARS,
      tableCells: MAX_EXPANDED_TABLE_CELLS,
      depth: MAX_NESTING_DEPTH,
    },
  );
}
