import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { UnprocessableError } from '../../base/core/errors.js';
import {
  formFileName,
  MULTIPART_OVERHEAD,
  multipartFile,
} from './multipart-file.js';

const BOUNDARY = 'x';
const part = (name: string, data: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="a.png"\r\n\r\n${data}\r\n`;
const end = `--${BOUNDARY}--\r\n`;

/** A request whose body is all written (and ended, unless `open`) before it is read. */
function request(body: string, { open = false, length = true } = {}) {
  const req = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    complete: boolean;
  };
  req.headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    ...(length && { 'content-length': String(Buffer.byteLength(body)) }),
  };
  req.complete = false;
  req.write(body);
  if (!open) {
    req.end();
    req.complete = true;
  }
  return req;
}

async function read(req: PassThrough, maxBytes = 100): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of multipartFile(
    req as unknown as Request,
    maxBytes,
  )) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

/** Lets the stream machinery run before reading starts, as a slow check would. */
const later = () => new Promise((resolve) => setTimeout(resolve, 20));

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JsonApiException) return error.getStatus();
    if (error instanceof UnprocessableError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('multipartFile', () => {
  it('reads the file of a form already read in full', async () => {
    const req = request(part('file', 'PNGDATA') + end);
    await later();
    expect(await read(req)).toBe('PNGDATA');
  });

  it.each([
    ['cut off', part('file', 'PNGDATA').slice(0, -2)],
    ['in a part of another name', part('image', 'PNGDATA') + end],
    ['with a second file', part('file', 'A') + part('file', 'B') + end],
    ['with no file at all', end],
  ])(
    'refuses a form %s, read in full before reading starts, without an uncaught error',
    async (_, body) => {
      const req = request(body);
      await later();
      expect(await status(read(req))).toBe(400);
    },
  );

  it('refuses a request gone before reading starts, instead of waiting for ever', async () => {
    const req = request(part('file', 'PNG'), { open: true });
    req.destroy();
    await later();
    expect(await status(read(req))).toBe(400);
  });

  it('refuses a request received in full, then gone before reading starts', async () => {
    const req = request(part('file', 'PNG') + end, { open: true });
    req.complete = true;
    req.destroy();
    await later();
    expect(await status(read(req))).toBe(400);
  });

  it('ends the read when a request received in full goes while it is read', async () => {
    const req = request(part('file', 'P'.repeat(80)), { open: true });
    req.complete = true;
    const reading = status(read(req));
    await later();
    req.destroy();
    expect(await reading).toBe(400);
  });

  it('ends the read when the request goes while it is read', async () => {
    const req = request(part('file', 'PNG'), { open: true });
    const reading = status(read(req));
    await later();
    req.destroy();
    expect(await reading).toBe(400);
  });

  it('refuses a file past the limit', async () => {
    const req = request(part('file', 'x'.repeat(101)) + end);
    expect(await status(read(req))).toBe('too-large');
  });

  it('bounds the whole request without a Content-Length, skipped parts included', async () => {
    const junk = `--${BOUNDARY}\r\nX-Junk: 1\r\n\r\n${'j'.repeat(1000)}\r\n`;
    const body = junk.repeat(Math.ceil(MULTIPART_OVERHEAD / 1000) + 2);
    const req = request(body + part('file', 'PNG') + end, { length: false });
    expect(await status(read(req))).toBe('too-large');
  });
});

describe('the file name of the part', () => {
  const named = (disposition: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; ${disposition}\r\n\r\nDATA\r\n${end}`;
  const nameOf = async (disposition: string) => {
    let seen: string | undefined = 'not called';
    const req = request(named(disposition));
    for await (const chunk of multipartFile(
      req as unknown as Request,
      100,
      (info) => {
        seen = info.fileName;
      },
    )) {
      void chunk;
    }
    return seen;
  };

  it('is handed on before the bytes, as UTF-8, with a browser’s escapes read back', async () => {
    expect(await nameOf('filename="config.zip"')).toBe('config.zip');
    expect(await nameOf('filename="Übersicht ä.json"')).toBe(
      'Übersicht ä.json',
    );
    expect(await nameOf('filename="a%22b%0Ac%25.txt"')).toBe('a"b\nc%25.txt');
    expect(await nameOf("filename*=UTF-8''%C3%A4.zip")).toBe('ä.zip');
  });

  it('reads back only what the HTML standard escapes', () => {
    expect(formFileName('%22%0d%0A%41%2F')).toBe('"\r\n%41%2F');
  });
});
