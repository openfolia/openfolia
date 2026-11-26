import {
  type MessagePort,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import {
  type CacheItem,
  type CacheProvider,
  SAML,
  type SamlConfig,
  SamlStatusError,
} from '@node-saml/node-saml';
import { readXml, type XmlElement, type XmlLimits } from '@openfolia/xml';

// This file is also the worker that checks answers (#951, end of the file), run by Node itself, the
// .ts source too: it imports packages only, and uses only syntax that types can be stripped from.
// Node resolves them without the `@openfolia/source` condition: `@openfolia/xml` is its build
// (`dist`), which `nx test` builds first; a bare `vitest` run needs it built.

/**
 * What one answer may hold (#934). An answer is checked before anything in it is trusted, and the
 * checks canonicalise it once per signature and certificate, so its size is their cost. Room for the
 * 200 groups kept of a person (`MAX_GROUPS`), with names of about 120 characters.
 */
const LIMITS: XmlLimits = {
  maxLength: 64 * 1024,
  maxDepth: 32,
  maxNodes: 1500,
  maxAttributes: 16,
};
/** The most attributes in all, namespace declarations left out. */
const MAX_ATTRIBUTES = 1000;
/**
 * The most characters of namespaces: those declared, and those of all elements and attributes,
 * each of which canonicalised may write its namespace out, however seldom the answer declares it.
 */
const MAX_NAMESPACES = 64 * 1024;
/**
 * The longest attribute value and text. Nothing in an answer needs more: IDs, URIs, times and names
 * are short, and the longest text, a certificate in base64, is about 2,000 characters (4096-bit
 * RSA). node-saml and its parsers run patterns over such values before anything is verified (#946).
 */
const MAX_VALUE = 4096;
const MAX_TEXT = 8192;
/**
 * The line ends XML 1.0 does not know (NEL, LS, PS), raw or as a character reference. xmldom reads
 * NEL and LS as line feeds, so text signed with one is another once read, and its line counter takes
 * time with the square of the line's length on a PS (#946).
 */
const LINE_SEPARATOR =
  /[\u0085\u2028\u2029]|&#(?:0*(?:133|8232|8233)|x0*(?:85|2028|2029));/i;
/** The most elements of these names, in any namespace: the response's signature and the assertion's. */
const MAX_ELEMENTS: ReadonlyMap<string, number> = new Map([
  ['Signature', 2],
  ['Reference', 2],
  ['Transform', 4],
]);

const NAME = String.raw`(?:[A-Za-z][\w.-]*:)?[A-Za-z][\w.-]*`;
/**
 * A tag as it is commonly written, which every reader takes for the same (#946): `</name>` with
 * nothing more in an end tag, as xmldom, which node-saml verifies with, looks for `</name>` and may
 * take an element that has none for an empty one; and plain ASCII names, prefixes and local ones
 * beginning with a letter. node-saml checks the issuer, audience and times with xml2js, which
 * turns elements into objects keyed by their names, where `_` is an element's text and `__proto__` no
 * name at all, and takes every prefix off but one beginning with `xmlns`.
 */
const PLAIN_TAG = new RegExp(
  String.raw`<(?!/?xmlns)(?:/${NAME}|${NAME}(?:\s+${NAME}\s*=\s*(?:"[^"]*"|'[^']*'))*\s*/?)>`,
  'g',
);

/**
 * Where xmldom reads and writes `script` and `textarea` as a browser does: text that was signed
 * escaped would be written out as elements, and reading it can cost far more than its size (#946).
 */
const XHTML = 'http://www.w3.org/1999/xhtml';

/** The answer is past a bound, or read in two ways; the message says which, for the log. */
export class SamlAnswerError extends Error {
  override readonly name = 'SamlAnswerError';
}

/**
 * Throws unless a posted answer (`SAMLResponse`, base64) is XML within the bounds above:
 * elements, attributes and text only, in plain tags (`PLAIN_TAG`) and no XHTML. Comments, processing
 * instructions and CDATA are not needed in an answer and the reader's limits do not count them; a DTD
 * is never read.
 */
export function checkAnswer(answer: string): void {
  // Decoded as node-saml decodes it.
  const text = Buffer.from(answer, 'base64').toString('utf8');
  if (LINE_SEPARATOR.test(text)) {
    throw new SamlAnswerError(
      'The answer holds a line separator (U+0085, U+2028 or U+2029).',
    );
  }
  const content = text.replace(/^\uFEFF?<\?xml[ \t\r\n][^>]*\?>/, '');
  if (/<[!?]/.test(content)) {
    throw new SamlAnswerError(
      'The answer holds a comment, a processing instruction, a CDATA section or a DTD.',
    );
  }
  const counts = new Map<string, number>();
  let attributes = 0;
  let namespaces = 0;
  const open: XmlElement[] = [readXml(text, LIMITS)];
  // Well-formed, so each `<` left begins a tag.
  if (content.replace(PLAIN_TAG, '').includes('<')) {
    throw new SamlAnswerError(
      "A tag in the answer is not plain: names and prefixes must be ASCII and begin with a letter, an element's not with xmlns, and an end tag holds its name alone.",
    );
  }
  for (let element = open.pop(); element; element = open.pop()) {
    if (
      [element.ns, ...element.attributes.keys()].some(
        (name) => name === XHTML || name?.startsWith(`{${XHTML}}`),
      )
    ) {
      throw new SamlAnswerError('The answer holds XHTML.');
    }
    if (
      [...element.attributes.values()].some(
        (value) => value.length > MAX_VALUE,
      ) ||
      element.children.some(
        (child) => typeof child === 'string' && child.length > MAX_TEXT,
      )
    ) {
      throw new SamlAnswerError(
        `The answer holds an attribute value longer than ${MAX_VALUE} characters or a text longer than ${MAX_TEXT}.`,
      );
    }
    for (const value of element.declarations.values()) {
      if (value.length > MAX_VALUE) {
        throw new SamlAnswerError(
          `The answer declares a namespace longer than ${MAX_VALUE} characters.`,
        );
      }
      namespaces += value.length;
    }
    attributes += element.attributes.size;
    namespaces += element.ns?.length ?? 0;
    // `{namespace}local` for one in a namespace.
    for (const name of element.attributes.keys()) {
      if (name.startsWith('{')) namespaces += name.lastIndexOf('}') - 1;
    }
    counts.set(element.local, (counts.get(element.local) ?? 0) + 1);
    for (const child of element.children) {
      if (typeof child !== 'string') open.push(child);
    }
  }
  if (attributes > MAX_ATTRIBUTES) {
    throw new SamlAnswerError(
      `The answer holds more than ${MAX_ATTRIBUTES} attributes.`,
    );
  }
  if (namespaces > MAX_NAMESPACES) {
    throw new SamlAnswerError(
      `The namespaces the answer declares, and those of its elements and attributes, hold more than ${MAX_NAMESPACES} characters.`,
    );
  }
  for (const [name, most] of MAX_ELEMENTS) {
    if ((counts.get(name) ?? 0) > most) {
      throw new SamlAnswerError(
        `The answer holds more than ${most} ${name} elements.`,
      );
    }
  }
}

/**
 * The assertion in the bytes a signature covers (`signed`: the assertion, or the response with one),
 * as the strict reader reads them; throws unless `read`, the assertion node-saml took from them, is
 * the same element for element. node-saml reads and writes it several times, with readers of its
 * own: whatever one of them makes of it that is not what was signed is refused (#946).
 */
export function signedAssertion(signed: string, read: string): XmlElement {
  const root = readXml(signed);
  const assertions =
    root.local === 'Assertion' ? [root] : childrenOf(root, 'Assertion');
  const assertion = assertions[0];
  if (
    assertion === undefined ||
    assertions.length > 1 ||
    contentOf(assertion) !== contentOf(readXml(read))
  ) {
    throw new SamlAnswerError(
      'node-saml read another assertion than the one signed.',
    );
  }
  return assertion;
}

/** An element's children of that name, whatever their namespace, as node-saml goes by. */
export function childrenOf(
  element: XmlElement | undefined,
  local: string,
): readonly XmlElement[] {
  return (element?.children ?? []).filter(
    (child): child is XmlElement =>
      typeof child !== 'string' && child.local === local,
  );
}

/**
 * All an element holds, for comparing. Line ends in text count as one: xmldom writes a signed
 * carriage return as it is, which a reader takes for a line feed (XML 1.0 §2.11).
 */
function contentOf(root: XmlElement): string {
  const tree = (element: XmlElement): unknown => [
    element.ns ?? null,
    element.local,
    [...element.attributes].sort(),
    element.children.map((child) =>
      typeof child === 'string' ? child.replace(/\r\n?/g, '\n') : tree(child),
    ),
  ];
  return JSON.stringify(tree(root));
}

/** A sign-in request this browser began: its ID, and when (node-saml's instant). */
export interface SignInRequest {
  readonly id: string;
  readonly at: string;
}

/** node-saml's settings for one answer; the worker adds the cache (`OneSignIn`). */
export type AnswerConfig = Omit<SamlConfig, 'cacheProvider'>;

/** To a worker (#951): an answer to check, or whether the assertion it named was recorded. */
export type ToWorker =
  | {
      readonly type: 'check';
      readonly answer: string;
      readonly config: AnswerConfig;
      readonly request: SignInRequest | undefined;
    }
  /** null: it could not be recorded (the database), which the server keeps. */
  | { readonly type: 'recorded'; readonly saved: boolean | null };

/**
 * From a worker: it can take answers; record this assertion once (`SeenAssertions`, the server's);
 * the assertion verified and read (none: the answer holds none); or why the answer was refused
 * (`status`: the identity provider's status was no success).
 */
export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'record'; readonly key: string; readonly until: number }
  | { readonly type: 'checked'; readonly assertion: XmlElement | undefined }
  | {
      readonly type: 'refused';
      readonly status: boolean;
      readonly why: string;
    };

/** This file's URL, the worker `SamlAnswerWorkers` starts (the .ts source in tests, else the built .js). */
export const WORKER_URL = import.meta.url;
/** The `workerData` of a worker that checks answers. */
export const WORKER_ROLE = 'openfolia-saml-answers';

/**
 * The node-saml cache for one sign-in (#376): the request it answers is the one this browser
 * began (its ID kept in the sealed cookie, never on the server), taken once; the assertions go to
 * `record` (the server's `SeenAssertions`, shared by every server), so none is accepted twice.
 */
export class OneSignIn implements CacheProvider {
  /** The request `begin` made. */
  saved: SignInRequest | undefined;
  private request: SignInRequest | undefined;
  private readonly record:
    ((key: string, until: number) => Promise<boolean>) | undefined;

  constructor(
    request: SignInRequest | undefined,
    record?: (key: string, until: number) => Promise<boolean>,
  ) {
    this.request = request;
    this.record = record;
  }

  saveAsync(key: string, value: string): Promise<CacheItem | null> {
    this.saved = { id: key, at: value };
    return Promise.resolve({ value, createdAt: Date.now() });
  }

  getAsync(key: string): Promise<string | null> {
    return Promise.resolve(key === this.request?.id ? this.request.at : null);
  }

  consumeAsync(key: string): Promise<string | null> {
    const request = this.request;
    if (request === undefined || key !== request.id) {
      return Promise.resolve(null);
    }
    this.request = undefined;
    return Promise.resolve(request.at);
  }

  removeAsync(key: string | null): Promise<string | null> {
    if (key !== null && key === this.request?.id) this.request = undefined;
    return Promise.resolve(null);
  }

  saveIfAbsentAsync(
    key: string,
    _value: string,
    expiresAtMs: number,
  ): Promise<boolean> {
    return this.record
      ? this.record(key, expiresAtMs)
      : Promise.reject(new Error('No assertion is recorded here.'));
  }
}

/**
 * node-saml for one sign-in, keeping the assertion it verified as our reader reads the signed bytes
 * (`signedAssertion`). Read from there, never from node-saml's `profile`, where an attribute
 * `nameID` stands in for a NameID the assertion does not have, and of two attributes of one name
 * one is kept (#934).
 */
class CheckedSaml extends SAML {
  assertion: XmlElement | undefined;

  // shortcut: a deprecated hook (it only adds a check here), private from node-saml 6 on; take the
  // signed bytes from what that version offers instead.
  protected override async getSignedAssertion(
    signedXml: string,
  ): Promise<string | null> {
    const read = await super.getSignedAssertion(signedXml);
    if (read !== null) this.assertion = signedAssertion(signedXml, read);
    return read;
  }
}

/**
 * Checks one answer, as the worker does: within its bounds (`checkAnswer`), then node-saml's
 * verified path, recording the assertion through `record`.
 */
async function check(
  job: Extract<ToWorker, { type: 'check' }>,
  record: (key: string, until: number) => Promise<boolean>,
): Promise<FromWorker> {
  try {
    checkAnswer(job.answer);
    const saml = new CheckedSaml({
      ...job.config,
      cacheProvider: new OneSignIn(job.request, record),
    });
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: job.answer,
    });
    return { type: 'checked', assertion: profile ? saml.assertion : undefined };
  } catch (error) {
    // The message names the check that failed and may quote the answer: its first line, cut.
    const why =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    return {
      type: 'refused',
      status: error instanceof SamlStatusError,
      why: (why.split(/[\r\n]/, 1)[0] ?? '').slice(0, 1000),
    };
  }
}

/** The worker: one answer at a time, as the server sends them. */
function serve(port: MessagePort): void {
  const send = (message: FromWorker) => port.postMessage(message);
  let recorded: ((saved: boolean | null) => void) | undefined;
  const record = (key: string, until: number) =>
    new Promise<boolean>((resolve, reject) => {
      recorded = (saved) =>
        saved === null
          ? reject(new Error('The assertion could not be recorded.'))
          : resolve(saved);
      send({ type: 'record', key, until });
    });
  port.on('message', (message: ToWorker) => {
    if (message.type === 'recorded') {
      recorded?.(message.saved);
      recorded = undefined;
    } else {
      void check(message, record).then(send);
    }
  });
  send({ type: 'ready' });
}

if (!isMainThread && workerData === WORKER_ROLE && parentPort) {
  serve(parentPort);
}
