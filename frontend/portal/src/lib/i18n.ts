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
};

const de: Texts = {
  siteTitle: 'Dokumentation',
  skipToContent: 'Zum Inhalt springen',
  mainNav: 'Hauptnavigation',
  manuals: 'Handbücher',
  search: 'Suche',
  searchTitle: 'Die Dokumentation durchsuchen',
  searchIntro:
    'Durchsuchen Sie alle Handbücher dieser Seite. Filtern Sie die Treffer nach Produkt und Variante.',
  searchNoScript:
    'Die Suche braucht JavaScript. Stöbern Sie stattdessen in den Handbüchern.',
  language: 'Sprache',
  darkMode: 'Dunkler Modus',
  filters: 'Handbücher filtern',
  product: 'Produkt',
  allProducts: 'Alle Produkte',
  allValues: 'Alle',
  filterByTitle: 'Titel enthält',
  manualCount: { one: '1 Handbuch', other: '{n} Handbücher' },
  noManuals: 'Es sind noch keine Handbücher veröffentlicht.',
  noMatch: 'Kein Handbuch passt zu diesen Filtern.',
  variant: 'Variante',
  variants: 'Varianten',
  release: (revision, date) => `Version ${revision}, ${date}`,
  breadcrumb: 'Brotkrumennavigation',
  notFoundTitle: 'Seite nicht gefunden',
  notFoundText:
    'Diese Seite gibt es nicht, oder sie gehört nicht zu dieser Website.',
  backToManuals: 'Zurück zu den Handbüchern',
  startIntro:
    'Betriebs-, Service- und Sicherheitshandbücher für jedes Produkt, in Ihrer Variante.',
  searchLabel: 'Alle Handbücher durchsuchen',
  searchPlaceholder: 'Suchen, zum Beispiel „Akku“ oder „Laden“',
  searchShort: 'Handbücher durchsuchen',
  searchButton: 'Suchen',
  allManuals: 'Alle Handbücher',
  allOfProduct: 'Alle {n} Handbücher zu {product}',
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
    one: '1 Handbuch passt zu „{q}“',
    other: '{n} Handbücher passen zu „{q}“',
  },
  passages: { one: '1 Stelle', other: '{n} Stellen' },
  noResults:
    'Nichts passt zu „{q}“. Versuchen Sie ein anderes oder ein kürzeres Wort.',
  searchEmpty:
    'Geben Sie ein Wort ein, um alle Handbücher dieser Seite zu durchsuchen.',
  searchFailed:
    'Die Suche ließ sich nicht laden. Laden Sie die Seite neu, oder sehen Sie die Handbücher durch.',
  openContents: 'Inhalt',
  notFoundHint:
    'Vielleicht ist die Adresse vertippt, oder das Handbuch ist mit einer neuen Version umgezogen.',
  searchInstead: 'Die Handbücher durchsuchen',
  moreVariants: '+{n} weitere',
  filtersShort: 'Filter',
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
