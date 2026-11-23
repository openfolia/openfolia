import { strFromU8, strToU8, zipSync } from 'fflate';
import {
  type ExchangeEnvelope,
  type ExchangeFile,
  type ExchangePackage,
  type ReturnedDocument,
  TranslationExchange,
} from '../../src/translations/core/translation-exchange.js';
import type { TranslationJob } from '../../src/translations/core/translation-job.js';

/** The fake package's own description, at its top: each document's path with its envelope. */
export const FAKE_ENVELOPES = 'envelopes.json';

/**
 * A translation exchange in memory: a ZIP with one `<lang>.xlf` per file and `envelopes.json`
 * describing them (the job, the languages as they are). A ZIP without that file is no package.
 */
export class FakeTranslationExchange extends TranslationExchange {
  readonly packed: { job: TranslationJob; files: ExchangeFile[]; at: Date }[] =
    [];

  pack(
    job: TranslationJob,
    files: readonly ExchangeFile[],
    at: Date,
  ): ExchangePackage {
    this.packed.push({ job, files: [...files], at });
    const envelopes: Record<string, ExchangeEnvelope> = {};
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
      envelopes[`${file.lang}.xlf`] = {
        jobId: job.id,
        sourceLanguage: job.sourceLang,
        targetLanguage: file.lang,
      };
      entries[`${file.lang}.xlf`] = strToU8(file.xliff);
    }
    entries[FAKE_ENVELOPES] = strToU8(JSON.stringify(envelopes));
    return {
      fileName: `job-${job.id}.pkg`,
      mediaType: 'application/zip',
      bytes: zipSync(entries),
    };
  }

  unpack(
    files: ReadonlyMap<string, Uint8Array>,
  ): ReturnedDocument[] | undefined {
    const described = files.get(FAKE_ENVELOPES);
    if (!described) return undefined;
    const envelopes = JSON.parse(strFromU8(described)) as Record<
      string,
      ExchangeEnvelope
    >;
    return Object.entries(envelopes).map(([path, envelope]) => ({
      path,
      bytes: files.get(path) ?? new Uint8Array(),
      envelope,
    }));
  }

  languageCode(tag: string): string {
    return tag;
  }
}

/** A package as `FakeTranslationExchange` reads it: `docs` by path, with their envelopes. */
export function fakePackage(
  docs: Record<string, { xliff: string; envelope: ExchangeEnvelope }>,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const envelopes: Record<string, ExchangeEnvelope> = {};
  for (const [path, { xliff, envelope }] of Object.entries(docs)) {
    entries[path] = strToU8(xliff);
    envelopes[path] = envelope;
  }
  entries[FAKE_ENVELOPES] = strToU8(JSON.stringify(envelopes));
  return zipSync(entries);
}
