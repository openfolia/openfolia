import type { Route, Routes } from '@angular/router';

import { SETTINGS_TOPICS } from './settings-topics';

const PAGES: Readonly<Record<string, Route['loadComponent']>> = {
  languages: () =>
    import('./languages-topic.component').then((m) => m.LanguagesTopicPage),
  facets: () =>
    import('./facets-topic.component').then((m) => m.FacetsTopicPage),
  'variant-attributes': () =>
    // #91's editor, mounted as it is.
    import('../variants/variant-editor.component').then(
      (m) => m.VariantEditorComponent,
    ),
  'output-labels': () =>
    import('./output-labels-topic.component').then(
      (m) => m.OutputLabelsTopicPage,
    ),
  headings: () =>
    import('./headings-topic.component').then((m) => m.HeadingsTopicPage),
  manufacturer: () =>
    import('./manufacturer-topic.component').then(
      (m) => m.ManufacturerTopicPage,
    ),
  review: () =>
    import('./review-rule-topic.component').then((m) => m.ReviewRuleTopicPage),
  'code-languages': () =>
    import('./code-languages-topic.component').then(
      (m) => m.CodeLanguagesTopicPage,
    ),
};

const options = () =>
  import('./options-topic.component').then((m) => m.OptionsTopicPage);

/**
 * The topics of Admin › Project settings, one route each (`/admin/settings/<topic>`); the
 * settings page itself opens the first. A redirect keeps the query (`?cs=`).
 */
export const SETTINGS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: SETTINGS_TOPICS[0]?.path ?? 'languages',
  },
  ...SETTINGS_TOPICS.map((topic): Route => ({
    path: topic.path,
    title: topic.title,
    data: {
      nested: true,
      titleParent: 'editor.admin.titles.settings',
      ...(topic.help && { help: topic.help }),
    },
    // The option lists (`OPTION_TOPICS`) share one page.
    loadComponent: PAGES[topic.path] ?? options,
  })),
];
