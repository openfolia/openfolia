/**
 * The portal's own texts, in English and German. A build in another language shows English
 * chrome around its content (`textsFor`); the content's fixed labels (signal words, "Contents",
 * "Figure") follow the manual's language through the output labels, as in the PDF.
 */
export interface Texts {
  readonly siteTitle: string;
  readonly skipToContent: string;
  readonly mainNav: string;
  readonly manuals: string;
  readonly search: string;
  readonly searchTitle: string;
  readonly searchIntro: string;
  readonly searchNoScript: string;
  readonly language: string;
  readonly darkMode: string;
  readonly filters: string;
  readonly product: string;
  readonly allProducts: string;
  readonly allValues: string;
  readonly filterByTitle: string;
  /** How many manuals the list shows: `{n}` is the number (`countText`). */
  readonly manualCount: { readonly one: string; readonly other: string };
  readonly noManuals: string;
  readonly noMatch: string;
  readonly variant: string;
  readonly variants: string;
  readonly release: (revision: string, date: string) => string;
  readonly breadcrumb: string;
  readonly notFoundTitle: string;
  readonly notFoundText: string;
  readonly backToManuals: string;
  /** The start page's line under the title. */
  readonly startIntro: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  /** The running head's compact search field. */
  readonly searchShort: string;
  readonly searchButton: string;
  readonly allManuals: string;
  /** The link under a product's manuals: `{product}`, `{n}`. */
  readonly allOfProduct: string;
  readonly latestRelease: string;
  readonly previous: string;
  readonly next: string;
  /** `{n}` of `{m}` pages. */
  readonly pageOf: string;
  readonly pagination: string;
  readonly downloadPdf: string;
  readonly pdfSize: string;
  readonly products: string;
  /** The narrow screens' product switch. */
  readonly productSwitch: string;
  readonly moreProducts: string;
  /** Search: `{n}` manuals for `{q}`. */
  readonly resultsFor: { readonly one: string; readonly other: string };
  readonly passages: { readonly one: string; readonly other: string };
  readonly noResults: string;
  readonly searchEmpty: string;
  readonly searchFailed: string;
  readonly openContents: string;
  readonly notFoundHint: string;
  readonly searchInstead: string;
  /** The button that unfolds a row's other variants: `{n}`. */
  readonly moreVariants: string;
  readonly filtersShort: string;
  /** A variant switch option that changes other attributes too: `{values}`. */
  readonly onlyAs: string;
  /**
   * The notice after such a switch: `{value}` was picked, it is published only as `{values}`,
   * so `{changes}` (each a `change`) changed. `one` or `other` by the number of changes.
   */
  readonly switchNotice: { readonly one: string; readonly other: string };
  /** One change in the notice: `{attribute}`, `{value}`. */
  readonly switchChange: string;
  readonly dismissNotice: string;
  /** The copy button on code blocks: its name, the "done" line and the refused-clipboard lines. */
  readonly copyCode: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly copyFailedHint: string;
  /** The typeahead under a search field (#845): its list's name. */
  readonly suggestions: string;
  /** Read out when the suggestions arrive: `{n}`. */
  readonly suggestionCount: { readonly one: string; readonly other: string };
  /** No passage matches `{q}`. */
  readonly noSuggestion: string;
  /** The last row: the search page for `{q}`. */
  readonly allResults: string;
  readonly searching: string;
  /** Update guides (#907): what marks one in the lists, and its page. */
  readonly updateGuide: string;
  readonly guideIntro: string;
  readonly yourUpdate: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly level: string;
  readonly yourSetup: string;
  /** An option the reader has not set. */
  readonly notSet: string;
  readonly phaseBefore: string;
  readonly phaseDuring: string;
  readonly phaseAfter: string;
  /** `{n}` steps. */
  readonly stepCount: { readonly one: string; readonly other: string };
  /** `{done}` of `{n}` ticked off. */
  readonly doneCount: string;
  readonly resetChecklist: string;
  readonly resetChecklistLong: string;
  /** No step for the jump: `{from}`, `{to}`. */
  readonly nothingToChange: string;
  readonly nothingHint: string;
  /** The link's choice was not valid: the defaults show. */
  readonly invalidChoice: string;
  readonly guideNoScript: string;
  /** A group of the whole guide, without script: `{version}`. */
  readonly versionHeading: string;
  /** Read before a step's version tag. */
  readonly stepVersion: string;
  /** The range, in print: `{from}`, `{to}`. */
  readonly guideRange: string;
}

const en: Texts = {
  siteTitle: 'Documentation',
  skipToContent: 'Skip to content',
  mainNav: 'Main',
  manuals: 'Manuals',
  search: 'Search',
  searchTitle: 'Search the documentation',
  searchIntro:
    'Search every manual of this site. Filter the results by product and variant.',
  searchNoScript: 'Search needs JavaScript. Browse the manuals instead.',
  language: 'Language',
  darkMode: 'Dark mode',
  filters: 'Filter manuals',
  product: 'Product',
  allProducts: 'All products',
  allValues: 'All',
  filterByTitle: 'Title contains',
  manualCount: { one: '1 manual', other: '{n} manuals' },
  noManuals: 'No manuals are published yet.',
  noMatch: 'No manual matches these filters.',
  variant: 'Variant',
  variants: 'Variants',
  release: (revision, date) => `Release ${revision}, ${date}`,
  breadcrumb: 'Breadcrumb',
  notFoundTitle: 'Page not found',
  notFoundText: 'This page does not exist, or it is not part of this site.',
  backToManuals: 'Back to the manuals',
  startIntro:
    'Operating, service and safety manuals for every product, in the variant you have.',
  searchLabel: 'Search all manuals',
  searchPlaceholder: 'Search, for example “battery” or “charging”',
  searchShort: 'Search manuals',
  searchButton: 'Search',
  allManuals: 'All manuals',
  allOfProduct: 'All {n} manuals of {product}',
  latestRelease: 'Release',
  previous: 'Previous',
  next: 'Next',
  pageOf: 'Page {n} of {m}',
  pagination: 'Pages',
  downloadPdf: 'Download PDF',
  pdfSize: 'PDF, {size}',
  products: 'Products',
  productSwitch: 'Product',
  moreProducts: 'More',
  resultsFor: {
    one: '1 manual matches “{q}”',
    other: '{n} manuals match “{q}”',
  },
  passages: { one: '1 passage', other: '{n} passages' },
  noResults: 'Nothing matches “{q}”. Try another word, or a shorter one.',
  searchEmpty: 'Type a word to search every manual of this site.',
  searchFailed:
    'The search could not load. Reload the page, or browse the manuals.',
  openContents: 'Contents',
  notFoundHint:
    'The address may be mistyped, or the manual moved with a new release.',
  searchInstead: 'Search the manuals',
  moreVariants: '+{n} more',
  filtersShort: 'Filters',
  onlyAs: 'only as {values}',
  switchNotice: {
    one: '{value} is published as {values} only, so {changes}.',
    other: '{value} is published as {values} only, so {changes}.',
  },
  switchChange: '{attribute} changed to {value}',
  dismissNotice: 'Dismiss notice',
  copyCode: 'Copy code',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  copyFailedHint: 'Copy failed. The code is selected: press Ctrl+C.',
  suggestions: 'Suggestions',
  suggestionCount: {
    one: '1 match. Choose it with the arrow keys.',
    other: '{n} matches. Choose one with the arrow keys.',
  },
  noSuggestion: 'No passage matches “{q}”.',
  allResults: 'All results for “{q}”',
  searching: 'Searching…',
  updateGuide: 'Update guide',
  guideIntro:
    'Pick the version you are on and the one you are updating to: the checklist shows exactly the steps for that update.',
  yourUpdate: 'Your update',
  fromVersion: 'From version',
  toVersion: 'To version',
  level: 'Level',
  yourSetup: 'Your setup',
  notSet: 'Not set',
  phaseBefore: 'Before you update',
  phaseDuring: 'During the update',
  phaseAfter: 'After the update',
  stepCount: { one: '1 step', other: '{n} steps' },
  doneCount: '{done} of {n} done',
  resetChecklist: 'Reset',
  resetChecklistLong: 'Reset the checklist',
  nothingToChange: 'Nothing to change between {from} and {to} for this setup.',
  nothingHint: 'Pick another range, level or setup to see its steps.',
  invalidChoice:
    'The link asked for a choice this guide does not offer, so it shows the default.',
  guideNoScript:
    'Without JavaScript this page shows the whole guide, by version. Turn it on to pick your versions and tick off the steps.',
  versionHeading: 'Version {version}',
  stepVersion: 'Version',
  guideRange: 'From {from} to {to}',
};

const de: Texts = {
  siteTitle: 'Dokumentation',
  skipToContent: 'Zum Inhalt springen',
  mainNav: 'Hauptnavigation',
  manuals: 'Anleitungen',
  search: 'Suche',
  searchTitle: 'Die Dokumentation durchsuchen',
  searchIntro:
    'Durchsuchen Sie alle Anleitungen dieser Seite. Filtern Sie die Treffer nach Produkt und Variante.',
  searchNoScript:
    'Die Suche braucht JavaScript. Stöbern Sie stattdessen in den Anleitungen.',
  language: 'Sprache',
  darkMode: 'Dunkler Modus',
  filters: 'Anleitungen filtern',
  product: 'Produkt',
  allProducts: 'Alle Produkte',
  allValues: 'Alle',
  filterByTitle: 'Titel enthält',
  manualCount: { one: '1 Anleitung', other: '{n} Anleitungen' },
  noManuals: 'Es sind noch keine Anleitungen veröffentlicht.',
  noMatch: 'Keine Anleitung passt zu diesen Filtern.',
  variant: 'Variante',
  variants: 'Varianten',
  release: (revision, date) => `Version ${revision}, ${date}`,
  breadcrumb: 'Brotkrumennavigation',
  notFoundTitle: 'Seite nicht gefunden',
  notFoundText:
    'Diese Seite gibt es nicht, oder sie gehört nicht zu dieser Website.',
  backToManuals: 'Zurück zu den Anleitungen',
  startIntro:
    'Betriebs-, Service- und Sicherheitsanleitungen für jedes Produkt, in Ihrer Variante.',
  searchLabel: 'Alle Anleitungen durchsuchen',
  searchPlaceholder: 'Suchen, zum Beispiel „Akku“ oder „Laden“',
  searchShort: 'Anleitungen durchsuchen',
  searchButton: 'Suchen',
  allManuals: 'Alle Anleitungen',
  allOfProduct: 'Alle {n} Anleitungen zu {product}',
  latestRelease: 'Version',
  previous: 'Zurück',
  next: 'Weiter',
  pageOf: 'Seite {n} von {m}',
  pagination: 'Seiten',
  downloadPdf: 'PDF herunterladen',
  pdfSize: 'PDF, {size}',
  products: 'Produkte',
  productSwitch: 'Produkt',
  moreProducts: 'Weitere',
  resultsFor: {
    one: '1 Anleitung passt zu „{q}“',
    other: '{n} Anleitungen passen zu „{q}“',
  },
  passages: { one: '1 Stelle', other: '{n} Stellen' },
  noResults:
    'Nichts passt zu „{q}“. Versuchen Sie ein anderes oder ein kürzeres Wort.',
  searchEmpty:
    'Geben Sie ein Wort ein, um alle Anleitungen dieser Seite zu durchsuchen.',
  searchFailed:
    'Die Suche ließ sich nicht laden. Laden Sie die Seite neu, oder sehen Sie die Anleitungen durch.',
  openContents: 'Inhalt',
  notFoundHint:
    'Vielleicht ist die Adresse vertippt, oder die Anleitung ist mit einer neuen Version umgezogen.',
  searchInstead: 'Die Anleitungen durchsuchen',
  moreVariants: '+{n} weitere',
  filtersShort: 'Filter',
  onlyAs: 'nur als {values}',
  switchNotice: {
    one: '{value} ist nur als {values} veröffentlicht, daher wurde {changes} umgestellt.',
    other:
      '{value} ist nur als {values} veröffentlicht, daher wurden {changes} umgestellt.',
  },
  switchChange: '{attribute} auf {value}',
  dismissNotice: 'Hinweis schließen',
  copyCode: 'Code kopieren',
  copied: 'Kopiert',
  copyFailed: 'Kopieren fehlgeschlagen',
  copyFailedHint:
    'Kopieren fehlgeschlagen. Der Code ist markiert: Strg+C drücken.',
  suggestions: 'Vorschläge',
  suggestionCount: {
    one: '1 Treffer. Wählen Sie ihn mit den Pfeiltasten aus.',
    other: '{n} Treffer. Wählen Sie einen mit den Pfeiltasten aus.',
  },
  noSuggestion: 'Keine Stelle passt zu „{q}“.',
  allResults: 'Alle Treffer für „{q}“',
  searching: 'Suche läuft …',
  updateGuide: 'Update-Leitfaden',
  guideIntro:
    'Wählen Sie die Version, die Sie haben, und die, auf die Sie aktualisieren: Die Checkliste zeigt genau die Schritte für dieses Update.',
  yourUpdate: 'Ihr Update',
  fromVersion: 'Von Version',
  toVersion: 'Auf Version',
  level: 'Stufe',
  yourSetup: 'Ihre Einrichtung',
  notSet: 'Nicht festgelegt',
  phaseBefore: 'Vor dem Update',
  phaseDuring: 'Während des Updates',
  phaseAfter: 'Nach dem Update',
  stepCount: { one: '1 Schritt', other: '{n} Schritte' },
  doneCount: '{done} von {n} erledigt',
  resetChecklist: 'Zurücksetzen',
  resetChecklistLong: 'Checkliste zurücksetzen',
  nothingToChange:
    'Zwischen {from} und {to} ist für diese Einrichtung nichts zu tun.',
  nothingHint:
    'Wählen Sie einen anderen Bereich, eine andere Stufe oder Einrichtung, um deren Schritte zu sehen.',
  invalidChoice:
    'Der Link verlangt eine Auswahl, die dieser Leitfaden nicht anbietet. Er zeigt daher die Standardauswahl.',
  guideNoScript:
    'Ohne JavaScript zeigt diese Seite den ganzen Leitfaden, nach Versionen. Schalten Sie es ein, um Ihre Versionen zu wählen und Schritte abzuhaken.',
  versionHeading: 'Version {version}',
  stepVersion: 'Version',
  guideRange: 'Von {from} auf {to}',
};

/** A count in the build's language, from its `{ one, other }` templates. */
export function countText(
  templates: { readonly one: string; readonly other: string },
  n: number,
  lang: string,
): string {
  return (n === 1 ? templates.one : templates.other).replace(
    '{n}',
    new Intl.NumberFormat(lang).format(n),
  );
}

export const TEXTS: Readonly<Record<'en' | 'de', Texts>> = { en, de };

/** The texts for a build's language: German for `de` and its regional tags, else English. */
export function textsFor(lang: string): Texts {
  return lang.toLowerCase().split('-')[0] === 'de' ? de : en;
}

/** What the typeahead on a search field reads from its form (`data-typeahead`). */
export interface TypeaheadConfig {
  readonly lang: string;
  /** The language's site, where its Pagefind index is. */
  readonly base: string;
  /** The Pagefind meta keys of a page's product and variant. */
  readonly productKey: string;
  readonly variantKey: string;
  readonly label: string;
  readonly count: { readonly one: string; readonly other: string };
  readonly none: string;
  readonly all: string;
  readonly searching: string;
}

export function typeaheadConfig(
  t: Texts,
  lang: string,
  base: string,
): TypeaheadConfig {
  return {
    lang,
    base,
    productKey: t.product,
    variantKey: t.variant,
    label: t.suggestions,
    count: t.suggestionCount,
    none: t.noSuggestion,
    all: t.allResults,
    searching: t.searching,
  };
}

/** Labels joined in the build's language: "A, B and C". */
const joined = (labels: readonly string[], lang: string) =>
  new Intl.ListFormat(lang, { type: 'conjunction' }).format(labels);

/** A variant switch option's hint: "only as Electric and UK". */
export function onlyAsText(
  t: Texts,
  lang: string,
  values: readonly string[],
): string {
  return t.onlyAs.replace('{values}', () => joined(values, lang));
}

/**
 * The notice after a switch that changed other attributes: "Estate is published as Electric
 * only, so Drive changed to Electric." `value` is the label of the value picked, `changes` the
 * other attributes' labels and the values they changed to.
 */
export function switchNoticeText(
  t: Texts,
  lang: string,
  value: string,
  changes: readonly { readonly attribute: string; readonly value: string }[],
): string {
  const template =
    changes.length === 1 ? t.switchNotice.one : t.switchNotice.other;
  // One pass, so a label that holds a placeholder is never filled in again.
  const parts: Record<string, string> = {
    value,
    values: joined(
      changes.map((c) => c.value),
      lang,
    ),
    changes: joined(
      changes.map((c) =>
        t.switchChange.replace(
          /\{(attribute|value)\}/g,
          (_, key: 'attribute' | 'value') => c[key],
        ),
      ),
      lang,
    ),
  };
  return template.replace(
    /\{(value|values|changes)\}/g,
    (_, key: string) => parts[key] ?? '',
  );
}

/** A file size in the build's language (`1.2 MB`). */
export function fileSize(bytes: number, lang: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(lang, {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit < 2 ? 0 : 1,
  }).format(value);
}

/** What the update guide's script needs (`scripts/update-guide.ts`): its texts and language. */
export const guideConfig = (t: Texts, lang: string) => ({
  lang,
  stepCount: t.stepCount,
  doneCount: t.doneCount,
  nothingToChange: t.nothingToChange,
  range: t.guideRange,
});
export type GuideConfig = ReturnType<typeof guideConfig>;

/** A language's name in itself ("Deutsch"), for the language switch. */
export function languageName(lang: string): string {
  try {
    const name = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
    return name === undefined
      ? lang
      : name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    return lang;
  }
}

/** What the code blocks' copy script needs (`scripts/code-copy.ts`). */
export const codeCopyConfig = (t: Texts) => ({
  label: t.copyCode,
  copied: t.copied,
  failed: t.copyFailed,
  failedHint: t.copyFailedHint,
});
