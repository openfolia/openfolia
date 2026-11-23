import { HttpStatus } from '@nestjs/common';
import busboy from 'busboy';
import type { Request } from 'express';
import {
  isMultipartFormData,
  MULTIPART_OVERHEAD,
} from '../../assets/api/multipart-file.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { tooLarge } from '../../blobs/core/digest.js';
import type { TranslationImportForm } from '../core/actions/translation-imports.action.js';

/** The form's parts: the file, and the small text fields beside it. */
export const FIELDS = {
  file: 'file',
  dryRun: 'dryRun',
  baseRef: 'baseRef',
} as const;

const TEXT_FIELDS = new Set<string>([FIELDS.dryRun, FIELDS.baseRef]);

/** The longest text field, in bytes. */
const MAX_FIELD_BYTES = 1024;

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
 * Reads a translation import's `multipart/form-data` upload into memory:
 * one file part named `file` (an XLIFF document or a ZIP of them, at most
 * `maxBytes`: past it 422 `too-large`, and reading stops) and the text
 * fields `dryRun` (`true`, the only value: applying is its own route) and
 * `baseRef`, each at most once. Anything else (another part, a second
 * file, a field twice, a malformed or cut-off form) is 400 `invalid-body`;
 * another media type is 415. The whole request is bounded too. The part's
 * own `Content-Type` and the file's name decide nothing: the bytes do.
 */
export async function readTranslationImportForm(
  req: Request,
  maxBytes: number,
): Promise<TranslationImportForm> {
  if (!isMultipartFormData(req.headers['content-type'])) {
    throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
      {
        code: 'unsupported-media-type',
        detail: `Send the import as ${MULTIPART}, with the file in a part named "${FIELDS.file}".`,
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

  return new Promise<TranslationImportForm>((resolve, reject) => {
    let settled = false;
    const fields = new Map<string, string>();
    const chunks: Buffer[] = [];
    let fileBytes = 0;
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
    parser.on('file', (name, stream) => {
      stream.on('error', () => undefined);
      if (name !== FIELDS.file) {
        stream.resume();
        fail(invalidBody(`The file goes in the part named "${FIELDS.file}".`));
        return;
      }
      sawFile = true;
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
      fail(
        invalidBody(
          'The form holds more fields than a translation import takes.',
        ),
      ),
    );
    parser.on('filesLimit', () =>
      fail(invalidBody('The form holds one file, not more.')),
    );
    parser.on('partsLimit', () =>
      fail(
        invalidBody(
          'The form holds more parts than a translation import takes.',
        ),
      ),
    );
    parser.on('error', () =>
      fail(invalidBody(`The ${MULTIPART} body is malformed or cut off.`)),
    );
    parser.once('close', () => {
      void fileDone.then(() => {
        if (settled) return;
        if (!sawFile) {
          fail(
            invalidBody(`The form holds no file part named "${FIELDS.file}".`),
          );
          return;
        }
        try {
          const form = toForm(fields, Buffer.concat(chunks));
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

function toForm(
  fields: ReadonlyMap<string, string>,
  bytes: Buffer,
): TranslationImportForm {
  const dryRun = fields.get(FIELDS.dryRun);
  if (dryRun !== undefined && dryRun !== 'true') {
    throw invalidBody(
      'The field "dryRun" is "true": an upload is always validated first, and applied with POST /translations/imports/{importId}/apply.',
      FIELDS.dryRun,
    );
  }
  const baseRef = fields.get(FIELDS.baseRef);
  if (baseRef !== undefined && (baseRef.length === 0 || baseRef.length > 256)) {
    throw invalidBody(
      'The field "baseRef" names a branch (1 to 256 characters).',
      FIELDS.baseRef,
    );
  }
  return {
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ...(baseRef !== undefined && { baseRef }),
  };
}
