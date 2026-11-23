import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  SIGNATURE_HEADER,
  signatureHeader,
} from '../../webhooks/core/webhook-signature.js';
import type { AuditEvent } from '../core/audit-event.js';
import { auditEventJson } from '../core/audit-export.js';
import {
  AuditSink,
  SINK_APP_NAME,
  type SinkResult,
} from '../core/audit-sink.js';

/** The most bytes of the answer's status line and headers read; the body is never read. */
export const MAX_SINK_RESPONSE_HEADER_BYTES = 16 * 1024;

/** What the HTTPS sink needs (`CCMS_AUDIT_SINK_*`). */
export interface HttpsSinkOptions {
  readonly url: URL;
  /** `whsec_…`: the key of the signature (`SIGNATURE_HEADER`). */
  readonly secret: string;
  readonly timeoutMs: number;
  /** Certificates to trust instead of the system's (PEM), for a private CA. */
  readonly ca?: Buffer;
}

/**
 * The sink over HTTPS: each batch is one `POST` of
 * `{"events": [<event>, ...]}` (each event as the JSON export writes it,
 * `id` first, in order) as `application/json`, signed as webhooks are
 * (`SIGNATURE_HEADER`: `t=<unix seconds>,v1=<HMAC-SHA256 hex>` over
 * `<t>.<body>`, keyed with the secret). A 2xx answer is a delivery;
 * anything else, a redirect too (none is followed), is a failure and the
 * batch goes again. The certificate is checked against the URL's host
 * (and `ca` when given). No connection is reused, the whole attempt is
 * cut off after `timeoutMs`, and only the answer's status line is read.
 * The operator sets the URL, so private addresses are allowed (an
 * in-house collector), unlike a webhook's.
 */
export class HttpsAuditSink extends AuditSink {
  now: () => number = Date.now;

  constructor(private readonly options: HttpsSinkOptions) {
    super();
  }

  send(events: readonly AuditEvent[]): Promise<SinkResult> {
    const body = Buffer.from(
      JSON.stringify({ events: events.map(auditEventJson) }),
      'utf8',
    );
    const timestamp = Math.floor(this.now() / 1000);
    const { url, secret, timeoutMs, ca } = this.options;
    return new Promise<SinkResult>((resolve) => {
      let settled = false;
      const done = (result: SinkResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const req = httpsRequest(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            'User-Agent': `${SINK_APP_NAME}-audit-sink`,
            [SIGNATURE_HEADER]: signatureHeader(
              [secret],
              timestamp,
              body.toString('utf8'),
            ),
          },
          agent: false,
          maxHeaderSize: MAX_SINK_RESPONSE_HEADER_BYTES,
          ...(ca && { ca }),
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          // The body is never read.
          res.destroy();
          req.destroy();
          done(
            status >= 200 && status < 300
              ? { ok: true }
              : { ok: false, error: 'http-status', statusCode: status },
          );
        },
      );
      const timer = setTimeout(() => {
        done({ ok: false, error: 'timeout' });
        req.destroy();
      }, timeoutMs);
      req.on('error', () => done({ ok: false, error: 'connection' }));
      req.end(body);
    });
  }
}
