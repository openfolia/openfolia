import type { Readable } from 'node:stream';
import { HttpStatus } from '@nestjs/common';
import busboy from 'busboy';
import type { Request } from 'express';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { UnprocessableError } from '../../base/core/errors.js';
import { tooLarge } from '../../blobs/core/digest.js';

/** The form field the file is sent in. */
export const FILE_FIELD = 'file';

/**
 * Room for the multipart framing around the file (boundaries, the part's
 * headers, a preamble): the request may be at most this much larger than
 * the file, checked on `Content-Length` before reading and on the bytes
 * read (a chunked request has no length).
 */
export const MULTIPART_OVERHEAD = 16 * 1024;

const MULTIPART = 'multipart/form-data';

const invalidBody = (detail: string) =>
  new JsonApiException(HttpStatus.BAD_REQUEST, [
    { code: 'invalid-body', detail },
  ]);

/**
 * A part's `filename` as browsers mean it: the HTML standard has them
 * write `"`, CR and LF as `%22`, `%0D` and `%0A` (and nothing else), so
 * those three are read back; anything else stays as sent.
 */
export function formFileName(sent: string): string {
  return sent.replace(/%(22|0D|0A)/gi, (_, code: string) =>
    String.fromCharCode(parseInt(code, 16)),
  );
}

/** Whether `contentType` is `multipart/form-data` (with whatever parameters). */
export function isMultipartFormData(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === MULTIPART;
}

/**
 * The bytes of the one file of a `multipart/form-data` request, sent in
 * the part named `file`, read from the request as they are iterated: never
 * more than `maxBytes` + 1 of the file, nor all of a request that its
 * `Content-Length` already shows to be too large (422 `too-large`, nothing
 * read). The part's own `Content-Type` is ignored; its file name (as sent,
 * unchecked: the caller makes it a `FileName`) goes to `onFile` before the
 * first byte, decoded as UTF-8, as browsers send it.
 *
 * The end of the file comes only once the whole form is read and found
 * well-formed, so a request cut off or holding anything else (a second
 * file, another field) fails the iteration (400 `invalid-body`), and a
 * consumer that stores only what it iterated to the end stores nothing.
 * Another media type is 415 `unsupported-media-type`. A consumer that stops
 * early (`return()`) stops the reading: the request is unpiped and paused.
 */
export async function* multipartFile(
  req: Request,
  maxBytes: number,
  onFile?: (info: { readonly fileName: string | undefined }) => void,
): AsyncGenerator<Uint8Array> {
  if (!isMultipartFormData(req.headers['content-type'])) {
    throw new JsonApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, [
      {
        code: 'unsupported-media-type',
        detail: `Send the file as ${MULTIPART}, in one file part named "${FILE_FIELD}".`,
      },
    ]);
  }
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes + MULTIPART_OVERHEAD) {
    throw tooLarge(maxBytes);
  }
  // Gone before reading started: its 'close' has passed, and a destroyed
  // request piped into the parser would never end it. `readableEnded`, not
  // `complete`: a request received in full and then destroyed by the
  // client going away has dropped its unread bytes all the same.
  if (req.destroyed && !req.readableEnded) {
    throw invalidBody('The request ended before the form did.');
  }
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      // Browsers send a file name's UTF-8 bytes as they are, not latin1.
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fields: 0,
        // One byte past the limit, so the consumer sees it is too large.
        fileSize: maxBytes + 1,
        headerPairs: 16,
      },
    });
  } catch {
    throw invalidBody(`Not a ${MULTIPART} body with a boundary.`);
  }

  let fail!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // Awaited below (raced), never left unhandled.
  failed.catch(() => undefined);
  const closed = new Promise<void>((resolve) => parser.once('close', resolve));
  let current: Readable | undefined;
  const file = new Promise<Readable>((resolve) => {
    parser.on('file', (name, stream, info) => {
      // At once: a form already read in full can make the stream fail
      // before the loop below listens, which would be an uncaught error.
      // The loop still sees the error (the stream is destroyed with it).
      stream.on('error', () => undefined);
      if (name !== FILE_FIELD) {
        stream.resume();
        fail(invalidBody(`The file goes in the part named "${FILE_FIELD}".`));
        return;
      }
      current = stream;
      onFile?.({
        fileName: info.filename ? formFileName(info.filename) : undefined,
      });
      resolve(stream);
    });
  });
  parser.on('fieldsLimit', () =>
    fail(invalidBody(`The form holds only the file part "${FILE_FIELD}".`)),
  );
  parser.on('filesLimit', () =>
    fail(invalidBody('The form holds one file, not more.')),
  );
  parser.on('error', () =>
    fail(invalidBody(`The ${MULTIPART} body is malformed or cut off.`)),
  );
  parser.once('close', () => {
    if (!current) {
      fail(invalidBody(`The form holds no file part named "${FILE_FIELD}".`));
    }
  });
  // The client went away mid-request: the parser would wait for more
  // bytes for ever, so the file's stream ends with an error instead.
  req.once('close', () => {
    if (req.readableEnded) return;
    const error = invalidBody('The request ended before the form did.');
    fail(error);
    current?.destroy(error);
  });

  // The whole request is bounded too, not only the file: the parser skips
  // a preamble, an epilogue and parts without a form-data disposition.
  let read = 0;
  const onData = (chunk: Buffer) => {
    read += chunk.byteLength;
    if (read <= maxBytes + MULTIPART_OVERHEAD) return;
    const error = tooLarge(maxBytes);
    fail(error);
    req.unpipe(parser);
    current?.destroy(error);
  };
  req.pipe(parser);
  req.on('data', onData);
  try {
    const stream = await Promise.race([failed, file]);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        yield chunk;
      }
    } catch (error) {
      // A cut-off part ends its stream with the parser's error.
      if (
        error instanceof JsonApiException ||
        error instanceof UnprocessableError
      ) {
        throw error;
      }
      throw invalidBody(`The ${MULTIPART} body is malformed or cut off.`);
    }
    if ((stream as Readable & { truncated?: boolean }).truncated) {
      throw tooLarge(maxBytes);
    }
    // `failed` first: of two settled already, a failure wins.
    await Promise.race([failed, closed]);
  } finally {
    req.off('data', onData);
    req.unpipe(parser);
    req.pause();
  }
}
