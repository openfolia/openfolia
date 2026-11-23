import { firstValueFrom } from 'rxjs';

import type { ApiClient } from '../api';

/** A manual or a module that uses a module. */
export interface ModuleUse {
  readonly kind: 'manual' | 'module';
  readonly id: string;
  readonly title: string;
}

/** Where a module is used, and whether every use is listed. */
export interface ModuleUsage {
  readonly uses: readonly ModuleUse[];
  /** How many uses there are in all (`uses` may name fewer). */
  readonly count: number;
  /** False when the API names fewer uses than it counts (it names at most 50): a use is missing. */
  readonly complete: boolean;
}

/**
 * The manuals that include `moduleId` (directly or through module references) and the modules
 * that reference it, as the API's module index says (`meta.usedIn` of `GET /modules/:lang/:id`,
 * read in `lang`, a language the module exists in): manuals first, then modules, each by title.
 * A module reference names a module by ID whatever the language, so any of its languages gives
 * the same answer. The API names and counts only what the person may see.
 */
export async function loadModuleUsage(
  api: ApiClient,
  moduleId: string,
  lang: string,
): Promise<ModuleUsage> {
  const doc = await firstValueFrom(
    api.get('/modules/{lang}/{id}', { path: { lang, id: moduleId } }),
  );
  const { usedIn, usage } = doc.data.meta;
  const count = usage.manuals + usage.modules;
  return {
    uses: usedIn.map(({ kind, id, title }) => ({ kind, id, title })),
    count,
    complete: usedIn.length >= count,
  };
}
