import { firstValueFrom } from 'rxjs';

import { toApiError, type ApiClient } from '../api';
import type { DeletedModule } from './module-deletion';

/** A module a change set deleted in every language, as the content browser lists it. */
export interface DeletedRow {
  readonly moduleId: string;
  readonly title: string;
  /** The languages it was deleted in. */
  readonly langs: readonly string[];
  readonly type?: string | undefined;
  readonly audience?: string | undefined;
}

/** The change set's changes read for deleted modules: one page of the list's largest size. */
export const CHANGES_PAGE_SIZE = 200;
/** At most this many deleted modules are listed (each costs a read or two). */
export const DELETED_LIMIT = 20;
/** At most this many modules with a removed language are looked up. */
export const DELETED_READS = 50;
const SUMMARY_PAGE_SIZE = 100;

/**
 * The modules the change set deleted in every language they had, for the content browser to show
 * as Deleted (the summaries list only what is there). Read from the change set's changes
 * (`removed` module languages), keeping a module only when no language of it is left on the
 * branch. The title (and type and audience) come from what this tab deleted, else from the
 * change set's base, read by commit, else the ID stands in. At most `DELETED_LIMIT` modules, from
 * the first `CHANGES_PAGE_SIZE` changes.
 */
export async function loadDeletedModules(
  api: ApiClient,
  changeSetId: string,
  known: readonly DeletedModule[],
  /** Whoever reads now: only their own deletes lend a title. */
  person: string,
): Promise<DeletedRow[]> {
  const changes = await firstValueFrom(
    api.get('/change-sets/{changeSetId}/changes', {
      path: { changeSetId },
      query: { 'page[size]': CHANGES_PAGE_SIZE },
    }),
  );
  const removed = new Map<string, string[]>();
  for (const change of changes.data) {
    const subject = change.attributes.subject;
    if (subject.type !== 'module' || change.meta.change !== 'removed') continue;
    const langs = removed.get(subject.moduleId) ?? [];
    langs.push(subject.lang);
    removed.set(subject.moduleId, langs);
  }
  // Still listed ones are passed over before the cap, so they never hide the deleted ones; at
  // most `DELETED_READS` modules are looked up.
  const rows: DeletedRow[] = [];
  const looked = [...removed.entries()].slice(0, DELETED_READS);
  for (const [moduleId, langs] of looked) {
    if (rows.length >= DELETED_LIMIT) break;
    if (await isListed(api, moduleId)) continue; // a language of it is left
    const mine = known.find(
      (k) =>
        k.changeSetId === changeSetId &&
        k.moduleId === moduleId &&
        k.person === person,
    );
    if (mine) {
      rows.push({ moduleId, title: mine.title, langs });
      continue;
    }
    const before = await readAt(api, moduleId, langs, changes.meta.base);
    rows.push({ moduleId, langs, title: moduleId, ...before });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}

/** Whether the module is on the chosen branch in any language. */
async function isListed(api: ApiClient, moduleId: string): Promise<boolean> {
  const found = await firstValueFrom(
    api.get('/module-summaries', {
      query: {
        'filter[q]': moduleId,
        'page[number]': 1,
        'page[size]': SUMMARY_PAGE_SIZE,
      },
    }),
  );
  return found.data.some((s) => s.id === moduleId);
}

/** The module's title, type and audience at `commit`, in the first language it has there. */
async function readAt(
  api: ApiClient,
  moduleId: string,
  langs: readonly string[],
  commit: string,
): Promise<Partial<DeletedRow>> {
  for (const lang of langs) {
    const found = await firstValueFrom(
      api.get('/modules/{lang}/{id}', {
        path: { lang, id: moduleId },
        query: { ref: commit },
      }),
    ).catch((error: unknown) => {
      // Not readable by commit (a reader without drafts), or not there: the ID stands in.
      if ([400, 403, 404].includes(toApiError(error).status)) return null;
      throw error;
    });
    if (found) {
      const a = found.data.attributes;
      return { title: a.title, type: a.moduleType, audience: a.audience };
    }
  }
  return {};
}
