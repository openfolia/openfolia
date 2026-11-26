import type { Hex } from '../../branding/core/brand-colours.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { MailLanguage, RenderedMail } from './mail.js';

/**
 * Whether email is on: `on`; `off`, no mail server set (`CCMS_MAIL_URL`); `no-secret-key`, a
 * server is set but the instance has no secret key, which seals what a queued email holds.
 */
export type MailState = 'on' | 'off' | 'no-secret-key';

/** How the connection to the mail server is protected. */
export type MailTls =
  /** `smtps://`: TLS from the first byte. */
  | 'implicit'
  /** `smtp://` with `CCMS_MAIL_REQUIRE_TLS=true`: STARTTLS, or nothing is sent. */
  | 'starttls'
  /** `smtp://` with `CCMS_MAIL_REQUIRE_TLS=false`: STARTTLS when the server offers it. */
  | 'opportunistic';

/** The mail server, as the settings name it: never its password. */
export interface MailServerInfo {
  readonly host: string;
  readonly port: number;
  readonly tls: MailTls;
  /** Whether the server is signed in to (`CCMS_MAIL_USER`). */
  readonly authenticated: boolean;
}

/** Port: email's settings (`CCMS_MAIL_*`), read when asked: the secret key opens as the server starts. */
export abstract class MailSettings {
  abstract readonly state: MailState;
  /** Null while no server is set. */
  abstract readonly server: MailServerInfo | null;
  /** `CCMS_MAIL_FROM`; null while no server is set. */
  abstract readonly from: string | null;
  /** The language of an email to someone whose language is not known (`CCMS_MAIL_LANGUAGE`). */
  abstract readonly language: MailLanguage;
  /** `CCMS_PUBLIC_URL`, ending in `/`: the base of every link; null when unset. */
  abstract readonly publicUrl: string | null;
}

/** Why a send failed, as the adapter tells it: never a server's reply text or an address. */
export type MailErrorKind =
  /** The server refused the message or a recipient for good (an SMTP 5xx reply). */
  | 'rejected'
  /** The server could not be reached, timed out, or answered 4xx: tried again. */
  | 'unavailable'
  /** TLS was required and the server offered none, or its certificate did not verify. */
  | 'tls'
  /** The server refused the sign-in. */
  | 'auth';

/** A failed send; `code` is a short token (`ECONNREFUSED`, `550`), never a reply text. */
export class MailSendError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    readonly code: string,
  ) {
    super(`Sending the email failed (${kind} ${code}).`);
    this.name = 'MailSendError';
  }

  /** Whether trying again may help. */
  get final(): boolean {
    return this.kind === 'rejected';
  }
}

/** Port: sends one email to the installation's mail server (SMTP, `repos/`); a fake records them. */
export abstract class Mailer {
  /** Resolves once the server accepted it; throws `MailSendError`. */
  abstract send(mail: RenderedMail, signal?: AbortSignal): Promise<void>;
}

/** The branding an email takes. */
export interface MailBrand {
  /** The product's name, or the default's. */
  readonly productName: string;
  /** The primary colour; null for the theme's. */
  readonly primary: Hex | null;
  /** The light logo as PNG, its size to show it at in CSS pixels; null for none. */
  readonly logo: {
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
  } | null;
}

/** Port: the branding as an email shows it (`repos/`: the branding store and its images). */
export abstract class MailBrandSource {
  abstract read(): Promise<MailBrand>;
  /** The product's name alone (no image read). */
  abstract productName(): Promise<string>;
}

/** A queued email as stored: what it is made from, its params sealed. */
export interface StoredMail {
  readonly id: string;
  readonly toAddress: string;
  readonly toName: string | null;
  readonly template: string;
  readonly language: MailLanguage;
  /** The template's params as JSON, sealed (`SecretSealer`, context `mailParamsContext(id)`). */
  readonly paramsSealed: string;
  /** Failed attempts so far. */
  readonly attempts: number;
  /** The last failed attempt's error kind (`MailErrorKind`); null before one. */
  readonly lastError: string | null;
  readonly createdAt: Date;
  /**
   * What `mail.sent` and `mail.failed` record besides the template (#884); null: the email is
   * not recorded when sent (sign-in links, codes, the test email).
   */
  readonly auditData: Readonly<Record<string, unknown>> | null;
}

/**
 * Port: the emails waiting to be sent (`mail_messages`). A row lives only while its email
 * waits: it is removed once sent, or once it failed for good, so nothing of an email stays
 * after it went out.
 */
export abstract class MailStore {
  /** Adds one inside `tx` (with the change that caused it). */
  abstract add(
    tx: Transaction,
    mail: Omit<StoredMail, 'attempts' | 'lastError' | 'createdAt'>,
  ): Promise<void>;

  abstract find(id: string): Promise<StoredMail | undefined>;

  /** Counts a failed attempt and its error kind; false when it is gone. */
  abstract recordFailure(id: string, error: string): Promise<boolean>;

  /** Removes it; false when it was gone already (another attempt removed it). */
  abstract remove(tx: Transaction, id: string): Promise<boolean>;

  /**
   * Removes up to `limit` emails queued before `before` (their jobs were dropped by the queue:
   * they will never be sent); how many.
   */
  abstract removeStale(before: Date, limit: number): Promise<number>;
}

/** The sealing context of a queued email's params: they open only for that email. */
export const mailParamsContext = (id: string): string => `mail-params:v1:${id}`;
