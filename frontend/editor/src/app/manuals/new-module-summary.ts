import type { ModuleSummary } from '../content/browser-model';
import type { NewModule } from '../content/module-creation';

/**
 * The summary of a module just created from the manual builder, as the API would list it on the
 * revision's branch: its row shows its title and status at once, before the lists are read again.
 */
export function summaryOf(module: NewModule): ModuleSummary {
  return {
    type: 'ModuleSummary',
    id: module.id,
    attributes: {
      moduleId: module.id,
      title: module.title,
      titleLang: module.lang,
      moduleType: module.type,
      ...(module.audience ? { audience: module.audience } : {}),
      facets: Object.fromEntries(
        Object.entries(module.facets)
          .filter(([, values]) => values.length > 0)
          .map(([id, values]) => [id, [...values]]),
      ),
      keywords: [...(module.keywords ?? [])],
      languages: [module.lang],
      variants: [],
    },
    meta: { changed: true, text: '' },
  };
}
