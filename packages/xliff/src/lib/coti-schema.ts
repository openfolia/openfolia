import { readXml, type XmlElement, XmlReadError } from '@openfolia/xml';
import { COTI_NAMESPACE, COTI_XML_LIMITS, MAX_COTI_FILE_REF } from './coti.js';

/**
 * The rules of the COTI standard's schema for `COTI.xml` (specification 1.1.2), written out
 * from its published element and attribute definitions, so a project description can be checked
 * without the schema file itself: the elements in their order and number, the attributes each
 * takes (required ones present, no others), and their value types (`yesNo`, the language code,
 * the MIME type, `xs:dateTime`, the enumerations, the relative file path's length).
 */

type Check = (value: string) => boolean;

const YES_NO: Check = (v) => v === 'yes' || v === 'no';
/** `xs:language` restricted to `<language>-<region>`. */
const LANGUAGE: Check = (v) => /^[a-zA-Z]{1,8}-[a-zA-Z0-9]{1,8}$/.test(v);
const MIME_TYPE: Check = (v) => /^[-\w]+\/[-\w+]+$/u.test(v);
const DATE_TIME: Check = (v) =>
  /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/.test(
    v,
  );
const ANY: Check = () => true;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    values.includes(v);
const RELATIVE_FILE_PATH: Check = (v) =>
  v.length >= 1 && v.length <= MAX_COTI_FILE_REF;

interface AttributeRule {
  readonly required: boolean;
  readonly check: Check;
}

const req = (check: Check = ANY): AttributeRule => ({ required: true, check });
const opt = (check: Check = ANY): AttributeRule => ({ required: false, check });

const FILE_ATTRIBUTES = {
  'mime-type': req(MIME_TYPE),
  encoding: opt(),
  'tms-id': opt(),
};

const ATTRIBUTES: Readonly<
  Record<string, Readonly<Record<string, AttributeRule>>>
> = {
  coti: {
    level: req(oneOf('1', '2', '3')),
    version: req(oneOf('1.0', '1.1')),
    creator: req(),
    'creation-date': req(DATE_TIME),
    'package-id': opt(),
    archive: opt(YES_NO),
    loglevel: opt(oneOf('0', '1', '2', '3', '4', '5')),
  },
  project: {
    name: req(),
    'project-id': req(),
    'checkout-date': req(DATE_TIME),
    proposal: req(YES_NO),
    'due-date': opt(DATE_TIME),
    comment: opt(),
    'tms-id': opt(),
  },
  subject: {},
  meta: { name: req(), value: req(), description: opt() },
  translation: {
    name: req(),
    'source-language': req(LANGUAGE),
    'target-language': req(LANGUAGE),
    status: opt(oneOf('none', 'proof', 'final')),
  },
  'translation-file': {
    'file-ref': req(RELATIVE_FILE_PATH),
    ...FILE_ATTRIBUTES,
    'creation-date': opt(DATE_TIME),
    'target-encoding': opt(),
    'content-id': opt(),
    type: opt(),
  },
  'reference-file': {
    'file-ref': req(),
    ...FILE_ATTRIBUTES,
    external: req(YES_NO),
    type: req(oneOf('stylesheet', 'schema', 'configuration', 'other')),
    description: opt(),
  },
};

/** Each element's children, in order: the element and how often it may come. */
const CONTENT: Readonly<
  Record<string, readonly (readonly [string, number, number])[]>
> = {
  coti: [['project', 1, 1]],
  project: [
    ['subject', 0, 1],
    ['meta', 0, Infinity],
    ['translation', 1, 1],
  ],
  translation: [
    ['translation-file', 1, Infinity],
    ['reference-file', 0, Infinity],
  ],
  meta: [],
  'translation-file': [],
  'reference-file': [],
};

function checkElement(element: XmlElement, errors: string[]): void {
  const where = `<${element.local}> (line ${element.line})`;
  if (element.ns !== COTI_NAMESPACE) {
    errors.push(`${where} is not in the COTI namespace.`);
    return;
  }
  const rules = ATTRIBUTES[element.local];
  if (!rules) {
    errors.push(`${where} is no COTI element.`);
    return;
  }
  for (const [name, value] of element.attributes) {
    const rule = rules[name];
    if (!rule) errors.push(`${where} has no attribute "${name}".`);
    else if (!rule.check(value)) {
      errors.push(`${where}: "${value}" is no valid ${name}.`);
    }
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.required && !element.attributes.has(name)) {
      errors.push(`${where} lacks the attribute "${name}".`);
    }
  }
  const elements = element.children.filter(
    (c): c is XmlElement => typeof c !== 'string',
  );
  if (element.local === 'subject') {
    if (elements.length > 0) errors.push(`${where} holds text only.`);
    return;
  }
  if (element.children.some((c) => typeof c === 'string' && c.trim() !== '')) {
    errors.push(`${where} holds no text.`);
  }
  const content = CONTENT[element.local] ?? [];
  let at = 0;
  for (const [local, min, max] of content) {
    let count = 0;
    while (
      at < elements.length &&
      elements[at]?.local === local &&
      elements[at]?.ns === COTI_NAMESPACE &&
      count < max
    ) {
      checkElement(elements[at] as XmlElement, errors);
      at++;
      count++;
    }
    if (count < min) errors.push(`${where} lacks <${local}>.`);
  }
  for (const extra of elements.slice(at)) {
    errors.push(
      `${where} does not take <${extra.local}> (line ${extra.line}) there.`,
    );
  }
}

/**
 * What the COTI standard's schema would refuse in `xml` (a `COTI.xml`), as messages; none when it
 * is valid. A document the strict reader refuses (a DTD, not well-formed) is one error.
 */
export function cotiSchemaErrors(xml: string): string[] {
  let root: XmlElement;
  try {
    root = readXml(xml, COTI_XML_LIMITS);
  } catch (error) {
    if (error instanceof XmlReadError) return [error.message];
    throw error;
  }
  if (root.local !== 'coti')
    return [`The root is <${root.local}>, not <coti>.`];
  const errors: string[] = [];
  checkElement(root, errors);
  return errors;
}
