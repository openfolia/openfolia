import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MAIL_LANGUAGE_VALUES } from '../mail/core/mail.js';
import { field, flag, text } from './fields.js';

/** Where the mail server is, from `CCMS_MAIL_URL`. */
export interface MailServer {
  readonly host: string;
  readonly port: number;
  /** `smtps://`: TLS from the first byte. `smtp://`: plain, upgraded with STARTTLS. */
  readonly implicitTls: boolean;
}

/** No CR, LF or other control character: a value that ends up in an SMTP command or header. */
const NO_CONTROL = /^[^\p{Cc}]*$/u;

/**
 * `CCMS_MAIL_URL`: `smtp://host[:port]` (default port 587) or `smtps://host[:port]` (465). No
 * user, password, path, query or fragment: the credentials have their own settings, so they never
 * appear in a URL that is logged or shown.
 */
export const mailUrl = z
  .string()
  .trim()
  .transform((value, ctx): MailServer => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (
      !url ||
      (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== '' ||
      /[?#@]/.test(value)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be smtp://host[:port] or smtps://host[:port], without user, password, path, query or fragment',
      });
      return z.NEVER;
    }
    const implicitTls = url.protocol === 'smtps:';
    return {
      // `[::1]` as the URL writes it; the socket wants the bare address.
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: url.port === '' ? (implicitTls ? 465 : 587) : Number(url.port),
      implicitTls,
    };
  });

/**
 * `CCMS_MAIL_FROM`: a bare address (`docs@example.com`), no name: the sender's name is the
 * branding's product name.
 */
export const mailFrom = z
  .string()
  .trim()
  .pipe(
    z
      .email('must be an email address, e.g. docs@example.com')
      .max(254)
      .refine(
        (value) => NO_CONTROL.test(value) && !/[\s<>",;]/.test(value),
        'must be a bare email address, without a name',
      ),
  );

const absolutePath = text.refine(
  (value) => isAbsolute(value),
  'must be an absolute path',
);

/**
 * Email's settings (#609, `src/mail/`): part of `Env`. Read-only in the editor (Admin › System ›
 * Email): they hold secrets and must work before the first administrator exists.
 */
export const MailEnv = z.object({
  /** The mail server; unset: no email is sent (links are copied instead). */
  CCMS_MAIL_URL: field(mailUrl.optional()),
  /** The user name for the server's sign-in (SMTP AUTH); unset: none. */
  CCMS_MAIL_USER: field(
    text
      .max(254)
      .refine((value) => NO_CONTROL.test(value), 'must be on one line')
      .optional(),
  ),
  /** Its password. Never logged or shown. */
  CCMS_MAIL_PASSWORD: field(z.string().min(1).max(1024).optional()),
  /** A file holding the password (a Compose secret); wins over `CCMS_MAIL_PASSWORD`. */
  CCMS_MAIL_PASSWORD_FILE: field(absolutePath.optional()),
  /** The sender's address; required with `CCMS_MAIL_URL`. */
  CCMS_MAIL_FROM: field(mailFrom.optional()),
  /** On `smtp://`, refuse to send unless the server upgrades to TLS with STARTTLS (default true). */
  CCMS_MAIL_REQUIRE_TLS: field(flag.default(true)),
  /** A PEM file of certificate authorities to trust for the mail server (a private CA); unset: the system's. */
  CCMS_MAIL_CA_FILE: field(absolutePath.optional()),
  /** The language of an email to someone whose language is not known (default `en`). */
  CCMS_MAIL_LANGUAGE: field(z.enum(MAIL_LANGUAGE_VALUES).default('en')),
});
export type MailEnvSettings = z.infer<typeof MailEnv>;

/** The checks across fields, for `Env.superRefine`. */
export function checkMailEnv(env: MailEnvSettings, ctx: z.RefinementCtx): void {
  if (env.CCMS_MAIL_URL && !env.CCMS_MAIL_FROM) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_MAIL_FROM'],
      message: 'is required with CCMS_MAIL_URL',
    });
  }
  const password =
    env.CCMS_MAIL_PASSWORD !== undefined ||
    env.CCMS_MAIL_PASSWORD_FILE !== undefined;
  if (password && env.CCMS_MAIL_USER === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_MAIL_USER'],
      message: 'is required with CCMS_MAIL_PASSWORD or CCMS_MAIL_PASSWORD_FILE',
    });
  }
  if (env.CCMS_MAIL_USER !== undefined && !password) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_MAIL_PASSWORD'],
      message: 'is required with CCMS_MAIL_USER (or CCMS_MAIL_PASSWORD_FILE)',
    });
  }
}
