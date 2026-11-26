import type { OptionListKey, ValueRef } from './config-model';

/** The groups of the settings menu, in order. */
export const SETTINGS_GROUPS = [
  'languages',
  'contentModel',
  'output',
  'installation',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** One topic of the project settings: a page of its own (`/admin/settings/<path>`). */
export interface SettingsTopic {
  /** The route path under `/admin/settings`. */
  readonly path: string;
  readonly group: SettingsGroup;
  /** The topic's title and hint (translation keys). */
  readonly title: string;
  readonly hint: string;
  /** The text of the topic's one Add button (a key); none: the topic adds nothing. */
  readonly add?: string;
  /**
   * The installation's own settings (#588), changed at once through `/settings`, not the
   * project configuration in a change set: the page reads nothing of `openfolia.yaml` for it.
   */
  readonly installation?: true;
  /**
   * The topic's own page of the user guide, by article ID (#221), where it has one beyond
   * Project settings' (`guide.admin.project-settings`, which the others show).
   */
  readonly help?: string;
}

/** The option-list topics: which list of `openfolia.yaml` each edits, and how. */
export interface OptionTopic {
  readonly key: OptionListKey;
  /** The usage counts' kind; null: nothing counts the list's use. */
  readonly usage: ValueRef['kind'] | null;
  /** The fewest options the list keeps (the schema's `min`). */
  readonly min: number;
}

export const OPTION_TOPICS: Readonly<Record<string, OptionTopic>> = {
  'module-types': { key: 'moduleTypes', usage: 'moduleType', min: 1 },
  audiences: { key: 'audiences', usage: 'audience', min: 1 },
  'text-attributes': { key: 'textAttributes', usage: 'textAttribute', min: 0 },
  'safety-symbols': { key: 'safetySymbols', usage: 'safetySymbol', min: 0 },
};

/**
 * The topics in menu order: languages; the content model (module types, audiences, facets, variant
 * attributes, text attributes); the output (labels, headings, the manufacturer, safety symbols, code
 * languages); the
 * installation (review: who may approve their own change set, #588; two-factor: who must sign in
 * with a second factor, #611; single sign-on and how long sessions last, #378).
 * The variant attributes' page keeps its selection in `attribute`, `value`, `usage` and `page`
 * (#91's editor), the facets' in `facet`, the output labels' language in `labels`.
 */
export const SETTINGS_TOPICS: readonly SettingsTopic[] = [
  {
    path: 'languages',
    group: 'languages',
    title: 'editor.admin.settings.sections.languages',
    hint: 'editor.admin.settings.hints.languages',
    add: 'editor.admin.settings.languages.add',
  },
  {
    path: 'module-types',
    group: 'contentModel',
    title: 'editor.admin.settings.sections.moduleTypes',
    hint: 'editor.admin.settings.hints.moduleTypes',
    add: 'editor.admin.settings.add.moduleType',
  },
  {
    path: 'audiences',
    help: 'guide.manuals.audiences',
    group: 'contentModel',
    title: 'editor.admin.settings.sections.audiences',
    hint: 'editor.admin.settings.hints.audiences',
    add: 'editor.admin.settings.add.audience',
  },
  {
    path: 'facets',
    group: 'contentModel',
    title: 'editor.admin.settings.sections.facets',
    hint: 'editor.admin.settings.hints.facets',
    add: 'editor.admin.settings.facets.addValue',
  },
  {
    path: 'variant-attributes',
    help: 'guide.variants.attributes',
    group: 'contentModel',
    title: 'editor.admin.settings.sections.variantAttributes',
    hint: 'editor.admin.settings.hints.variantAttributes',
    // #91's editor carries its own Add buttons (New attribute, Add value).
  },
  {
    path: 'text-attributes',
    group: 'contentModel',
    title: 'editor.admin.settings.sections.textAttributes',
    hint: 'editor.admin.settings.hints.textAttributes',
    add: 'editor.admin.settings.add.textAttribute',
  },
  {
    path: 'output-labels',
    group: 'output',
    title: 'editor.admin.settings.sections.outputLabels',
    hint: 'editor.admin.settings.hints.outputLabels',
  },
  {
    path: 'headings',
    group: 'output',
    title: 'editor.admin.settings.sections.headings',
    hint: 'editor.admin.settings.hints.headings',
  },
  {
    path: 'manufacturer',
    group: 'output',
    title: 'editor.admin.settings.sections.manufacturer',
    hint: 'editor.admin.settings.hints.manufacturer',
  },
  {
    path: 'safety-symbols',
    help: 'guide.media.safety-symbols',
    group: 'output',
    title: 'editor.admin.settings.sections.safetySymbols',
    hint: 'editor.admin.settings.hints.safetySymbols',
    add: 'editor.admin.settings.add.safetySymbol',
  },
  {
    path: 'code-languages',
    group: 'output',
    title: 'editor.admin.settings.sections.codeLanguages',
    hint: 'editor.admin.settings.hints.codeLanguages',
    add: 'editor.admin.settings.add.codeLanguage',
  },
  {
    path: 'review',
    help: 'guide.review.self-approval',
    group: 'installation',
    title: 'editor.admin.settings.sections.review',
    hint: 'editor.admin.settings.hints.review',
    installation: true,
  },
  {
    path: 'two-factor',
    help: 'guide.admin.two-factor',
    group: 'installation',
    title: 'editor.admin.settings.sections.secondFactor',
    hint: 'editor.admin.settings.hints.secondFactor',
    installation: true,
  },
  {
    path: 'single-sign-on',
    help: 'guide.admin.single-sign-on',
    group: 'installation',
    title: 'editor.admin.settings.sections.singleSignOn',
    hint: 'editor.admin.settings.hints.singleSignOn',
    installation: true,
  },
];

export const GROUP_TITLES: Readonly<Record<SettingsGroup, string>> = {
  languages: 'editor.admin.settings.groups.languages',
  contentModel: 'editor.admin.settings.groups.contentModel',
  output: 'editor.admin.settings.groups.output',
  installation: 'editor.admin.settings.groups.installation',
};

export function topicOf(path: string | undefined): SettingsTopic | undefined {
  return SETTINGS_TOPICS.find((t) => t.path === path);
}

/** A topic's page: the settings page calls `openAdd` from the topic's Add button. */
export interface SettingsTopicPage {
  openAdd(): void;
}
