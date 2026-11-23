import { type Problem, UnprocessableProblems } from '../../base/core/errors.js';

/**
 * Custom headers a subscriber sends with every delivery (#457): an
 * `Authorization: Bearer …` or an `X-Api-Key` for a receiver that
 * authenticates requests its own way. A secret one's value is stored
 * sealed (`WebhookSecrets.sealHeader`) and never shown again; the others
 * are stored and shown as they are.
 */

/** The most custom headers a subscriber may have. */
export const MAX_HEADERS = 20;

/** The most their names and values may add up to, in characters (ASCII only, so bytes too). */
export const MAX_HEADERS_SIZE = 8_192;

/** The longest header name. */
export const MAX_HEADER_NAME = 100;

/**
 * Names a subscriber may not set, compared in lower case: what the server
 * sets itself (the body's type and length, its user agent, the idempotency
 * key and every `X-Ccms-` header, the signature among them), what would
 * break the request's framing or its connection (the hop-by-hop headers of
 * RFC 9110 §7.6.1, `Host`, `Expect`, `Content-Encoding`), and what is not
 * a receiver's credential but a browser's or a proxy's (`Cookie`,
 * `Proxy-*`, below).
 */
export const REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
  'user-agent',
  'idempotency-key',
]);

/** Prefixes of names a subscriber may not set, in lower case. */
export const REFUSED_HEADER_PREFIXES: readonly string[] = ['x-ccms-', 'proxy-'];

/** An RFC 9110 token (`1*tchar`). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A value as sent: visible ASCII and spaces or tabs inside; never CR, LF,
 * NUL or another control character (no header can be smuggled in), and
 * no text outside ASCII (sent as it is stored, byte for byte).
 */
const VALUE = /^[\x21-\x7e](?:[\t\x20-\x7e]*[\x21-\x7e])?$/;

/** A custom header as stored: its value as it is, or sealed. */
export type StoredHeader =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly sealed: string };

/** A custom header as the API shows it: a secret one never with its value. */
export interface WebhookHeader {
  readonly name: string;
  readonly secret: boolean;
  /** Null for a secret one: it is never shown. */
  readonly value: string | null;
}

/** A custom header as a request gives it. */
export interface HeaderInput {
  readonly name: string;
  /**
   * The value; left out of a secret header that exists already (the same
   * name, any case), it keeps its stored value.
   */
  readonly value?: string;
  /** Whether the value is a secret: stored sealed and never shown. Default false. */
  readonly secret?: boolean;
}

export const isSecret = (
  header: StoredHeader,
): header is { readonly name: string; readonly sealed: string } =>
  'sealed' in header;

/** How the API shows stored headers. */
export const publicHeaders = (
  headers: readonly StoredHeader[],
): WebhookHeader[] =>
  headers.map((h) =>
    isSecret(h)
      ? { name: h.name, secret: true, value: null }
      : { name: h.name, secret: false, value: h.value },
  );

/** Whether a name is one a subscriber may not set (`REFUSED_HEADER_NAMES`, the prefixes). */
export function refusedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    REFUSED_HEADER_NAMES.has(lower) ||
    REFUSED_HEADER_PREFIXES.some((p) => lower.startsWith(p))
  );
}

/** What checking a request's headers needs. */
export interface HeaderContext {
  /** The subscriber's stored headers (none for a new one). */
  readonly existing: readonly StoredHeader[];
  /** Seals a secret value for the header named `name`. */
  readonly seal: (value: string, name: string) => string;
  /**
   * The length of a kept secret header's value (opened to measure it);
   * undefined when it cannot be opened.
   */
  readonly lengthOf: (
    header: StoredHeader & { sealed: string },
  ) => number | undefined;
  /**
   * The URL changes: a secret value is never sent to a receiver it was
   * not given for, so each secret header must be given its value again
   * (or be removed).
   */
  readonly urlChanges: boolean;
}

const POINTER = '/data/attributes/headers';

/**
 * The headers to store for `input`, checked: names RFC 9110 tokens of at
 * most `MAX_HEADER_NAME` characters, none refused (`refusedHeaderName`),
 * none twice (in any case); values visible ASCII (no CR, LF or other
 * control character; leading and trailing white space dropped); a secret
 * one sealed, or kept as it is stored when its value is left out; at most
 * `MAX_HEADERS`, together at most `MAX_HEADERS_SIZE` characters. Every
 * problem at once: 422 `invalid-headers`, one error each with its own
 * code (`header-name-invalid`, `header-name-refused`,
 * `header-name-duplicate`, `header-value-invalid`, `header-value-required`,
 * `too-many-headers`, `headers-too-large`) and `source.pointer`. Never a
 * value in a message.
 */
export function checkHeaders(
  input: readonly HeaderInput[],
  context: HeaderContext,
): StoredHeader[] {
  const problems: Problem[] = [];
  if (input.length > MAX_HEADERS) {
    problems.push({
      code: 'too-many-headers',
      detail: `A webhook may send at most ${MAX_HEADERS} custom headers.`,
      pointer: POINTER,
      meta: { max: MAX_HEADERS },
    });
  }
  const kept = new Map(
    context.existing
      .filter(isSecret)
      .map((h) => [h.name.toLowerCase(), h] as const),
  );
  const seen = new Set<string>();
  const out: StoredHeader[] = [];
  let size = 0;
  input.forEach((header, i) => {
    const at = `${POINTER}/${i}`;
    const name = header.name.trim();
    const lower = name.toLowerCase();
    let nameOk = false;
    if (!TOKEN.test(name) || name.length > MAX_HEADER_NAME) {
      problems.push({
        code: 'header-name-invalid',
        detail: `A header name is a token of 1 to ${MAX_HEADER_NAME} letters, digits and !#$%&'*+-.^_\`|~, without spaces or colons.`,
        pointer: `${at}/name`,
      });
    } else if (refusedHeaderName(name)) {
      problems.push({
        code: 'header-name-refused',
        detail: `The header "${name}" is set by the server or would break the delivery; a webhook may not set it.`,
        pointer: `${at}/name`,
        meta: { name },
      });
    } else if (seen.has(lower)) {
      problems.push({
        code: 'header-name-duplicate',
        detail: `The header "${name}" is given twice (names are compared without case).`,
        pointer: `${at}/name`,
        meta: { name },
      });
    } else {
      nameOk = true;
    }
    seen.add(lower);
    const secret = header.secret === true;
    if (header.value === undefined) {
      const stored = kept.get(lower);
      if (!secret || stored === undefined || context.urlChanges) {
        problems.push({
          code: 'header-value-required',
          detail: !secret
            ? 'A header that is not secret needs its value.'
            : stored === undefined
              ? 'A new secret header needs its value.'
              : 'Pointing the webhook at another URL needs the value of each secret header again (or the header removed): a secret is never sent to a receiver it was not given for.',
          pointer: `${at}/value`,
        });
        return;
      }
      // Kept as sealed: its context names the header in lower case, so a
      // name given in another case still opens it.
      const length = context.lengthOf(stored);
      if (length === undefined) {
        problems.push({
          code: 'header-value-required',
          detail:
            'The stored value of this secret header cannot be opened (the secret key changed): give it again.',
          pointer: `${at}/value`,
        });
        return;
      }
      size += name.length + length;
      if (nameOk) out.push({ name, sealed: stored.sealed });
      return;
    }
    const value = header.value.trim();
    if (!VALUE.test(value)) {
      problems.push({
        code: 'header-value-invalid',
        detail:
          'A header value is 1 or more visible ASCII characters, with spaces or tabs inside: never a line break or another control character.',
        pointer: `${at}/value`,
      });
      return;
    }
    size += name.length + value.length;
    if (nameOk)
      out.push(
        secret ? { name, sealed: context.seal(value, name) } : { name, value },
      );
  });
  if (size > MAX_HEADERS_SIZE) {
    problems.push({
      code: 'headers-too-large',
      detail: `A webhook's custom header names and values may add up to at most ${MAX_HEADERS_SIZE} characters.`,
      pointer: POINTER,
      meta: { max: MAX_HEADERS_SIZE },
    });
  }
  if (problems.length > 0) {
    throw new UnprocessableProblems(
      'invalid-headers',
      'The custom headers cannot be used.',
      problems,
    );
  }
  return out;
}

/** What changed between two header lists, by name only (for the audit log). */
export interface HeaderChanges {
  readonly added: string[];
  readonly removed: string[];
  /** A value that is not secret changed, a header became secret or stopped being, or its name's case changed. */
  readonly changed: string[];
  /** A secret header was given a new value. */
  readonly secretChanged: string[];
}

/** By name (compared in lower case, named as now), never a value. */
export function headerChanges(
  before: readonly StoredHeader[],
  after: readonly StoredHeader[],
): HeaderChanges {
  const old = new Map(before.map((h) => [h.name.toLowerCase(), h] as const));
  const now = new Set(after.map((h) => h.name.toLowerCase()));
  const changes: HeaderChanges = {
    added: [],
    removed: before
      .filter((h) => !now.has(h.name.toLowerCase()))
      .map((h) => h.name),
    changed: [],
    secretChanged: [],
  };
  for (const h of after) {
    const was = old.get(h.name.toLowerCase());
    if (!was) changes.added.push(h.name);
    else if (isSecret(h) && isSecret(was) && h.sealed !== was.sealed)
      changes.secretChanged.push(h.name);
    else if (
      isSecret(h) !== isSecret(was) ||
      h.name !== was.name ||
      (!isSecret(h) && !isSecret(was) && h.value !== was.value)
    )
      changes.changed.push(h.name);
  }

  return changes;
}

/** Whether nothing changed. */
export const noHeaderChanges = (c: HeaderChanges): boolean =>
  c.added.length +
    c.removed.length +
    c.changed.length +
    c.secretChanged.length ===
  0;
