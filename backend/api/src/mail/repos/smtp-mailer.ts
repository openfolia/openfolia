import { isIP } from 'node:net';
import { createTransport } from 'nodemailer';
import type { MailServer } from '../../config/mail-env.js';
import type { RenderedMail } from '../core/mail.js';
import {
  type MailErrorKind,
  Mailer,
  MailSendError,
} from '../core/mail-ports.js';

/** How the adapter connects; the password is held here only, never logged. */
export interface SmtpOptions {
  readonly server: MailServer;
  /** On `smtp://`: STARTTLS or nothing (`CCMS_MAIL_REQUIRE_TLS`). */
  readonly requireTls: boolean;
  readonly auth: { readonly user: string; readonly pass: string } | null;
  /** Certificate authorities to trust in place of the system's (`CCMS_MAIL_CA_FILE`), PEM. */
  readonly ca?: string;
}

/** A connection's time limits, in ms: well inside the job's two minutes. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
} as const;

/** TLS errors of Node's own (a certificate that does not verify, a handshake that fails). */
const TLS_CODES =
  /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(GET|VERIFY)_|HOSTNAME_MISMATCH)/;

/** The domain of a `Message-ID`: the sender's (an address `isMailAddress` checked). */
function messageIdDomain(from: string): string {
  return from.slice(from.lastIndexOf('@') + 1);
}

/** What kind of failure an error from nodemailer is, by its code and reply code only. */
export function classify(error: unknown): MailSendError {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'unknown';
  const reply = typeof e.responseCode === 'number' ? e.responseCode : null;
  let kind: MailErrorKind = 'unavailable';
  if (code === 'EAUTH' || code === 'ENOAUTH') kind = 'auth';
  else if (code === 'ETLS' || TLS_CODES.test(code)) kind = 'tls';
  else if (reply !== null && reply >= 500 && reply < 600) kind = 'rejected';
  return new MailSendError(kind, reply !== null ? `${code} ${reply}` : code);
}

/**
 * `Mailer` over SMTP with nodemailer (#609). TLS: `smtps://` from the first byte; on `smtp://`
 * STARTTLS, required unless `CCMS_MAIL_REQUIRE_TLS=false` (then used when offered). The
 * certificate is always verified, against the host's name, TLS 1.2 at least: there is no
 * setting to skip it, only `CCMS_MAIL_CA_FILE` for a private authority. With TLS required,
 * nothing (no sign-in, no address) goes out before the upgrade. A message refers to no file or
 * URL (`disableFileAccess`, `disableUrlAccess`): its one image is in it. One connection per
 * email.
 */
export class SmtpMailer extends Mailer {
  private readonly transport: ReturnType<typeof createTransport>;

  constructor(options: SmtpOptions) {
    super();
    const { host, port, implicitTls } = options.server;
    this.transport = createTransport({
      host,
      port,
      secure: implicitTls,
      requireTLS: !implicitTls && options.requireTls,
      ignoreTLS: false,
      ...(options.auth && {
        auth: { user: options.auth.user, pass: options.auth.pass },
      }),
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ...(isIP(host) === 0 && { servername: host }),
        ...(options.ca !== undefined && { ca: options.ca }),
      },
      ...SMTP_TIMEOUTS,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }

  async send(mail: RenderedMail, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new MailSendError('unavailable', 'EABORT');
    try {
      await this.transport.sendMail({
        from: { name: mail.from.name, address: mail.from.address },
        to: mail.to.name
          ? { name: mail.to.name, address: mail.to.address }
          : mail.to.address,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: mail.images.map((image) => ({
          cid: image.cid,
          filename: image.filename,
          content: image.content,
          contentType: image.contentType,
          contentDisposition: 'inline' as const,
        })),
        ...(mail.id !== undefined && {
          // The same on every attempt: a resend after a lost reply shows once (RFC 5322).
          messageId: `<${mail.id}@${messageIdDomain(mail.from.address)}>`,
        }),
        ...(mail.listUnsubscribe !== undefined && {
          list: { unsubscribe: mail.listUnsubscribe },
        }),
        headers: {
          'Content-Language': mail.language,
          // No out-of-office replies to a message no one reads (RFC 3834).
          'Auto-Submitted': 'auto-generated',
          // The one-click unsubscribe (RFC 8058): a POST to the URL, nothing to confirm.
          ...(mail.listUnsubscribe !== undefined && {
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }),
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      throw classify(error);
    }
  }
}
