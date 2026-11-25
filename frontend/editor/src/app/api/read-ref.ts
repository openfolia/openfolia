import { Injectable, signal } from '@angular/core';

import type { RefPath } from './api-types';

/**
 * The content routes that read at a `ref`. Their calls follow the chosen change set's branch
 * unless the caller names a `ref` itself (binary routes, the PDF and assets, are not read through
 * `ApiClient`). Written out as literals (the types check each is a
 * route that takes `ref`, and that none is missing), so a route that does not take `ref` never
 * gets one (the API answers 400 for a parameter it does not support).
 */
export const REF_ROUTES = [
  '/assets',
  '/chunks',
  '/config',
  '/config/usages',
  '/modules',
  '/modules/{lang}/{id}',
  '/modules/{lang}/{id}/hidden-content',
  '/modules/{lang}/{id}/history',
  '/module-summaries',
  '/manuals',
  '/manuals/{id}',
  '/manuals/{id}/checks',
  '/manuals/{id}/history',
  '/manuals/{id}/update-guide/{lang}',
  '/manuals/{id}/update-guide/{lang}/steps',
  '/manuals/{id}/variants/{variant}/{lang}',
  '/manuals/{id}/variants/{variant}/{lang}/hidden-content',
  '/manuals/{id}/variants/{variant}/{lang}/pdf/layout-warnings',
  '/page-designs',
  '/page-design-templates',
  '/page-design-templates/{templateId}/file',
  '/page-design-templates/{templateId}/files',
  '/page-designs/{designId}',
  '/reports/module-usage',
  '/reports/translations',
  '/search',
  '/terms',
  '/terms/{termId}',
  '/translations/status',
  '/translations/status/{lang}/{moduleId}',
  '/translations/status/{lang}/config/project',
  '/translations/status/{lang}/designs/{designId}',
  '/translations/status/{lang}/manuals/{manualId}',
  '/variants',
  '/variants/matches',
  '/variants/{attributeId}/usages',
] as const satisfies readonly RefPath[];

/** Compile-time proof that `REF_ROUTES` lists every route that takes `ref`. */
export const REF_ROUTES_COMPLETE: [
  Exclude<RefPath, (typeof REF_ROUTES)[number]>,
] extends [never]
  ? true
  : never = true;

/**
 * The branch content reads follow: the chosen change set's (`change-sets/<id>`), or undefined
 * for the released content. Set by the change-set session, read by `ApiClient`; a state of its
 * own (not the session) so the client does not depend on the session that depends on it.
 */
@Injectable({ providedIn: 'root' })
export class ReadRef {
  readonly ref = signal<string | undefined>(undefined);
  /**
   * The branch a read answered `change-set-branch-missing` for (#317), while it is the one reads
   * follow: the change set's branch is gone from the content repository. Set by
   * `missingBranchInterceptor`, read by the change-set session; cleared by the session when a
   * list read says the branch is there.
   */
  readonly missing = signal<string | undefined>(undefined);
  /**
   * Counts the moves of the branch reads follow to a new head under the same name (an update
   * from its base, #466). A screen that reads again when `ref` changes reads again when this
   * changes too: `ref` alone stays the same, and so would the screen.
   */
  readonly moves = signal(0);

  /** The branch reads follow got a new head: screens reading at it read again. */
  moved(branch: string): void {
    if (branch === this.ref()) this.moves.update((n) => n + 1);
  }
}
