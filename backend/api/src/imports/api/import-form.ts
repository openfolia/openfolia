import { HttpStatus } from '@nestjs/common';
import { toFileName } from '@openfolia/content-model';
import busboy from 'busboy';
import type { Request } from 'express';
import {
  formFileName,
  isMultipartFormData,
  MULTIPART_OVERHEAD,
} from '../../assets/api/multipart-file.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { tooLarge } from '../../blobs/core/digest.js';
import type { ImportForm } from '../core/actions/create-import.action.js';

/** The form's parts: the file, and the small text fields beside it. */
export const IMPORT_FORM_FIELDS = {
  file: 'file',
  importer: 'importer',
  options: 'options',
  updateExisting: 'updateExisting',
  dryRun: 'dryRun',
  baseRef: 'baseRef',
} as const;

const TEXT_FIELDS = new Set<string>([
  IMPORT_FORM_FIELDS.importer,
  IMPORT_FORM_FIELDS.options,
  IMPORT_FORM_FIELDS.updateExisting,
  IMPORT_FORM_FIELDS.dryRun,
  IMPORT_FORM_FIELDS.baseRef,
]);

/** The longest text field (the options' JSON), in bytes. */
export const MAX_FIELD_BYTES = 16 * 1024;

const MULTIPART = 'multipart/form-data';

const invalidBody = (detail: string, parameter?: string) =>
  new JsonApiException(HttpStatus.BAD_REQUEST, [
    {
      code: 'invalid-body',
      detail,
      ...(parameter !== undefined && { source: { parameter } }),
    },
  ]);

/**
 * Reads an import's `multipart/form-data` upload into memory: one file part
 * named `file` (at most `maxBytes`: past it 422 `too-large`, and reading
 * stops) and the text fields `importer`, `options` (a JSON object),
 * `updateExisting` and `dryRun` (`true` or `false`, default `false`) and
 * `baseRef`, each at most once and `MAX_FIELD_BYTES` long. Anything else
 * (another part, a second file, a field twice, a malformed or cut-off
 * form) is 400 `invalid-body`; another media type is 415. The whole
 * request is bounded too (`maxBytes` plus `MULTIPART_OVERHEAD` and the
 * fields), with or without a `Content-Length`. The part's own
 * `Content-Type` and the file's name decide nothing: the importer reads
 * the bytes.
 */
export async function readImportForm(
  req: Request,
  maxBytes: number,
): Promise<ImportForm> {
  if (!isMultipartFormData(req.headers['content-type'])) {
    throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
      {
        code: 'unsupported-media-type',
        detail: `Send the import as ${MULTIPART}, with the file in a part named "${IMPORT_FORM_FIELDS.file}".`,
      },
    ]);
  }
  const limit =
    maxBytes + MULTIPART_OVERHEAD + TEXT_FIELDS.size * MAX_FIELD_BYTES;
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw tooLarge(maxBytes);
  if (req.destroyed && !req.readableEnded) {
    throw invalidBody('The request ended before the form did.');
  }
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fields: TEXT_FIELDS.size,
        fieldSize: MAX_FIELD_BYTES,
        fieldNameSize: 64,
        fileSize: maxBytes + 1,
        headerPairs: 16,
      },
    });
  } catch {
    throw invalidBody(`Not a ${MULTIPART} body with a boundary.`);
  }

  return new Promise<ImportForm>((resolve, reject) => {
    let settled = false;
    const fields = new Map<string, string>();
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let fileName: string | undefined;
    let sawFile = false;
    let fileDone: Promise<void> = Promise.resolve();
    let read = 0;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      req.off('data', onData);
      req.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      read += chunk.byteLength;
      if (read > limit) fail(tooLarge(maxBytes));
    };

    parser.on('field', (name, value, info) => {
      if (!TEXT_FIELDS.has(name)) {
        fail(invalidBody(`The form has no field "${name}".`, name));
        return;
      }
      if (info.valueTruncated || info.nameTruncated) {
        fail(
          invalidBody(
            `The field "${name}" is longer than ${MAX_FIELD_BYTES} bytes.`,
            name,
          ),
        );
        return;
      }
      if (fields.has(name)) {
        fail(invalidBody(`The field "${name}" is in the form twice.`, name));
        return;
      }
      fields.set(name, value);
    });
    parser.on('file', (name, stream, info) => {
      stream.on('error', () => undefined);
      if (name !== IMPORT_FORM_FIELDS.file) {
        stream.resume();
        fail(
          invalidBody(
            `The file goes in the part named "${IMPORT_FORM_FIELDS.file}".`,
          ),
        );
        return;
      }
      sawFile = true;
      fileName = info.filename ? formFileName(info.filename) : undefined;
      fileDone = new Promise<void>((done) => {
        stream.on('data', (chunk: Buffer) => {
          fileBytes += chunk.byteLength;
          if (fileBytes > maxBytes) {
            fail(tooLarge(maxBytes));
            stream.resume();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          if ((stream as { truncated?: boolean }).truncated) {
            fail(tooLarge(maxBytes));
          }
          done();
        });
      });
    });
    parser.on('fieldsLimit', () =>
      fail(invalidBody('The form holds more fields than an import takes.')),
    );
    parser.on('filesLimit', () =>
      fail(invalidBody('The form holds one file, not more.')),
    );
    parser.on('partsLimit', () =>
      fail(invalidBody('The form holds more parts than an import takes.')),
    );
    parser.on('error', () =>
      fail(invalidBody(`The ${MULTIPART} body is malformed or cut off.`)),
    );
    parser.once('close', () => {
      void fileDone.then(() => {
        if (settled) return;
        if (!sawFile) {
          fail(
            invalidBody(
              `The form holds no file part named "${IMPORT_FORM_FIELDS.file}".`,
            ),
          );
          return;
        }
        try {
          const form = toForm(fields, Buffer.concat(chunks), fileName);
          settled = true;
          req.off('data', onData);
          resolve(form);
        } catch (error) {
          fail(error);
        }
      });
    });
    req.once('close', () => {
      if (!req.readableEnded) {
        fail(invalidBody('The request ended before the form did.'));
      }
    });
    req.on('data', onData);
    req.pipe(parser);
  });
}

function flag(fields: ReadonlyMap<string, string>, name: string): boolean {
  const value = fields.get(name);
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw invalidBody(`The field "${name}" is "true" or "false".`, name);
}

function toForm(
  fields: ReadonlyMap<string, string>,
  bytes: Buffer,
  sentName: string | undefined,
): ImportForm {
  let options: unknown;
  const rawOptions = fields.get(IMPORT_FORM_FIELDS.options);
  if (rawOptions !== undefined) {
    try {
      options = JSON.parse(rawOptions);
    } catch {
      options = undefined;
    }
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    ) {
      throw invalidBody(
        'The field "options" is a JSON object.',
        IMPORT_FORM_FIELDS.options,
      );
    }
  }
  const importerId = fields.get(IMPORT_FORM_FIELDS.importer);
  const baseRef = fields.get(IMPORT_FORM_FIELDS.baseRef);
  if (baseRef !== undefined && (baseRef.length === 0 || baseRef.length > 256)) {
    throw invalidBody(
      'The field "baseRef" names a branch (1 to 256 characters).',
      IMPORT_FORM_FIELDS.baseRef,
    );
  }
  const fileName = sentName === undefined ? undefined : toFileName(sentName);
  return {
    file: {
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ...(fileName !== undefined && { fileName }),
    },
    ...(importerId !== undefined && { importerId }),
    ...(options !== undefined && { options }),
    updateExisting: flag(fields, IMPORT_FORM_FIELDS.updateExisting),
    dryRun: flag(fields, IMPORT_FORM_FIELDS.dryRun),
    ...(baseRef !== undefined && { baseRef }),
  };
}
