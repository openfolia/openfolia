import type { OutputLabelSet } from './config.js';

/**
 * The fixed texts an output format (the PDF) prints around the content:
 * safety signal words, admonition captions, the table of contents title,
 * figure and table captions, and the attachment label with the PDF's note
 * that the file is downloaded from the online version, the glossary's
 * title, and an update guide's headings (#906: the word before a version, the three phases). They follow the manual's language, never the
 * reader's interface language.
 */
export const OUTPUT_LABEL_KEYS = [
  'danger',
  'warning',
  'caution',
  'notice',
  'note',
  'tip',
  'important',
  'contents',
  'figure',
  'table',
  'unconverted',
  'attachment',
  'attachmentNote',
  'glossary',
  'updateVersion',
  'updateBefore',
  'updateDuring',
  'updateAfter',
] as const;
export type OutputLabelKey = (typeof OUTPUT_LABEL_KEYS)[number];
export type OutputLabels = Record<OutputLabelKey, string>;

/** The shipped labels. English is complete and the fallback for every key. */
export const DEFAULT_OUTPUT_LABELS: Readonly<
  Record<string, Partial<OutputLabels>> & { en: OutputLabels }
> = {
  en: {
    danger: 'DANGER',
    warning: 'WARNING',
    caution: 'CAUTION',
    notice: 'NOTICE',
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    contents: 'Contents',
    figure: 'Figure',
    table: 'Table',
    unconverted: 'Unconverted content',
    attachment: 'Attachment',
    attachmentNote:
      'Download the file from the online version of this document.',
    glossary: 'Glossary',
    updateVersion: 'Version',
    updateBefore: 'Before the update',
    updateDuring: 'During the update',
    updateAfter: 'After the update',
  },
  de: {
    danger: 'GEFAHR',
    warning: 'WARNUNG',
    caution: 'VORSICHT',
    notice: 'HINWEIS',
    note: 'Hinweis',
    tip: 'Tipp',
    important: 'Wichtig',
    contents: 'Inhalt',
    figure: 'Abbildung',
    table: 'Tabelle',
    unconverted: 'Nicht konvertierter Inhalt',
    attachment: 'Anhang',
    attachmentNote:
      'Die Datei steht in der Online-Ausgabe dieses Dokuments zum Herunterladen bereit.',
    glossary: 'Glossar',
    updateVersion: 'Version',
    updateBefore: 'Vor dem Update',
    updateDuring: 'Während des Updates',
    updateAfter: 'Nach dem Update',
  },
  fr: {
    danger: 'DANGER',
    warning: 'AVERTISSEMENT',
    caution: 'ATTENTION',
    notice: 'AVIS',
    note: 'Remarque',
    tip: 'Conseil',
    important: 'Important',
    contents: 'Table des matières',
    figure: 'Figure',
    table: 'Tableau',
    unconverted: 'Contenu non converti',
    attachment: 'Pièce jointe',
    attachmentNote:
      'Téléchargez le fichier depuis la version en ligne de ce document.',
    glossary: 'Glossaire',
    updateVersion: 'Version',
    updateBefore: 'Avant la mise à jour',
    updateDuring: 'Pendant la mise à jour',
    updateAfter: 'Après la mise à jour',
  },
  ar: {
    danger: 'خطر',
    warning: 'تحذير',
    caution: 'تنبيه',
    notice: 'إشعار',
    note: 'ملاحظة',
    tip: 'نصيحة',
    important: 'هام',
    contents: 'المحتويات',
    figure: 'الشكل',
    table: 'الجدول',
    unconverted: 'محتوى غير محوَّل',
    attachment: 'مرفق',
    attachmentNote: 'نزِّل الملف من النسخة الإلكترونية لهذا المستند.',
    glossary: 'مسرد المصطلحات',
    updateVersion: 'الإصدار',
    updateBefore: 'قبل التحديث',
    updateDuring: 'أثناء التحديث',
    updateAfter: 'بعد التحديث',
  },
  he: {
    danger: 'סכנה',
    warning: 'אזהרה',
    caution: 'זהירות',
    notice: 'הודעה',
    note: 'הערה',
    tip: 'טיפ',
    important: 'חשוב',
    contents: 'תוכן העניינים',
    figure: 'איור',
    table: 'טבלה',
    unconverted: 'תוכן שלא הומר',
    attachment: 'קובץ מצורף',
    attachmentNote: 'הורידו את הקובץ מהגרסה המקוונת של מסמך זה.',
    glossary: 'מילון מונחים',
    updateVersion: 'גרסה',
    updateBefore: 'לפני העדכון',
    updateDuring: 'במהלך העדכון',
    updateAfter: 'אחרי העדכון',
  },
};

export interface ResolvedOutputLabels {
  labels: OutputLabels;
  /** Keys with no label in the language (or its base language): they fell back to English. */
  missing: OutputLabelKey[];
}

/**
 * The labels for a manual language: the configuration's set for the exact
 * tag, then for its base language ("pt" for "pt-BR"), then the shipped
 * defaults in the same order. A key found nowhere falls back to English and
 * is listed in `missing`, so a gap shows as an issue instead of a crash.
 */
export function resolveOutputLabels(
  lang: string,
  configured: Readonly<Record<string, OutputLabelSet>> = {},
): ResolvedOutputLabels {
  const base = lang.split('-')[0] ?? lang;
  const tags = lang === base ? [lang] : [lang, base];
  const sources: Partial<OutputLabels>[] = [
    ...tags.map((tag) => configured[tag] ?? {}),
    ...tags.map((tag) => DEFAULT_OUTPUT_LABELS[tag] ?? {}),
  ];
  const fallback: Partial<OutputLabels>[] = [
    configured['en'] ?? {},
    DEFAULT_OUTPUT_LABELS.en,
  ];
  const labels = {} as OutputLabels;
  const missing: OutputLabelKey[] = [];
  for (const key of OUTPUT_LABEL_KEYS) {
    const own = sources.find((s) => s[key] !== undefined)?.[key];
    if (own === undefined) missing.push(key);
    labels[key] =
      own ?? fallback.find((s) => s[key] !== undefined)?.[key] ?? key;
  }
  return { labels, missing };
}

const SIZE_UNITS = [
  ['petabyte', 1e15],
  ['terabyte', 1e12],
  ['gigabyte', 1e9],
  ['megabyte', 1e6],
  ['kilobyte', 1e3],
] as const;

/**
 * A file size for readers, in the manual's language: decimal units (1 kB
 * is 1,000 bytes), one decimal at most, e.g. `12.3 MB`, `12,3 MB`, `512 bytes`
 * (bytes written out, as the short form is `byte` in English whatever the
 * number, #690). A language tag `Intl` does not know falls back to English.
 * The one way a size is written, in the outputs and in the editor.
 */
export function formatFileSize(bytes: number, lang: string): string {
  const [unit, size] = SIZE_UNITS.find(([, size]) => bytes >= size) ?? [
    'byte',
    1,
  ];
  const options: Intl.NumberFormatOptions = {
    style: 'unit',
    unit,
    unitDisplay: unit === 'byte' ? 'long' : 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  };
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(lang, options);
  } catch {
    format = new Intl.NumberFormat('en', options);
  }
  return format.format(bytes / size);
}
