import { escapeHtml } from '@openfolia/render-html';
import type { Preview } from '../../preview/core/actions/preview-manual.action.js';

/**
 * The texts of the pages a stable address shows instead of a manual (#450): a withdrawn
 * release's notice and the language picker. A reader who follows a printed address has no
 * editor around them, so the page speaks their language: the manual's, else English.
 */
interface ReaderTexts {
  readonly withdrawnTitle: string;
  readonly withdrawn: (revision: string) => string;
  readonly latest: string;
  readonly noLatest: string;
  readonly pickerTitle: string;
  readonly picker: string;
}

const TEXTS: Readonly<Record<string, ReaderTexts>> = {
  en: {
    withdrawnTitle: 'This version was withdrawn',
    withdrawn: (revision) =>
      `Version ${revision} of this manual was withdrawn and is no longer valid.`,
    latest: 'Open the current version',
    noLatest: 'There is no current version to open.',
    pickerTitle: 'Choose a language',
    picker:
      'This manual is not available in the language asked for. It is available in:',
  },
  de: {
    withdrawnTitle: 'Diese Version wurde zurückgezogen',
    withdrawn: (revision) =>
      `Version ${revision} dieser Anleitung wurde zurückgezogen und ist nicht mehr gültig.`,
    latest: 'Aktuelle Version öffnen',
    noLatest: 'Es gibt keine aktuelle Version.',
    pickerTitle: 'Sprache wählen',
    picker:
      'Diese Anleitung gibt es nicht in der gewünschten Sprache. Sie ist verfügbar in:',
  },
  fr: {
    withdrawnTitle: 'Cette version a été retirée',
    withdrawn: (revision) =>
      `La version ${revision} de ce manuel a été retirée et n’est plus valable.`,
    latest: 'Ouvrir la version actuelle',
    noLatest: 'Il n’existe pas de version actuelle.',
    pickerTitle: 'Choisir une langue',
    picker:
      'Ce manuel n’est pas disponible dans la langue demandée. Il est disponible en :',
  },
};

/** The texts for `lang` (its primary subtag), English when there are none. */
export function readerTexts(lang: string): ReaderTexts & { lang: string } {
  const primary = lang.toLowerCase().split('-')[0] ?? 'en';
  const texts = TEXTS[primary];
  return texts
    ? { ...texts, lang }
    : { ...(TEXTS['en'] as ReaderTexts), lang: 'en' };
}

/** A language's own name for itself ("Deutsch"); the tag when the runtime knows none. */
export function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name && name !== tag
      ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
      : tag;
  } catch {
    return tag;
  }
}

/** The withdrawn release's notice, as a page (`pageHtml`), linking `latest` if there is one. */
export function withdrawnPage(input: {
  readonly title: string;
  readonly lang: string;
  readonly revision: string;
  /** The current version's link, relative to the page; undefined: none. */
  readonly latest: string | undefined;
}): Preview {
  const t = readerTexts(input.lang);
  const link =
    input.latest === undefined
      ? `<p>${escapeHtml(t.noLatest)}</p>`
      : `<p><a href="${escapeHtml(input.latest)}">${escapeHtml(t.latest)}</a></p>`;
  return {
    title: `${t.withdrawnTitle}: ${input.title}`,
    lang: t.lang,
    // The notice's own texts (English, German or French): left to right; the manual's
    // title and a language's own name take theirs (`dir="auto"`).
    dir: 'ltr',
    issueCount: 0,
    html: [
      '<main class="openfolia-notice">',
      `<h1>${escapeHtml(t.withdrawnTitle)}</h1>`,
      `<p><strong dir="auto">${escapeHtml(input.title)}</strong></p>`,
      `<p>${escapeHtml(t.withdrawn(input.revision))}</p>`,
      link,
      '</main>',
    ].join('\n'),
  };
}

/** The language picker, as a page: a link per language the reader may read the manual in. */
export function pickerPage(input: {
  readonly title: string;
  readonly lang: string;
  readonly languages: readonly {
    readonly lang: string;
    readonly href: string;
  }[];
}): Preview {
  const t = readerTexts(input.lang);
  return {
    title: `${t.pickerTitle}: ${input.title}`,
    lang: t.lang,
    // The notice's own texts (English, German or French): left to right; the manual's
    // title and a language's own name take theirs (`dir="auto"`).
    dir: 'ltr',
    issueCount: 0,
    html: [
      '<main class="openfolia-notice">',
      `<h1 dir="auto">${escapeHtml(input.title)}</h1>`,
      `<p>${escapeHtml(t.picker)}</p>`,
      '<ul>',
      ...input.languages.map(
        (l) =>
          `<li><a href="${escapeHtml(l.href)}" hreflang="${escapeHtml(l.lang)}" lang="${escapeHtml(l.lang)}" dir="auto">${escapeHtml(languageName(l.lang))}</a></li>`,
      ),
      '</ul>',
      '</main>',
    ].join('\n'),
  };
}
