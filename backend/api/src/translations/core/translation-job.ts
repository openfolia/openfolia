import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import {
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';

/**
 * Where a translation job stands: `sent` to the provider (its units are
 * `at-provider`), `returned` (the import, #51, read it back) or
 * `cancelled`.
 */
export const TRANSLATION_JOB_STATES = [
  'sent',
  'returned',
  'cancelled',
] as const;
export type TranslationJobState = (typeof TRANSLATION_JOB_STATES)[number];

/**
 * What an export covers, in the source language: the modules a manual
 * includes (also through module references), a list of modules, or a
 * folder of the content browser (`<type>` or `<type>/<facet value>`), or
 * page designs (#568: their region text; a manual's subject takes its design
 * too), or manuals' own text (#656: a manual's subject takes it too), or the project labels
 * (#731: a manual's subject takes them too, as its title page shows them). A job unit of a
 * design has the design's key (`designKey`) as its `moduleId` and its unit key
 * (`<slot>.<block>`) as its `blockId`; one of a manual its key (`manualKey`) and its unit key
 * (`title`, `group.…`, `coverImage.…`); one of the labels `config.project` (`CONFIG_KEY`) and
 * its unit key (`ConfigUnitKey`).
 */
export type ExportSubject =
  | { readonly type: 'manual'; readonly manualId: string }
  | { readonly type: 'modules'; readonly moduleIds: readonly string[] }
  | { readonly type: 'folder'; readonly folder: string }
  /** Page designs' region text (#568); a manual's design goes with the manual. */
  | { readonly type: 'designs'; readonly designIds: readonly string[] }
  /** Manuals' own text (#656: their cover images' alternative text); a manual's goes with it. */
  | { readonly type: 'manuals'; readonly manualIds: readonly string[] }
  /** The project labels in `openfolia.yaml` (#731); a manual's subject takes them too. */
  | { readonly type: 'config' };

/** One block of one module, in one target language, sent in a job. */
export interface TranslationJobUnit {
  readonly lang: string;
  readonly moduleId: string;
  readonly blockId: string;
  /** The source hash of the block's text as exported. */
  readonly sourceHash: string;
  /** Its words in the source language (`wordCount`). */
  readonly words: number;
}

/** How much a job holds: distinct modules, units (block × language) and their words. */
export interface ExportCounts {
  readonly modules: number;
  readonly units: number;
  readonly words: number;
}

/** The counts of one language of a job. */
export interface LanguageCounts extends ExportCounts {
  readonly lang: string;
}

/**
 * A delta translation export (#50): the blocks whose source changed since
 * they were last translated, per target language, sent to a provider.
 */
export interface TranslationJob {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  /** The source language, as configured at the export. */
  readonly sourceLang: string;
  /** The target languages, in the configured order. */
  readonly languages: readonly string[];
  readonly subject: ExportSubject;
  /** The ref exported, as asked for. */
  readonly ref: string;
  /** The commit it resolved to: the files are always made from it. */
  readonly commit: string;
  /**
   * Whether `commit` was released content (`main` or a tag) when it was
   * exported: then the job's files are read with `content.read`, even once
   * `main` has moved on.
   */
  readonly released: boolean;
  /** The day the translation is due (`YYYY-MM-DD`); null for none. */
  readonly dueDate: string | null;
  readonly state: TranslationJobState;
  readonly createdBy: ChangeSetAuthor;
  readonly createdAt: Date;
  /** Totals over every language. */
  readonly counts: ExportCounts;
  /** Per language, in the order of `languages`. */
  readonly perLanguage: readonly LanguageCounts[];
}

/** A new job's ID: a UUID version 7. */
export const newTranslationJobId = newChangeSetId;
export const isTranslationJobId = isChangeSetId;

/** The counts of `units`, in total and per language (in `languages`' order). */
export function countUnits(
  languages: readonly string[],
  units: readonly Pick<TranslationJobUnit, 'lang' | 'moduleId' | 'words'>[],
): { counts: ExportCounts; perLanguage: LanguageCounts[] } {
  const count = (
    list: readonly Pick<TranslationJobUnit, 'moduleId' | 'words'>[],
  ): ExportCounts => ({
    modules: new Set(list.map((u) => u.moduleId)).size,
    units: list.length,
    words: list.reduce((sum, u) => sum + u.words, 0),
  });
  return {
    counts: count(units),
    perLanguage: languages.map((lang) => ({
      lang,
      ...count(units.filter((u) => u.lang === lang)),
    })),
  };
}
