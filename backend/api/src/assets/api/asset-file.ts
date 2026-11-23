import { Logger, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { JSON_API } from '../../base/api/json-api.js';
import type { Asset } from '../core/actions/get-asset.action.js';

const logger = new Logger('Assets');

/** Shown in place; any other stored type is sent as a download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
]);

/**
 * `Content-Disposition: attachment` with the file name: an ASCII
 * `filename` (anything else as `_`), which every client reads, and the
 * name itself as `filename*` (RFC 8187: UTF-8, percent-encoded), which
 * current ones prefer. Nothing of the name reaches the header unencoded,
 * so it can never end the header, add a parameter or another header.
 */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  // A lone surrogate (which `FileName` refuses) would make encoding throw.
  const encoded = encodeURIComponent(fileName.toWellFormed()).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * A file as the response, for `GET /assets/:hash` and a change set's own
 * uploads: its stored type and length, `X-Content-Type-Options: nosniff`
 * and a sandboxing `Content-Security-Policy` (an SVG never runs scripts).
 * An attachment (`asset.download`) is always a download under its file
 * name (else the hash); otherwise an image type is shown in place and
 * anything else is a download. A store failing mid-stream cuts the
 * connection when part of it went out, else answers 503
 * `blob-store-unavailable`. Caching is the caller's.
 */
export function assetFile(
  asset: Asset,
  hash: string,
  res: Response,
): StreamableFile {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  return new StreamableFile(asset.stream, {
    type: asset.type,
    length: asset.size,
    disposition:
      asset.download === undefined && INLINE_TYPES.has(asset.type)
        ? 'inline'
        : attachmentDisposition(asset.download?.fileName ?? hash),
  }).setErrorHandler((error) => {
    logger.error(`Asset ${hash} failed while streaming: ${error.message}`);
    if (res.headersSent) {
      // Part of it went out: cut the connection, so no client keeps a short body.
      res.destroy();
      return;
    }
    // Nothing went out yet: a 503 like any unavailable store, never cacheable.
    for (const name of ['Content-Length', 'Content-Disposition', 'ETag']) {
      res.removeHeader(name);
    }
    res
      .status(503)
      .set({
        'Content-Type': JSON_API,
        'Cache-Control': 'no-store',
        'Retry-After': '5',
      })
      // end(), not send(): the media type stays exactly JSON:API's (no charset).
      .end(
        JSON.stringify({
          errors: [
            {
              status: '503',
              title: 'Service Unavailable',
              code: 'blob-store-unavailable',
              detail: 'The blob store does not answer.',
              meta: { retryAfter: 5 },
            },
          ],
        }),
      );
  });
}
