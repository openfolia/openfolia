import { isXmlChar } from './chars.js';

/** The namespace the `xml:` prefix is bound to, always. */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** An element, its name resolved against the namespaces in scope. */
export interface XmlElement {
  /** The namespace URI; undefined for none. */
  readonly ns: string | undefined;
  readonly local: string;
  /**
   * Its attributes (namespace declarations left out), by expanded name:
   * `local` for one without a namespace, `{uri}local` for one with.
   */
  readonly attributes: ReadonlyMap<string, string>;
  /** The namespaces it declares, by prefix (`''` for the default namespace, `xmlns`). */
  readonly declarations: ReadonlyMap<string, string>;
  /** Elements and text, in document order; neighbouring text joined. */
  readonly children: readonly XmlNode[];
  /** The line it starts on, for messages. */
  readonly line: number;
}

export type XmlNode = XmlElement | string;

/** What a document may hold before it is refused, all checked while reading. */
export interface XmlLimits {
  /** The longest document, in UTF-16 code units (about its characters). */
  readonly maxLength: number;
  /** The deepest nesting of elements. */
  readonly maxDepth: number;
  /** The most elements and text nodes. */
  readonly maxNodes: number;
  /** The most attributes on one element (namespace declarations included). */
  readonly maxAttributes: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxLength: 64 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 2_000_000,
  maxAttributes: 64,
};

/**
 * Why a document is refused, each a stable code:
 *
 * - `not-well-formed`: not XML (a tag not closed, an attribute twice, an
 *   unbound prefix, a character XML cannot carry, …);
 * - `dtd-forbidden`: a document type declaration (`<!DOCTYPE`, so no
 *   internal or external entities and no DTD at all) or a reference to an
 *   entity other than XML's five predefined ones;
 * - `too-large`, `too-deep`, `too-many-nodes`, `too-many-attributes`: past
 *   a limit;
 * - `unsupported-encoding`: an XML declaration naming any encoding but
 *   UTF-8.
 */
export type XmlRefusal =
  | 'not-well-formed'
  | 'dtd-forbidden'
  | 'too-large'
  | 'too-deep'
  | 'too-many-nodes'
  | 'too-many-attributes'
  | 'unsupported-encoding';

export class XmlReadError extends Error {
  override readonly name = 'XmlReadError';

  constructor(
    readonly reason: XmlRefusal,
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
  }
}

/**
 * How a reader treats a document type declaration:
 *
 * - `refuse` (the default): any `<!DOCTYPE` is refused (`dtd-forbidden`);
 * - `external-id`: one `<!DOCTYPE name>`, `<!DOCTYPE name SYSTEM "uri">` or
 *   `<!DOCTYPE name PUBLIC "id" "uri">` before the root element is skipped,
 *   its identifiers never opened (nothing is fetched or read). An internal
 *   subset (`[ … ]`), and so any entity declaration, is still refused, as is
 *   a second declaration or one after the root.
 */
export interface XmlReadOptions {
  readonly doctype?: 'refuse' | 'external-id';
}

/** The most namespace prefixes in scope at once. */
export const MAX_PREFIXES = 16;

const NO_PREFIXES: ReadonlyMap<string, string> = new Map();
const NO_DECLARATIONS: ReadonlyMap<string, string> = new Map();

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** An XML name (with an optional prefix), as far as this reader needs: letters, digits and `_ - . :`, beyond ASCII too. */
const NAME =
  /[A-Za-z_:À-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}][A-Za-z0-9_:.\-·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}]*/uy;
const SPACE = /[ \t\r\n]*/y;

interface Open {
  readonly qname: string;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly defaultNs: string | undefined;
  readonly line: number;
  readonly rawAttributes: readonly (readonly [string, string])[];
  readonly declarations: ReadonlyMap<string, string>;
  readonly children: XmlNode[];
}

/**
 * Reads an XML document into its root element, as a strict reader that
 * takes nothing on trust:
 *
 * - **No DTD at all**: a `<!DOCTYPE` anywhere is refused before anything
 *   in it is read, so there are no entity declarations, no external
 *   entities (nothing is ever fetched or opened) and no entity expansion;
 *   a reference to any entity but `&lt; &gt; &amp; &quot; &apos;` is
 *   refused too. Character references are read (and must name a
 *   character XML may hold).
 * - **Bounded**: the document's length, the depth of nesting, the number
 *   of nodes and of attributes per element are checked as it is read
 *   (`limits`); nothing recurses, so no input exhausts the stack.
 * - **Namespaces** are resolved (`xmlns`, `xmlns:<prefix>`, the fixed
 *   `xml:`); an unbound prefix is not well-formed.
 *
 * Comments and processing instructions are skipped; CDATA sections are
 * text. Attribute values are normalized as XML says (a literal tab, line
 * feed or carriage return is a space; a character reference keeps its
 * character); line ends in text become line feeds. Only UTF-8 is read: the
 * caller decodes the bytes, and an XML declaration naming another encoding
 * is refused.
 */
export function readXml(
  text: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
  options: XmlReadOptions = {},
): XmlElement {
  const allowDoctype = options.doctype === 'external-id';
  let doctypeSeen = false;
  if (text.length > limits.maxLength) {
    throw new XmlReadError(
      'too-large',
      `The document is longer than ${limits.maxLength} characters.`,
    );
  }
  // A byte-order mark, decoded already, is no content.
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let nodes = 0;
  let root: XmlElement | undefined;
  const stack: Open[] = [];

  const fail = (reason: XmlRefusal, message: string): never => {
    throw new XmlReadError(reason, message, line);
  };
  const malformed = (message: string): never =>
    fail('not-well-formed', message);
  const count = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (text.charCodeAt(i) === 0x0a) line++;
  };
  const countNode = () => {
    if (++nodes > limits.maxNodes) {
      fail(
        'too-many-nodes',
        `The document holds more than ${limits.maxNodes} nodes.`,
      );
    }
  };
  const checkChars = (value: string) => {
    for (const c of value) {
      if (!isXmlChar(c.codePointAt(0) as number)) {
        malformed(
          `U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')} is no character XML may hold.`,
        );
      }
    }
  };
  const name = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(text);
    if (!match) return malformed('A name is expected here.');
    at = NAME.lastIndex;
    return match[0];
  };
  const space = (): boolean => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    const moved = SPACE.lastIndex > at;
    count(at, SPACE.lastIndex);
    at = SPACE.lastIndex;
    return moved;
  };
  /** Text with its references resolved, `raw` holding none of `<`. */
  const unescape = (raw: string, attribute: boolean): string => {
    if (!raw.includes('&')) {
      return attribute ? raw.replace(/[\t\n]|\r\n?/g, ' ') : raw;
    }
    let out = '';
    let from = 0;
    for (;;) {
      const amp = raw.indexOf('&', from);
      const plain = raw.slice(from, amp === -1 ? undefined : amp);
      out += attribute ? plain.replace(/[\t\n]|\r\n?/g, ' ') : plain;
      if (amp === -1) return out;
      const semi = raw.indexOf(';', amp);
      if (semi === -1 || semi - amp > 12) {
        return malformed('A "&" that starts no reference; write "&amp;".');
      }
      const ref = raw.slice(amp + 1, semi);
      if (ref.startsWith('#')) {
        const code = /^#x[0-9a-fA-F]+$/.test(ref)
          ? parseInt(ref.slice(2), 16)
          : /^#[0-9]+$/.test(ref)
            ? parseInt(ref.slice(1), 10)
            : NaN;
        if (!Number.isFinite(code) || !isXmlChar(code)) {
          return malformed(`&${ref}; names no character XML may hold.`);
        }
        out += String.fromCodePoint(code);
      } else {
        // Own keys only: `&constructor;` is no predefined entity.
        const value = Object.hasOwn(PREDEFINED, ref)
          ? PREDEFINED[ref]
          : undefined;
        if (value === undefined) {
          return fail(
            'dtd-forbidden',
            `&${ref}; is an entity; only XML's five predefined entities are read, and no DTD declares others.`,
          );
        }
        out += value;
      }
      from = semi + 1;
    }
  };
  const addText = (value: string) => {
    if (value.length === 0) return;
    const open = stack[stack.length - 1];
    if (!open) {
      if (/[^ \t\r\n]/.test(value)) malformed('Text outside the root element.');
      return;
    }
    const last = open.children[open.children.length - 1];
    if (typeof last === 'string') {
      open.children[open.children.length - 1] = last + value;
    } else {
      countNode();
      open.children.push(value);
    }
  };
  const resolve = (
    qname: string,
    prefixes: ReadonlyMap<string, string>,
    defaultNs: string | undefined,
    attribute: boolean,
  ): { ns: string | undefined; local: string } => {
    const colon = qname.indexOf(':');
    if (colon === -1)
      return { ns: attribute ? undefined : defaultNs, local: qname };
    const prefix = qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (local.length === 0 || local.includes(':')) {
      return malformed(`"${qname}" is no qualified name.`);
    }
    const ns = prefix === 'xml' ? XML_NAMESPACE : prefixes.get(prefix);
    if (ns === undefined)
      return malformed(`The prefix "${prefix}" is not bound.`);
    return { ns, local };
  };

  // The XML declaration, when there is one, comes first.
  if (text.startsWith('<?xml', at) && /[ \t\r\n?]/.test(text[at + 5] ?? '')) {
    const end = text.indexOf('?>', at);
    if (end === -1) malformed('The XML declaration is not closed.');
    const declaration = text.slice(at, end);
    const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(declaration)?.[1];
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
      fail(
        'unsupported-encoding',
        `The document is in ${encoding}; only UTF-8 is read.`,
      );
    }
    const version = /version\s*=\s*["']([^"']*)["']/.exec(declaration)?.[1];
    if (version !== '1.0') malformed('Only XML 1.0 is read.');
    count(at, end);
    at = end + 2;
  }

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt !== at) {
      const end = lt === -1 ? text.length : lt;
      const raw = text.slice(at, end);
      if (raw.includes(']]>')) malformed('"]]>" in text; write "]]&gt;".');
      checkChars(raw);
      addText(unescape(raw.replace(/\r\n?/g, '\n'), false));
      count(at, end);
      at = end;
      if (lt === -1) break;
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end === -1) malformed('A comment is not closed.');
      count(at, end);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      if (stack.length === 0)
        malformed('A CDATA section outside the root element.');
      const end = text.indexOf(']]>', at + 9);
      if (end === -1) malformed('A CDATA section is not closed.');
      const raw = text.slice(at + 9, end);
      checkChars(raw);
      addText(raw.replace(/\r\n?/g, '\n'));
      count(at, end);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', at)) {
      // `<!DOCTYPE`, `<!ENTITY` or anything else of a DTD: never read.
      if (
        allowDoctype &&
        text.startsWith('<!DOCTYPE', at) &&
        /[ \t\r\n]/.test(text[at + 9] ?? '')
      ) {
        if (doctypeSeen || root !== undefined || stack.length > 0) {
          fail(
            'dtd-forbidden',
            'A document type declaration after the root element, or a second one.',
          );
        }
        doctypeSeen = true;
        at += 9;
        space();
        name();
        if (space()) {
          const literal = (pubid: boolean): void => {
            const quote = text[at];
            if (quote !== '"' && quote !== "'") {
              malformed('A quoted identifier is expected in the DOCTYPE.');
            }
            const end = text.indexOf(quote as string, at + 1);
            if (end === -1 || end - at > 2048) {
              malformed('An identifier of the DOCTYPE is not closed.');
            }
            const value = text.slice(at + 1, end);
            if (
              pubid &&
              !/^[ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/.test(value)
            ) {
              malformed(
                "The DOCTYPE's public identifier holds a character it may not.",
              );
            }
            checkChars(value);
            count(at, end);
            at = end + 1;
          };
          if (text.startsWith('PUBLIC', at)) {
            at += 6;
            if (!space()) malformed('A space is expected after PUBLIC.');
            literal(true);
            if (!space())
              malformed('A space is expected before the system identifier.');
            literal(false);
            space();
          } else if (text.startsWith('SYSTEM', at)) {
            at += 6;
            if (!space()) malformed('A space is expected after SYSTEM.');
            literal(false);
            space();
          }
        }
        if (text[at] === '[') {
          fail(
            'dtd-forbidden',
            'The document type declaration has an internal subset; no DTD is read, so no entity is declared.',
          );
        }
        if (text[at] !== '>') malformed('The DOCTYPE is not closed.');
        at += 1;
        continue;
      }
      if (
        /^<!DOCTYPE/i.test(text.slice(at, at + 9)) ||
        text.startsWith('<!ENTITY', at)
      ) {
        fail(
          'dtd-forbidden',
          'The document has a document type declaration (DOCTYPE); no DTD is read.',
        );
      }
      malformed('Markup declarations are not read.');
    }
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end === -1) malformed('A processing instruction is not closed.');
      const target =
        /^<\?([^ \t\r\n?]*)/.exec(text.slice(at, at + 64))?.[1] ?? '';
      if (target.toLowerCase() === 'xml') {
        malformed('The XML declaration may only come first.');
      }
      count(at, end);
      at = end + 2;
      continue;
    }
    if (text.startsWith('</', at)) {
      at += 2;
      const qname = name();
      space();
      if (text[at] !== '>')
        malformed(`The end tag of "${qname}" is not closed.`);
      at++;
      const open = stack.pop();
      if (!open) malformed(`An end tag "${qname}" closes nothing.`);
      if (open?.qname !== qname) {
        malformed(`"</${qname}>" closes "<${open?.qname}>".`);
      }
      close(open as Open);
      continue;
    }
    // A start tag.
    at++;
    const qname = name();
    const tagLine = line;
    const raw: [string, string][] = [];
    const seen = new Set<string>();
    let empty = false;
    for (;;) {
      const spaced = space();
      if (text[at] === '>') {
        at++;
        break;
      }
      if (text.startsWith('/>', at)) {
        at += 2;
        empty = true;
        break;
      }
      if (at >= text.length)
        malformed(`The start tag of "${qname}" is not closed.`);
      if (!spaced)
        malformed(`Attributes of "${qname}" need a space between them.`);
      const attribute = name();
      space();
      if (text[at] !== '=')
        malformed(`The attribute "${attribute}" has no value.`);
      at++;
      space();
      const quote = text[at];
      if (quote !== '"' && quote !== "'") {
        malformed(`The value of "${attribute}" is not quoted.`);
      }
      const end = text.indexOf(quote as string, at + 1);
      if (end === -1) malformed(`The value of "${attribute}" is not closed.`);
      const value = text.slice(at + 1, end);
      if (value.includes('<'))
        malformed(`The value of "${attribute}" holds "<".`);
      checkChars(value);
      count(at, end);
      at = end + 1;
      if (seen.has(attribute))
        malformed(`"${qname}" has the attribute "${attribute}" twice.`);
      seen.add(attribute);
      if (raw.length >= limits.maxAttributes) {
        fail(
          'too-many-attributes',
          `"${qname}" has more than ${limits.maxAttributes} attributes.`,
        );
      }
      raw.push([attribute, unescape(value, true)]);
    }
    if (root !== undefined && stack.length === 0) {
      malformed('A second root element.');
    }
    if (stack.length >= limits.maxDepth) {
      fail('too-deep', `Elements nest deeper than ${limits.maxDepth} levels.`);
    }
    countNode();
    const parent = stack[stack.length - 1];
    // The parent's prefixes, shared unless this element declares its own,
    // so a deep scope full of prefixes costs nothing per element.
    let prefixes: ReadonlyMap<string, string> = parent?.prefixes ?? NO_PREFIXES;
    let own: Map<string, string> | undefined;
    let defaultNs = parent?.defaultNs;
    let declarations: Map<string, string> | undefined;
    for (const [attribute, value] of raw) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) {
        (declarations ??= new Map()).set(attribute.slice(6), value);
      }
      if (attribute === 'xmlns') {
        defaultNs = value === '' ? undefined : value;
      } else if (attribute.startsWith('xmlns:')) {
        const prefix = attribute.slice(6);
        if (prefix === 'xml' || prefix === 'xmlns' || value === '') {
          malformed(`"${attribute}" cannot be declared so.`);
        }
        if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) {
          malformed(`"${value}" cannot be bound to a prefix.`);
        }
        own ??= new Map(prefixes);
        own.set(prefix, value);
        if (own.size > MAX_PREFIXES) {
          fail(
            'too-many-attributes',
            `More than ${MAX_PREFIXES} namespace prefixes are declared in scope.`,
          );
        }
      }
    }
    if (own) prefixes = own;
    const open: Open = {
      qname,
      prefixes,
      defaultNs,
      line: tagLine,
      rawAttributes: raw,
      declarations: declarations ?? NO_DECLARATIONS,
      children: [],
    };
    if (empty) {
      stack.push(open);
      close(stack.pop() as Open);
    } else {
      stack.push(open);
    }
  }
  if (stack.length > 0) {
    malformed(`"<${stack[stack.length - 1]?.qname}>" is not closed.`);
  }
  if (!root) malformed('The document has no root element.');
  return root as XmlElement;

  function close(open: Open): void {
    const { ns, local } = resolve(
      open.qname,
      open.prefixes,
      open.defaultNs,
      false,
    );
    const attributes = new Map<string, string>();
    for (const [attribute, value] of open.rawAttributes) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
      const named = resolve(attribute, open.prefixes, open.defaultNs, true);
      const key =
        named.ns === undefined ? named.local : `{${named.ns}}${named.local}`;
      if (attributes.has(key)) {
        malformed(`"${open.qname}" has the attribute "${key}" twice.`);
      }
      attributes.set(key, value);
    }
    const element: XmlElement = {
      ns,
      local,
      attributes,
      declarations: open.declarations,
      children: open.children,
      line: open.line,
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(element);
    } else {
      root = element;
    }
  }
}
