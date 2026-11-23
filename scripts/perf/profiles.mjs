// The scale generator's profiles (`pnpm perf:seed --profile <name>`). `large` is the size the
// product must stay fast at; `xl` is about four times that, to find where it stops scaling;
// `small` builds in a minute or two, for working on the tooling itself.

/**
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} seed the generator's seed: the same seed, the same content and history
 * @property {number} modules source-language modules (snippets included)
 * @property {number} snippets of those, snippets (a module type marked `snippet: true`)
 * @property {number} manuals
 * @property {number} bigManualModules modules in the one big manual (the manual builder's case)
 * @property {Record<string, number>} translated per target language, the share of modules translated
 * @property {number} outdatedShare of the translated modules, the share whose source changed since
 * @property {number} images
 * @property {number} pdfs attachments that are PDFs
 * @property {number} attachments other attachments (CSV, plain text)
 * @property {number} commits commits on `main`, the first included
 * @property {number} releases release tags, cut evenly along the history
 * @property {number} changeSets open change sets
 * @property {number} bigChangeSetModules modules the one big change set edits (the review screen's large diff)
 * @property {number} comments review comments across the change sets
 * @property {number} terms
 * @property {number} users
 * @property {number} auditEvents
 * @property {number} webhooks
 * @property {number} deliveries webhook deliveries across the webhooks
 * @property {number} translationJobs translation (XLIFF) export jobs
 */

/** @type {Record<string, Profile>} */
export const PROFILES = {
  small: {
    name: 'small',
    seed: 'perf-small-1',
    modules: 400,
    snippets: 30,
    manuals: 20,
    bigManualModules: 120,
    translated: { de: 0.8, fr: 0.5, es: 0.3 },
    outdatedShare: 0.15,
    images: 150,
    pdfs: 10,
    attachments: 10,
    commits: 1_000,
    releases: 5,
    changeSets: 15,
    bigChangeSetModules: 40,
    comments: 100,
    terms: 40,
    users: 20,
    auditEvents: 5_000,
    webhooks: 3,
    deliveries: 500,
    translationJobs: 3,
  },
  large: {
    name: 'large',
    seed: 'perf-large-1',
    modules: 5_000,
    snippets: 300,
    manuals: 300,
    bigManualModules: 400,
    translated: {
      de: 0.85,
      fr: 0.6,
      es: 0.45,
      it: 0.35,
      nl: 0.25,
      pl: 0.15,
      sv: 0.08,
    },
    outdatedShare: 0.15,
    images: 2_600,
    pdfs: 250,
    attachments: 150,
    commits: 20_000,
    releases: 50,
    changeSets: 200,
    bigChangeSetModules: 300,
    comments: 2_000,
    terms: 400,
    users: 120,
    auditEvents: 100_000,
    webhooks: 20,
    deliveries: 20_000,
    translationJobs: 40,
  },
  xl: {
    name: 'xl',
    seed: 'perf-xl-1',
    modules: 20_000,
    snippets: 1_200,
    manuals: 1_200,
    bigManualModules: 1_600,
    translated: {
      de: 0.85,
      fr: 0.6,
      es: 0.45,
      it: 0.35,
      nl: 0.25,
      pl: 0.15,
      sv: 0.08,
    },
    outdatedShare: 0.15,
    images: 10_400,
    pdfs: 1_000,
    attachments: 600,
    commits: 80_000,
    releases: 200,
    changeSets: 800,
    bigChangeSetModules: 900,
    comments: 8_000,
    terms: 1_600,
    users: 480,
    auditEvents: 400_000,
    webhooks: 80,
    deliveries: 80_000,
    translationJobs: 160,
  },
};

/** The profile of that name, or an error naming the ones there are. */
export function profileOf(name) {
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
  if (!profile) {
    throw new Error(
      `perf: no profile "${name}" (there are: ${Object.keys(PROFILES).join(', ')})`,
    );
  }
  return profile;
}
