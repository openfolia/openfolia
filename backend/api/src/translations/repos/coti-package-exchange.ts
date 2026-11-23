import {
  COTI_FILE,
  COTI_TRANSLATION_FOLDER,
  CotiReadError,
  type CotiRefusal,
  cotiLanguage,
  cotiName,
  cotiProjectFolder,
  cotiTimestamp,
  type ReadCoti,
  readCoti,
  writeCoti,
  XLIFF_MEDIA_TYPE,
} from '@openfolia/xliff';
import { Injectable } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { UnprocessableError } from '../../base/core/errors.js';
import { DEFAULT_PRODUCT_NAME } from '../../branding/core/branding.js';
import {
  type ExchangeFile,
  type ExchangePackage,
  type ReturnedDocument,
  TranslationExchange,
} from '../core/translation-exchange.js';
import type { ExportSubject, TranslationJob } from '../core/translation-job.js';

/** Why a package is refused (`meta.reason` of 422 `invalid-coti`), beside a `COTI.xml`'s own. */
export type CotiPackageRefusal =
  | CotiRefusal
  | 'duplicate-description'
  | 'no-job'
  | 'missing-file'
  | 'duplicate-file'
  | 'unsupported-file';

/** The longest `COTI.xml` decoded at all, in bytes (its reader takes 1 Mi characters). */
const MAX_DESCRIPTION_BYTES = 4 * 1024 * 1024;

const XLIFF_FILE = /\.(xlf|xliff)$/i;

const refuse = (
  reason: CotiPackageRefusal,
  detail: string,
  path?: string,
): UnprocessableError =>
  new UnprocessableError('invalid-coti', detail, {
    reason,
    ...(path !== undefined && { path }),
  });

/** What a job sends, in a line (`<subject>`). */
function subjectLine(subject: ExportSubject): string {
  switch (subject.type) {
    case 'manual':
      return `Manual ${subject.manualId}`;
    case 'modules':
      return subject.moduleIds.length === 1
        ? `Module ${subject.moduleIds[0]}`
        : `${subject.moduleIds.length} modules`;
    case 'folder':
      return `Folder ${subject.folder}`;
    case 'designs':
      return subject.designIds.length === 1
        ? `Page design ${subject.designIds[0]}`
        : `${subject.designIds.length} page designs`;
    case 'manuals':
      return subject.manualIds.length === 1
        ? `Manual text of ${subject.manualIds[0]}`
        : `Manual text of ${subject.manualIds.length} manuals`;
    case 'config':
      return 'Project labels';
  }
}

/** The day a job is due, as `xs:dateTime`: its start, in UTC. */
const dueDateOf = (day: string | null) =>
  day === null ? undefined : new Date(`${day}T00:00:00Z`);

/**
 * COTI level 1 packages by download and upload (#140). A job leaves as one ZIP
 * (`<timestamp>_translation-<jobId>.coti`) holding one translation project per target
 * language, in a folder `<project-id>_<source>_<target>`, each with its `COTI.xml` and its XLIFF
 * in `translation files/` (the name the job file gives it). In `COTI.xml`: `package-id` the job,
 * `project-id` `<jobId>-<lang>`, `checkout-date` the export's time, `due-date` the job's due day,
 * the subject in a line, `<meta>` `job`, `ref` and `commit`, the languages as COTI codes
 * (`cotiLanguage`), `status="none"`.
 *
 * A package comes back as the translation system made it from that: the projects' folders and
 * file names kept, `COTI.xml` with its `tms-id` and `status` set, reference files maybe added
 * (never read). The import reads every `COTI.xml` at a project folder's top (or the package's)
 * and the translation files it lists, nothing else; the job is its `package-id` (or its `job`
 * meta entry).
 */
@Injectable()
export class CotiPackageExchange extends TranslationExchange {
  pack(
    job: TranslationJob,
    files: readonly ExchangeFile[],
    at: Date,
  ): ExchangePackage {
    const sourceLanguage = cotiLanguage(job.sourceLang);
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
      const targetLanguage = cotiLanguage(file.lang);
      const projectId = `${job.id}-${cotiName(file.lang)}`;
      const folder = cotiProjectFolder({
        projectId,
        sourceLanguage,
        targetLanguage,
      });
      const fileRef = `${COTI_TRANSLATION_FOLDER}/translation-${job.id}-${cotiName(file.lang)}.xlf`;
      const dueDate = dueDateOf(job.dueDate);
      entries[`${folder}/${COTI_FILE}`] = strToU8(
        writeCoti({
          creator: DEFAULT_PRODUCT_NAME,
          creationDate: at,
          packageId: job.id,
          name: `Translation job ${job.id}`,
          projectId,
          checkoutDate: job.createdAt,
          ...(dueDate && { dueDate }),
          subject: subjectLine(job.subject),
          meta: [
            { name: 'job', value: job.id },
            { name: 'ref', value: job.ref },
            { name: 'commit', value: job.commit },
          ],
          translationName: `translation-${job.id}-${file.lang}`,
          sourceLanguage,
          targetLanguage,
          status: 'none',
          files: [
            {
              fileRef,
              mimeType: XLIFF_MEDIA_TYPE,
              encoding: 'UTF-8',
              creationDate: at,
            },
          ],
        }),
      );
      entries[`${folder}/${fileRef}`] = strToU8(file.xliff);
    }
    return {
      fileName: `${cotiTimestamp(at)}_translation-${job.id}.coti`,
      mediaType: 'application/zip',
      bytes: zipSync(entries, { level: 6 }),
    };
  }

  unpack(
    files: ReadonlyMap<string, Uint8Array>,
  ): ReturnedDocument[] | undefined {
    const descriptions = [...files.keys()]
      .filter((path) => {
        const segments = path.split('/');
        return (
          segments.length <= 2 &&
          segments.at(-1)?.toLowerCase() === COTI_FILE.toLowerCase()
        );
      })
      .sort();
    if (descriptions.length === 0) return undefined;
    const folders = new Set<string>();
    const taken = new Set<string>();
    const documents: ReturnedDocument[] = [];
    for (const path of descriptions) {
      const folder = path.slice(0, path.lastIndexOf('/') + 1);
      if (folders.has(folder)) {
        throw refuse(
          'duplicate-description',
          `The folder "${folder}" holds more than one project description.`,
          path,
        );
      }
      folders.add(folder);
      const coti = read(path, files.get(path) as Uint8Array);
      const named = coti.meta['job'];
      if (
        coti.packageId !== undefined &&
        named !== undefined &&
        named !== coti.packageId
      ) {
        throw new UnprocessableError(
          'coti-job-mismatch',
          `${path} names two translation jobs (its package-id and its job meta entry).`,
          { path },
        );
      }
      const jobId = coti.packageId ?? named;
      if (jobId === undefined) {
        throw refuse(
          'no-job',
          `${path} names no translation job (its package-id).`,
          path,
        );
      }
      for (const { fileRef, mimeType } of coti.files) {
        const filePath = `${folder}${fileRef}`;
        if (!XLIFF_FILE.test(fileRef) && !/xliff/i.test(mimeType)) {
          throw refuse(
            'unsupported-file',
            `${path} lists "${fileRef}" (${mimeType}) to translate; a package holds XLIFF files only.`,
            filePath,
          );
        }
        const bytes = files.get(filePath);
        if (bytes === undefined) {
          throw refuse(
            'missing-file',
            `${path} lists "${fileRef}", which the package does not hold.`,
            filePath,
          );
        }
        if (taken.has(filePath)) {
          throw refuse(
            'duplicate-file',
            `"${filePath}" is listed twice.`,
            filePath,
          );
        }
        taken.add(filePath);
        documents.push({
          path: filePath,
          bytes,
          envelope: {
            jobId,
            sourceLanguage: coti.sourceLanguage,
            targetLanguage: coti.targetLanguage,
          },
        });
      }
    }
    return documents;
  }

  /** A malformed tag (an uploaded XLIFF's `srcLang` is not validated first) is returned unchanged, so it matches no COTI code. */
  languageCode(tag: string): string {
    try {
      return cotiLanguage(tag);
    } catch (error) {
      if (error instanceof RangeError) return tag;
      throw error;
    }
  }
}

/** A `COTI.xml` read strictly; refused as 422 `invalid-coti` with the reader's reason. */
function read(path: string, bytes: Uint8Array): ReadCoti {
  if (bytes.byteLength > MAX_DESCRIPTION_BYTES) {
    throw refuse(
      'too-large',
      `${path} is too large for a project description.`,
      path,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse('unsupported-encoding', `${path} is not UTF-8 text.`, path);
  }
  try {
    return readCoti(text);
  } catch (error) {
    if (error instanceof CotiReadError) {
      throw refuse(error.reason, `${path}: ${error.message}`, path);
    }
    throw error;
  }
}
