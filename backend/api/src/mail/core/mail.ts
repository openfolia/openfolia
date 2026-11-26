import type { Actor } from '../../access/core/actor.js';

/** The languages an email is written in (#609): the editor's. */
export const MAIL_LANGUAGE_VALUES = ['en', 'de'] as const;

/** A language an email is written in. */
export type MailLanguage = (typeof MAIL_LANGUAGE_VALUES)[number];

export const isMailLanguage = (value: unknown): value is MailLanguage =>
  typeof value === 'string' &&
  (MAIL_LANGUAGE_VALUES as readonly string[]).includes(value);

/**
 * The language to write in: `wanted` when an email exists in it (`de-AT` reads as `de`), else
 * the installation's (`CCMS_MAIL_LANGUAGE`).
 */
export function mailLanguage(
  wanted: string | null | undefined,
  fallback: MailLanguage,
): MailLanguage {
  const primary = wanted?.trim().toLowerCase().split(/[-_]/)[0];
  return isMailLanguage(primary) ? primary : fallback;
}

/** Who an email goes to. */
export interface MailRecipient {
  readonly address: string;
  /** The person's name, shown beside the address; never part of a header as text we build. */
  readonly name?: string | null;
}

/**
 * A bare address that is safe in an SMTP command and a header: at most 254 characters, one "@",
 * nothing on either side that is a space, a control character (CR, LF) or a character that
 * separates or quotes addresses (`<>",;()[]\`).
 */
export function isMailAddress(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s\p{Cc}<>",;()[\]\\@]+@[^\s\p{Cc}<>",;()[\]\\@]+\.[^\s\p{Cc}<>",;()[\]\\@.]+$/u.test(
    value,
  );
}

/**
 * `value` as one line of header text: control characters (CR, LF, tab, …) and other line or
 * paragraph separators become spaces, runs of spaces one, trimmed, at most `max` characters.
 * Every name and subject goes through it, so no input can start a header of its own.
 */
export function headerText(value: string, max: number): string {
  const line = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...line].slice(0, max).join('').trim();
}

/** The longest subject and sender name. */
export const MAX_SUBJECT = 200;
export const MAX_SENDER_NAME = 80;

/** An image an email carries inline, referred to as `cid:<cid>`: never a remote image. */
export interface InlineImage {
  readonly cid: string;
  readonly filename: string;
  readonly contentType: 'image/png';
  readonly content: Buffer;
}

/** An email ready to send: what the `Mailer` gets. */
export interface RenderedMail {
  /** The queued email's ID: its `Message-ID`, the same on every attempt (its idempotency key). */
  readonly id?: string;
  /**
   * The one-click unsubscribe (#884, RFC 8058): the `List-Unsubscribe` URL, which takes a
   * `POST`; absent for an email nobody subscribed to.
   */
  readonly listUnsubscribe?: string;
  readonly from: { readonly name: string; readonly address: string };
  readonly to: MailRecipient;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly images: readonly InlineImage[];
  readonly language: MailLanguage;
}

/** Who records what the mail component does on its own (a failed email): never a user. */
export const MAIL_ACTOR: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:mail',
  roles: Object.freeze([]),
}) as Actor;

/** The audit log's subject for an email: its message ID. */
export const mailSubject = (id: string) => ({ type: 'mail', id }) as const;

/** A message's ID: a UUID. */
export const MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isMessageId = (value: string): boolean => MESSAGE_ID.test(value);
