import type { TranslationJob } from './translation-job.js';

/** One XLIFF document of a job, as the job file (`TranslationJobFileAction`) makes it. */
export interface ExchangeFile {
  readonly lang: string;
  readonly xliff: string;
}

/** A package a job leaves in, to be downloaded. */
export interface ExchangePackage {
  /** The name it downloads as. */
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * What a returned package says about one XLIFF document in it: the job it belongs to and its
 * languages, as the exchange writes them (`TranslationExchange.languageCode`). The import holds
 * the document to it (`TranslationImportCheck`).
 */
export interface ExchangeEnvelope {
  readonly jobId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** One XLIFF document found in a returned package, not yet decoded. */
export interface ReturnedDocument {
  /** Its path in the package. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly envelope: ExchangeEnvelope;
}

/**
 * How translation jobs travel to a translation management system and back (#140). Today one
 * adapter, COTI level 1 packages by download and upload (`CotiPackageExchange`); an API-based
 * exchange or a watched folder can be added behind it later. The XLIFF itself is always the
 * job file's (#50) and is read back by the translation import (#51): an exchange only wraps and
 * unwraps it.
 */
export abstract class TranslationExchange {
  /** The package of `job` holding `files` (one per target language), made at `at`. */
  abstract pack(
    job: TranslationJob,
    files: readonly ExchangeFile[],
    at: Date,
  ): ExchangePackage;

  /**
   * The XLIFF documents of a returned package, from the files of an uploaded ZIP (read safely
   * already, by path); undefined when the ZIP is no package of this exchange. A package that is
   * one but cannot be read is refused (422 `invalid-coti`, `meta.reason`).
   */
  abstract unpack(
    files: ReadonlyMap<string, Uint8Array>,
  ): ReturnedDocument[] | undefined;

  /** A language tag as the exchange writes it, to compare with an envelope's. */
  abstract languageCode(tag: string): string;
}
