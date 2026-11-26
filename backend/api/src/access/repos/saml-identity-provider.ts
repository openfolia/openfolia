import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import {
  generateServiceProviderMetadata,
  SAML,
  ValidateInResponseTo,
} from '@node-saml/node-saml';
import type { XmlElement } from '@openfolia/xml';
import {
  type BegunSignIn,
  type ExternalIdentity,
  IdentityProvider,
  type PendingSignIn,
  SignInFailedError,
} from '../core/identity-provider.js';
import { SeenAssertions } from '../core/seen-assertions.js';
import type { SamlNameIdFormat } from '../../config/saml-env.js';
import { SIGN_IN_SECONDS } from '../api/session-cookies.js';
import { type AnswerConfig, childrenOf, OneSignIn } from './saml-answer.js';
import {
  SamlAnswerRefusedError,
  SamlAnswersBusyError,
  SamlAnswerWorkers,
} from './saml-answer-workers.js';
import {
  type IdpMetadata,
  MAX_METADATA_LENGTH,
  readIdpMetadata,
} from './saml-metadata.js';

/** How long reading the identity provider's metadata may take. */
const TIMEOUT_MS = 10_000;
/** After a failed read, the next sign-in tries again; not more often than this. */
const RETRY_METADATA_MS = 5_000;
/**
 * How long metadata read is kept before it is read again (a new signing certificate).
 * shortcut: a fixed day, not the metadata's `validUntil`/`cacheDuration`; read those once an
 * identity provider rolls its keys faster.
 */
const METADATA_KEPT_MS = 24 * 3_600_000;
/** How far the identity provider's clock may be from ours. */
const CLOCK_SKEW_MS = 60_000;
/**
 * Characters that do not show (control and format characters, line and paragraph separators,
 * those that fonts leave out, and the two others RFC 4518 drops). Directories ignore most of them
 * when they look a person up and take the rest for a space, so two texts of one person could
 * differ in them alone (#946).
 */
const NOT_SHOWN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u1806\ufffc]/u;
/** The longest NameID taken: a persistent one's limit (SAML core §8.3.7). */
const MAX_NAME_ID_LENGTH = 256;

const FORMATS: Readonly<Record<SamlNameIdFormat, string>> = {
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
/** Before a SAML identity's issuer (#376): `user_identities` keys OpenID Connect identities by `iss` too. */
export const SAML_ISSUER_PREFIX = 'saml:';

export interface SamlSettings {
  /** Where the identity provider's metadata is: its address, or a file. */
  readonly metadata: { readonly url: string } | { readonly file: string };
  /** This server's entity ID: the audience its assertions must name. */
  readonly entityId: string;
  /** The assertion consumer service: where the identity provider posts its answer. */
  readonly acsUrl: string;
  readonly displayName?: string;
  /** The one Format of the name IDs (#946): asked for, and required of every answer. */
  readonly nameIdFormat: SamlNameIdFormat;
  readonly emailAttribute: string;
  readonly nameAttribute: string;
  readonly groupsAttribute: string;
  /** Whether the email addresses sent count as verified (`ExternalIdentity.emailVerified`). */
  readonly emailVerified: boolean;
  /** Whether an IdP-initiated sign-in (an answer to no request of ours) is accepted. */
  readonly idpInitiated: boolean;
}

/**
 * Whom a name ID names, as `user_identities.subject`: the SHA-256 of its Format and text. The
 * Format is the one this installation expects, so it varies only with the setting: after a change
 * of it, the same text may be someone else's (a login name that reads like an opaque ID), and
 * nobody is taken for another. The qualifiers are no part of it: absent, they mean the ones
 * required otherwise (#946). An email address counts without regard to case, as elsewhere here,
 * but only in ASCII: Unicode folds different letters together. The identity's issuer is the
 * identity provider's.
 */
function subjectKey(format: SamlNameIdFormat, text: string): string {
  const name =
    format === 'emailAddress'
      ? text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      : text;
  return createHash('sha256')
    .update(JSON.stringify([FORMATS[format], name]))
    .digest('hex');
}

/** An element's own text, what is in elements in it left out. */
function ownText(element: XmlElement): string {
  return element.children.filter((child) => typeof child === 'string').join('');
}

/** An attribute's first text value; null for none or blank. */
function textOf(values: readonly string[]): string | null {
  return values[0]?.trim() || null;
}

/**
 * SAML 2.0 sign-in (#376), beside OpenID Connect: SP-initiated (a request over the
 * HTTP-Redirect binding, the answer over HTTP-POST) and, when allowed, IdP-initiated. Checked by
 * node-saml: the assertion must be signed with a certificate from the identity provider's
 * metadata (`wantAssertionsSigned`), name it as issuer and this server as audience and
 * recipient, be within its time, answer the request this browser began (or none, IdP-initiated
 * only) and never have been accepted before (`SeenAssertions`). Nothing provider-specific: the
 * person is the NameID, in the one Format this installation expects (#946), and their email
 * address, name and groups are attributes named by the settings. An answer past
 * its bounds (`checkAnswer`) is refused before any of that. All of it runs in a worker thread
 * with a time limit (`SamlAnswerWorkers`, #951); what it read is checked here. The metadata is
 * read at the first sign-in (not at start-up, so an unreachable provider never stops the
 * server), kept a day, and read again after a failure at a later sign-in.
 */
export class SamlIdentityProvider extends IdentityProvider {
  readonly id = 'saml';
  readonly displayName: string | null;
  override readonly answersByPost = true;
  override readonly acceptsUnsolicited: boolean;
  private readonly log = new Logger('Sign-in');
  private metadata: { read: Promise<IdpMetadata>; at: number } | undefined;
  private failedAt = 0;
  now: () => number = Date.now;
  /** Where answers are verified and read (#951). */
  readonly answers: SamlAnswerWorkers;

  constructor(
    private readonly settings: SamlSettings,
    seen: SeenAssertions,
  ) {
    super();
    this.displayName = settings.displayName ?? null;
    this.acceptsUnsolicited = settings.idpInitiated;
    this.answers = new SamlAnswerWorkers((key, until) =>
      seen.recordOnce(key, until),
    );
  }

  async begin(): Promise<BegunSignIn> {
    const idp = await this.idp();
    const cache = new OneSignIn(undefined);
    const url = await new SAML({
      ...this.config(idp, ValidateInResponseTo.always),
      cacheProvider: cache,
    }).getAuthorizeUrlAsync('', {});
    if (cache.saved === undefined) {
      throw new Error('The sign-in request has no ID.');
    }
    return {
      authorizationUrl: url,
      pending: { requestId: cache.saved.id, requestedAt: cache.saved.at },
    };
  }

  async complete(
    callback: URLSearchParams,
    pending: PendingSignIn,
  ): Promise<ExternalIdentity> {
    const answer = callback.get('SAMLResponse');
    const requestId = pending['requestId'];
    const requestedAt = pending['requestedAt'];
    const request =
      requestId !== undefined && requestedAt !== undefined
        ? { id: requestId, at: requestedAt }
        : undefined;
    if (!answer || (request === undefined && !this.acceptsUnsolicited)) {
      throw new SignInFailedError(
        'sign-in-failed',
        'The sign-in was not begun here.',
      );
    }
    const idp = await this.idp();
    let assertion: XmlElement | undefined;
    try {
      assertion = await this.answers.check(
        answer,
        this.config(
          idp,
          // Begun here: it must answer that request. Unsolicited allowed: a request ID it names
          // must still be this browser's.
          this.acceptsUnsolicited
            ? ValidateInResponseTo.ifPresent
            : ValidateInResponseTo.always,
        ),
        request,
      );
    } catch (error) {
      if (error instanceof SamlAnswersBusyError) {
        this.log.warn(`A SAML sign-in was not checked: ${describe(error)}`);
        throw new SignInFailedError(
          'provider-unavailable',
          'Too many sign-ins at once.',
        );
      }
      // The database or the worker, not the answer: never said to be a refusal.
      if (!(error instanceof SamlAnswerRefusedError)) throw error;
      // The message names the check that failed; it may quote what the answer said, so
      // `printable` keeps one short line of printable text.
      const why = printable(error.message);
      if (error.status) {
        this.log.warn(`The identity provider refused a sign-in: ${why}`);
        throw new SignInFailedError(
          'access-denied',
          'The identity provider refused the sign-in.',
        );
      }
      this.log.warn(`A SAML sign-in was refused: ${why}`);
      throw new SignInFailedError(
        'sign-in-failed',
        'The sign-in could not be completed.',
      );
    }
    if (!assertion) this.refuse('it holds no assertion.');
    return this.identityOf(assertion, idp, request?.id);
  }

  /**
   * Whether the provider answers now (#953). Metadata from an address is read again, with the
   * time limit of every read (`TIMEOUT_MS`), and refused when that fails or is not valid; only
   * valid metadata replaces what sign-ins use. Metadata from a file cannot be checked: as
   * before, it answers from what was read (the file is read once if it was not).
   */
  override async answersNow(): Promise<void> {
    if ('file' in this.settings.metadata) return super.answersNow();
    let idp: IdpMetadata;
    try {
      idp = await this.readMetadata();
    } catch (error) {
      this.log.warn(
        `The identity provider's metadata could not be read: ${describe(error)}`,
      );
      throw unavailable();
    }
    this.metadata = { read: Promise.resolve(idp), at: this.now() };
    this.failedAt = 0;
  }

  /** No single logout (#376): signing out ends the session here only. */
  signOutUrl(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  override serviceMetadata(): string {
    return generateServiceProviderMetadata({
      issuer: this.settings.entityId,
      callbackUrl: this.settings.acsUrl,
      wantAssertionsSigned: true,
      identifierFormat: FORMATS[this.settings.nameIdFormat],
    });
  }

  private identityOf(
    assertion: XmlElement,
    idp: IdpMetadata,
    requestId: string | undefined,
  ): ExternalIdentity {
    if (!this.forUs(assertion, requestId)) {
      this.refuse(
        "no bearer SubjectConfirmation valid now names this server's assertion consumer service as its Recipient and answers this browser's request (or none).",
      );
    }
    const text = this.nameIdOf(assertion, idp);
    const format = this.settings.nameIdFormat;
    const email =
      textOf(
        this.attribute(
          assertion,
          this.settings.emailAttribute,
          'CCMS_SAML_EMAIL_ATTRIBUTE',
        ),
      ) ?? (format === 'emailAddress' ? text : null);
    const name = textOf(
      this.attribute(
        assertion,
        this.settings.nameAttribute,
        'CCMS_SAML_NAME_ATTRIBUTE',
      ),
    );
    return {
      // The metadata's entity ID (node-saml checked the assertion names it), apart from any
      // OpenID Connect issuer of the same name: a NameID never matches an OIDC `sub`.
      issuer: `${SAML_ISSUER_PREFIX}${idp.entityId}`,
      subject: subjectKey(format, text),
      email,
      emailVerified: email !== null && this.settings.emailVerified,
      name,
      username: null,
      groups: [
        ...this.attribute(
          assertion,
          this.settings.groupsAttribute,
          'CCMS_SAML_GROUPS_ATTRIBUTE',
        ),
      ],
    };
  }

  /**
   * The text of the assertion's NameID, which must be what this installation expects of every
   * answer (#946), as what the provider was asked for cannot be relied on: in the Format set (none
   * is unspecified, SAML core §2.2.2), each qualifier absent or the one it means when absent, and
   * a text alone, without blanks around it or characters that do not show, which two texts of one
   * person could differ in. Case, spaces inside and normalisation forms are left: a directory may
   * hold a name in any of them, and joining two forms could make two people one.
   */
  private nameIdOf(assertion: XmlElement, idp: IdpMetadata): string {
    const subjects = childrenOf(assertion, 'Subject');
    const nameIds = childrenOf(subjects[0], 'NameID');
    const nameId = nameIds[0];
    if (subjects.length !== 1 || nameIds.length !== 1 || nameId === undefined) {
      this.refuse('its assertion does not hold exactly one NameID.');
    }
    const format = nameId.attributes.get('Format');
    const expected = FORMATS[this.settings.nameIdFormat];
    if ((format ?? FORMATS.unspecified) !== expected) {
      this.refuse(
        `its NameID has the Format ${format === undefined ? '(none)' : quoted(format)}, expected is "${expected}" (CCMS_SAML_NAME_ID_FORMAT).`,
      );
    }
    for (const [name, named] of [
      ['NameQualifier', idp.entityId],
      ['SPNameQualifier', this.settings.entityId],
    ] as const) {
      const qualifier = nameId.attributes.get(name);
      if (qualifier !== undefined && qualifier !== named) {
        this.refuse(
          `its NameID has the ${name} ${quoted(qualifier)}, expected is none or ${quoted(named)}.`,
        );
      }
    }
    const text = ownText(nameId);
    if (
      text === '' ||
      text !== text.trim() ||
      text.length > MAX_NAME_ID_LENGTH ||
      NOT_SHOWN.test(text) ||
      // Elements in it: its text is only what is around them.
      nameId.children.some((child) => typeof child !== 'string')
    ) {
      this.refuse(
        'its NameID is empty, has blanks around it, is longer than 256 characters, or holds an element or a character that does not show.',
      );
    }
    return text;
  }

  /** Refuses an answer node-saml verified; `why` is for the log only. */
  private refuse(why: string): never {
    this.log.warn(`A SAML sign-in was refused: ${why}`);
    throw new SignInFailedError(
      'sign-in-failed',
      'The sign-in could not be completed.',
    );
  }

  /**
   * The text values of the attribute `setting` names. One attribute of that name, whatever its
   * NameFormat (there is none to configure, and identity providers differ in it): of several,
   * which one is meant cannot be told, so the sign-in is refused (#934).
   */
  private attribute(
    assertion: XmlElement,
    name: string,
    setting: string,
  ): readonly string[] {
    const found = childrenOf(assertion, 'AttributeStatement')
      .flatMap((statement) => childrenOf(statement, 'Attribute'))
      .filter((attribute) => attribute.attributes.get('Name') === name);
    if (found.length > 1) {
      this.refuse(
        `its assertion holds more than one attribute of the name ${setting} sets (several values go into one attribute).`,
      );
    }
    return childrenOf(found[0], 'AttributeValue')
      .map(ownText)
      .filter((value) => value.trim() !== '');
  }

  /**
   * Whether the verified assertion is meant for this server (SAML profiles §4.1.4.2): a bearer
   * SubjectConfirmation, not past its time, whose Recipient is our assertion consumer service and
   * whose InResponseTo, when it names one, is this browser's request: with unsolicited answers
   * allowed, node-saml decides by the response's unsigned InResponseTo whether to check it.
   * node-saml 5 only warns about the Recipient, so it is checked here.
   */
  private forUs(assertion: XmlElement, requestId: string | undefined): boolean {
    const now = this.now();
    return childrenOf(
      childrenOf(assertion, 'Subject')[0],
      'SubjectConfirmation',
    ).some((confirmation) => {
      const data = childrenOf(confirmation, 'SubjectConfirmationData')[0]
        ?.attributes;
      const inResponseTo = data?.get('InResponseTo');
      const until = Date.parse(data?.get('NotOnOrAfter') ?? '');
      return (
        confirmation.attributes.get('Method') === BEARER &&
        data?.get('Recipient') === this.settings.acsUrl &&
        (inResponseTo === undefined || inResponseTo === requestId) &&
        Number.isFinite(until) &&
        now < until + CLOCK_SKEW_MS
      );
    });
  }

  /** node-saml's settings for one sign-in, against the metadata read (the cache is the caller's). */
  private config(
    idp: IdpMetadata,
    validateInResponseTo: ValidateInResponseTo,
  ): AnswerConfig {
    return {
      entryPoint: idp.ssoUrl,
      idpIssuer: idp.entityId,
      idpCert: [...idp.certificates],
      issuer: this.settings.entityId,
      audience: this.settings.entityId,
      callbackUrl: this.settings.acsUrl,
      // The assertion itself must be signed; a signed response around an unsigned one is not enough.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo,
      rejectReplayedAssertions: true,
      // As long as the sealed cookie holding the request keeps.
      requestIdExpirationPeriodMs: SIGN_IN_SECONDS * 1000,
      acceptedClockSkewMs: CLOCK_SKEW_MS,
      // Asked for, but the request is not signed: what is required of the answer is `nameIdOf`'s.
      identifierFormat: FORMATS[this.settings.nameIdFormat],
      // The provider's own way of signing in: nothing asked for that it may refuse.
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
    };
  }

  /** The identity provider's metadata, read once a day (again after a failure, at most every few seconds). */
  private idp(): Promise<IdpMetadata> {
    const now = this.now();
    if (this.metadata && now - this.metadata.at < METADATA_KEPT_MS) {
      return this.metadata.read;
    }
    if (now - this.failedAt < RETRY_METADATA_MS) {
      return this.metadata?.read ?? Promise.reject(unavailable());
    }
    const previous = this.metadata;
    const entry: { read: Promise<IdpMetadata>; at: number } = {
      read: this.readMetadata().catch((error: unknown) => {
        this.log.warn(
          `The identity provider's metadata could not be read: ${describe(error)}`,
        );
        // Only while this read is still the one in use: `answersNow` may have put a valid one there (#953).
        if (this.metadata === entry) {
          this.failedAt = this.now();
          // A day-old copy still works until a new one is read.
          this.metadata = previous;
        }
        if (previous) return previous.read;
        throw unavailable();
      }),
      at: now,
    };
    this.metadata = entry;
    return entry.read;
  }

  private async readMetadata(): Promise<IdpMetadata> {
    const source = this.settings.metadata;
    const text =
      'file' in source
        ? await readFile(source.file, 'utf8')
        : await fetchText(source.url);
    return readIdpMetadata(text);
  }
}

const unavailable = () =>
  new SignInFailedError(
    'provider-unavailable',
    'The identity provider could not be reached.',
  );

/** The metadata at `url`, refused past `MAX_METADATA_LENGTH` and on any redirect. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // A redirect could leave https: the address itself, as configured.
    redirect: 'error',
    headers: { accept: 'application/samlmetadata+xml, application/xml' },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_METADATA_LENGTH * 4) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The metadata is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** An error's name and message, for the log; never more. */
function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${printable(error.message.split(/[\r\n]/, 1)[0] ?? '')}`
    : String(error);
}

/** What an answer holds, for the log: `printable`, and nothing in it ends the quotes. */
function quoted(text: string): string {
  return `"${printable(text).replaceAll('"', '?')}"`;
}

/** At most 200 characters of printable ASCII, for the log. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
