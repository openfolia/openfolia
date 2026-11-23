import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, type Schema } from '../api';
import { MeService } from '../permissions/me';
import { DemoSession } from '../session/demo-session';

/** A version of a module or of a manual: the same members (`GET …/history`). */
export type ModuleVersion =
  Schema<'ModuleVersionResource'> | Schema<'ManualVersionResource'>;
export interface ModuleVersionPage extends Omit<
  Schema<'ModuleVersionPageDocument'>,
  'data'
> {
  readonly data: readonly ModuleVersion[];
}

/** What a history is of: a module in a language (#88), or a manual (#321). */
export type HistorySubject =
  | {
      readonly type: 'module';
      readonly lang: string;
      readonly moduleId: string;
    }
  | { readonly type: 'manual'; readonly manualId: string };

/** The subject as locks and comments name it (`module/<lang>/<id>`, `manual/<id>`). */
export const subjectKeyOf = (subject: HistorySubject): string =>
  subject.type === 'module'
    ? `module/${subject.lang}/${subject.moduleId}`
    : `manual/${subject.manualId}`;

/** Versions a page of the history holds, in the side panel and on the history page alike. */
export const HISTORY_PAGE_SIZE = 20;

/** The short form of a commit, where a version has no revision number. */
export const shortCommit = (commit: string): string => commit.slice(0, 7);

/**
 * How a version is named: "v3" (`full`: "version 3", for running text and accessible names),
 * or its short commit when the history was cut.
 */
export function revisionOf(
  version: ModuleVersion,
  full = false,
): {
  readonly key: string;
  readonly params: Record<string, unknown>;
} {
  return version.meta.revision === null
    ? {
        key: 'editor.history.commit',
        params: { commit: shortCommit(version.attributes.commit) },
      }
    : {
        key: full ? 'editor.history.version' : 'editor.history.revision',
        params: { revision: version.meta.revision },
      };
}

/** The page (of `size`) that holds the version at `index` (from 0, newest first). */
export const pageOf = (index: number, size = HISTORY_PAGE_SIZE): number =>
  Math.floor(index / size) + 1;

/** Reads a page of a module's or manual's history at the chosen change set's branch (or `main`). */
export async function loadHistory(
  api: ApiClient,
  subject: HistorySubject,
  page: number,
  size = HISTORY_PAGE_SIZE,
): Promise<ModuleVersionPage> {
  const query = { 'page[number]': page, 'page[size]': size };
  return subject.type === 'module'
    ? firstValueFrom(
        api.get('/modules/{lang}/{id}/history', {
          path: { lang: subject.lang, id: subject.moduleId },
          query,
        }),
      )
    : firstValueFrom(
        api.get('/manuals/{id}/history', {
          path: { id: subject.manualId },
          query,
        }),
      );
}

/**
 * The version right before the one at `index` (from 0, newest first): from the page shown when
 * it is there, else read on its own (one version, a page of one). Null for the oldest.
 */
export async function versionBefore(
  api: ApiClient,
  subject: HistorySubject,
  shown: ModuleVersionPage,
  index: number,
): Promise<ModuleVersion | null> {
  const page = shown.meta.page;
  const first = (page.currentPage - 1) * page.perPage;
  const wanted = index + 1;
  if (wanted >= page.total) return null;
  const local = shown.data[wanted - first];
  if (local) return local;
  const one = await loadHistory(api, subject, wanted + 1, 1);
  return one.data[0] ?? null;
}

/** How a person is named: the acting person's or a demo user's name, else their ID. */
export function injectPersonName(): (kind: string, id: string) => string {
  const me = inject(MeService);
  const demo = inject(DemoSession);
  return (kind, id) => {
    const acting = me.me();
    if (kind === acting.kind && id === acting.id && acting.name) {
      return acting.name;
    }
    return demo.users().find((u) => u.id === id)?.name ?? id;
  };
}
