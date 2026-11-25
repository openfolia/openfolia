import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { WEBHOOK_SECRET_PATTERN } from '../webhooks/core/webhook-signature.js';
import { field, text, wholeNumber } from './fields.js';

/** `CCMS_AUDIT_*` defaults (#379). */
export const DEFAULT_AUDIT_SINK_POLL_MS = 3_000;
export const DEFAULT_AUDIT_SINK_TIMEOUT_MS = 10_000;
/** How many days read events are kept (#877). */
export const DEFAULT_AUDIT_READ_KEEP_DAYS = 90;
/** The syslog port for TLS (RFC 5425), when the URL names none. */
export const DEFAULT_SYSLOG_TLS_PORT = 6514;

/** Where the sink delivers, as `CCMS_AUDIT_SINK_URL` names it. */
export type AuditSinkTarget =
  | { readonly kind: 'https'; readonly url: URL }
  | { readonly kind: 'syslog'; readonly host: string; readonly port: number };

/**
 * `CCMS_AUDIT_SINK_URL` read: `https://host[:port]/path[?query]` (no
 * credentials, no fragment) or `syslog+tls://host[:port]` (nothing after
 * the port; 6514 when none). A message (never repeating the value) when
 * it is neither.
 */
export function auditSinkTarget(value: string): AuditSinkTarget | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an https:// or syslog+tls:// URL';
  }
  if (url.username || url.password) return 'must not hold credentials';
  if (url.hash) return 'must not have a fragment';
  if (url.protocol === 'https:') return { kind: 'https', url };
  if (url.protocol === 'syslog+tls:') {
    if ((url.pathname !== '' && url.pathname !== '/') || url.search) {
      return 'a syslog+tls:// URL names a host and port only';
    }
    // `new URL` keeps an IPv6 literal's brackets in `hostname`.
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (host === '' || (host.includes(':') && isIP(host) !== 6)) {
      return 'a syslog+tls:// URL needs a host';
    }
    const port = url.port === '' ? DEFAULT_SYSLOG_TLS_PORT : Number(url.port);
    return { kind: 'syslog', host, port };
  }
  return 'must be an https:// or syslog+tls:// URL';
}

/**
 * The audit log's operator settings (#379): the sink it is copied to as
 * it grows and how long it is kept. Part of `Env`.
 */
export const AuditEnv = z.object({
  /** Where the audit log is delivered: `https://…` or `syslog+tls://host[:port]`; unset: nowhere. */
  CCMS_AUDIT_SINK_URL: field(text.optional()),
  /** The HTTPS sink's signing secret (`whsec_` and 64 hex digits); required with an https:// URL. */
  CCMS_AUDIT_SINK_SECRET: field(
    z
      .string()
      .trim()
      .regex(
        WEBHOOK_SECRET_PATTERN,
        'must be whsec_ and 64 lowercase hex digits',
      )
      .optional(),
  ),
  /** PEM certificates to trust for the sink instead of the system's (an absolute path). */
  CCMS_AUDIT_SINK_CA_FILE: field(
    text
      .refine((value) => isAbsolute(value), 'must be an absolute path')
      .optional(),
  ),
  /** How often new events are delivered, in ms (default 3 s; 0: not on a timer). */
  CCMS_AUDIT_SINK_POLL_MS: field(
    wholeNumber(0, 3_600_000).default(DEFAULT_AUDIT_SINK_POLL_MS),
  ),
  /** One delivery's whole time, in ms (default 10 s, from 1 s to 60 s). */
  CCMS_AUDIT_SINK_TIMEOUT_MS: field(
    wholeNumber(1_000, 60_000).default(DEFAULT_AUDIT_SINK_TIMEOUT_MS),
  ),
  /** How many days events are kept (1 to 36,500); unset: for ever. */
  CCMS_AUDIT_KEEP_DAYS: field(wholeNumber(1, 36_500).optional()),
  /** How many days read events (#877, a service account's reads) are kept (1 to 36,500; default 90). */
  CCMS_AUDIT_READ_KEEP_DAYS: field(
    wholeNumber(1, 36_500).default(DEFAULT_AUDIT_READ_KEEP_DAYS),
  ),
});
export type AuditEnvSettings = z.infer<typeof AuditEnv>;

/** The checks across `CCMS_AUDIT_*`: the URL's form, and the secret an https:// sink needs. */
export function checkAuditEnv(
  env: AuditEnvSettings,
  ctx: z.RefinementCtx,
): void {
  const { CCMS_AUDIT_SINK_URL: value, CCMS_AUDIT_SINK_SECRET: secret } = env;
  if (value === undefined) {
    if (secret !== undefined || env.CCMS_AUDIT_SINK_CA_FILE !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [
          secret !== undefined
            ? 'CCMS_AUDIT_SINK_SECRET'
            : 'CCMS_AUDIT_SINK_CA_FILE',
        ],
        message: 'is set, but CCMS_AUDIT_SINK_URL is not',
      });
    }
    return;
  }
  const target = auditSinkTarget(value);
  if (typeof target === 'string') {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_AUDIT_SINK_URL'],
      message: target,
    });
    return;
  }
  if (target.kind === 'https' && secret === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_AUDIT_SINK_SECRET'],
      message: 'is required with an https:// CCMS_AUDIT_SINK_URL',
    });
  }
}
