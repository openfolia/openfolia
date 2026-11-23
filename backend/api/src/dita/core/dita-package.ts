import type { DitaExportWarning } from '@openfolia/dita';
import type { ReleaseOutput } from '../../releases/core/release-output.js';

/** The media type a DITA package downloads as: a plain ZIP (DITA names none of its own). */
export const DITA_PACKAGE_MEDIA_TYPE = 'application/zip';

/** Which languages a package holds: the output's (the default), or every one the reader may read the manual in. */
export const DITA_LANGUAGES = ['output', 'all'] as const;
export type DitaLanguages = (typeof DITA_LANGUAGES)[number];

/** How module references are written: as content references (the default), or their content put in. */
export const DITA_REFERENCES = ['conref', 'resolved'] as const;
export type DitaReferences = (typeof DITA_REFERENCES)[number];

/** How a package is asked for, beside its output. */
export interface DitaOptions {
  readonly languages: DitaLanguages;
  readonly references: DitaReferences;
}

/**
 * One file of a package: bytes made for it (a topic, a map, a DITAVAL
 * file, a safety symbol's artwork), a blob of the blob store streamed when
 * its turn comes, or a file of the repository read again when its turn
 * comes (`load`; never held between requests).
 */
export type DitaFile =
  | { readonly name: string; readonly size: number; readonly bytes: Uint8Array }
  | { readonly name: string; readonly size: number; readonly blob: string }
  | {
      readonly name: string;
      readonly size: number;
      readonly load: () => Promise<Uint8Array>;
    };

/**
 * A package as it is made (`DitaPlans`): its files sorted by name, what
 * the export could not say in DITA or left out (`@openfolia/dita`'s warnings),
 * and what it holds. The same output and options always make the same
 * plan, so the same bytes.
 */
export interface DitaPlan {
  readonly files: readonly DitaFile[];
  readonly warnings: readonly DitaExportWarning[];
  /** How many warnings past the report's bound were not kept. */
  readonly warningsDropped: number;
  /** The languages it holds, each a folder. */
  readonly languages: readonly string[];
  /** How many topics (each module once per language) and media files (images, attached files, symbols) it holds. */
  readonly topics: number;
  readonly media: number;
}

/**
 * The name a package downloads as: the output's file name with `-dita`
 * and the ZIP's extension (`operating_model-small_en_2.1-dita.zip`; `all`
 * in place of the language when it holds every one).
 */
export function ditaFileName(
  output: Pick<ReleaseOutput, 'manualId' | 'variant' | 'lang'>,
  revision: string,
  languages: DitaLanguages,
): string {
  const part = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, '-');
  const lang = languages === 'all' ? 'all' : output.lang;
  return `${[output.manualId, output.variant, lang, revision].map(part).join('_')}-dita.zip`;
}
