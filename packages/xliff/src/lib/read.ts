import { OWN_NAMESPACE } from './inline.js';
import { XLIFF_NAMESPACE } from './write.js';
import {
  DEFAULT_XML_LIMITS,
  readXml,
  type XmlElement,
  type XmlLimits,
  type XmlNode,
  XmlReadError,
  type XmlRefusal,
} from '@openfolia/xml';

/** One `<segment>` as read: its ID (the part's field) and its source and target content, unparsed. */
export interface ReadSegment {
  readonly id: string;
  /** The `<source>`'s content. */
  readonly source: readonly XmlNode[];
  /** The `<target>`'s content; undefined when the segment has none. */
  readonly target: readonly XmlNode[] | undefined;
}

/** One `<unit>` as read. */
export interface ReadUnit {
  /** Its `id`: the block ID. */
  readonly blockId: string;
  /** `ccms:sourceHash`, when it has one. */
  readonly sourceHash: string | undefined;
  readonly segments: readonly ReadSegment[];
}

/** One `<file>` as read: a module. */
export interface ReadFile {
  /** Its `id`: the module ID. */
  readonly moduleId: string;
  readonly units: readonly ReadUnit[];
}

/** An XLIFF document as read: what `writeXliff` wrote, with the targets a translator added. */
export interface ReadXliff {
  readonly srcLang: string;
  readonly trgLang: string;
  /** The `ccms:` attributes of `<xliff>` (the job and the commit), by local name. */
  readonly meta: Readonly<Record<string, string>>;
  readonly files: readonly ReadFile[];
}

/**
 * Why a document is refused as a whole: an XML refusal (`XmlRefusal`), or
 * `not-xliff` (the root is no XLIFF 2.0 `<xliff>`) or `invalid-xliff` (an
 * XLIFF document missing what every one has: `srcLang`, `trgLang`, a
 * `<file>` with an `id`, a `<unit>` with an `id`, each ID once).
 */
export type XliffRefusal = XmlRefusal | 'not-xliff' | 'invalid-xliff';

export class XliffReadError extends Error {
  override readonly name = 'XliffReadError';

  constructor(
    readonly reason: XliffRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** The most units one document may hold, over all its files. */
export const MAX_READ_UNITS = 50_000;

/** The most `<file>`s (modules) one document holds. */
export const MAX_READ_FILES = 5_000;

const own = (local: string) => `{${OWN_NAMESPACE}}${local}`;

const isXliff = (node: XmlNode, local: string): node is XmlElement =>
  typeof node !== 'string' &&
  node.ns === XLIFF_NAMESPACE &&
  node.local === local;

const childrenOf = (element: XmlElement, local: string): XmlElement[] =>
  element.children.filter((c): c is XmlElement => isXliff(c, local));

/**
 * Reads an XLIFF 2.0 document back: its languages, the `ccms:` attributes
 * of `<xliff>`, and per `<file>` (a module) its `<unit>`s (blocks), each
 * with its `ccms:sourceHash` and its `<segment>`s' source and target
 * content as XML nodes, for `targetParts` to check against what was sent.
 * `<group>`s are read through; notes, `<ignorable>`s and elements of other
 * namespaces (a tool's own extensions) are skipped.
 *
 * The XML is read by `readXml`, strictly and within `limits`: no DTD and
 * no entities but the predefined ones, so nothing is fetched or expanded.
 * A document that is no XLIFF 2.0, or lacks what every one has, is refused
 * whole (`XliffReadError` with its `reason`); everything about one unit
 * is left for `targetParts` to judge, unit by unit.
 */
export function readXliff(
  xml: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): ReadXliff {
  let root: XmlElement;
  try {
    root = readXml(xml, limits);
  } catch (error) {
    if (error instanceof XmlReadError) {
      throw new XliffReadError(error.reason, error.message);
    }
    throw error;
  }
  const invalid = (message: string, at?: XmlElement): never => {
    throw new XliffReadError(
      'invalid-xliff',
      at === undefined ? message : `Line ${at.line}: ${message}`,
    );
  };
  if (root.ns !== XLIFF_NAMESPACE || root.local !== 'xliff') {
    throw new XliffReadError(
      'not-xliff',
      `The document is no XLIFF 2.0 document (its root is "${root.local}"${root.ns ? ` in ${root.ns}` : ''}).`,
    );
  }
  if (root.attributes.get('version') !== '2.0') {
    throw new XliffReadError(
      'not-xliff',
      `Only XLIFF 2.0 is read; the document says version "${root.attributes.get('version') ?? ''}".`,
    );
  }
  const srcLang = root.attributes.get('srcLang');
  const trgLang = root.attributes.get('trgLang');
  if (!srcLang) invalid('<xliff> has no srcLang.', root);
  if (!trgLang)
    invalid('<xliff> has no trgLang (the language translated into).', root);
  const meta: Record<string, string> = {};
  for (const [key, value] of root.attributes) {
    const prefix = `{${OWN_NAMESPACE}}`;
    if (key.startsWith(prefix)) {
      const local = key.slice(prefix.length);
      if (local !== '__proto__') meta[local] = value;
    }
  }
  const files: ReadFile[] = [];
  const fileIds = new Set<string>();
  let unitCount = 0;
  for (const file of childrenOf(root, 'file')) {
    if (files.length >= MAX_READ_FILES) {
      invalid(`The document holds more than ${MAX_READ_FILES} files.`);
    }
    const moduleId = file.attributes.get('id');
    if (!moduleId) invalid('A <file> has no id.', file);
    if (fileIds.has(moduleId as string)) {
      invalid(`The file "${moduleId}" is in the document twice.`, file);
    }
    fileIds.add(moduleId as string);
    const units: ReadUnit[] = [];
    const unitIds = new Set<string>();
    // A unit lies in the file or in groups in it, nested: depth first, in
    // document order, on a stack (its next element last).
    const pending: XmlElement[] = [];
    const pushChildren = (container: XmlElement) => {
      for (let i = container.children.length - 1; i >= 0; i--) {
        const child = container.children[i] as XmlNode;
        if (typeof child !== 'string') pending.push(child);
      }
    };
    pushChildren(file);
    while (pending.length > 0) {
      const child = pending.pop() as XmlElement;
      if (child.ns !== XLIFF_NAMESPACE) continue;
      if (child.local === 'group') {
        pushChildren(child);
        continue;
      }
      if (child.local !== 'unit') continue;
      const blockId = child.attributes.get('id');
      if (!blockId)
        invalid(`A <unit> in the file "${moduleId}" has no id.`, child);
      if (unitIds.has(blockId as string)) {
        invalid(
          `The unit "${blockId}" is in the file "${moduleId}" twice.`,
          child,
        );
      }
      unitIds.add(blockId as string);
      if (++unitCount > MAX_READ_UNITS) {
        invalid(`The document holds more than ${MAX_READ_UNITS} units.`);
      }
      units.push({
        blockId: blockId as string,
        sourceHash: child.attributes.get(own('sourceHash')),
        segments: childrenOf(child, 'segment').map((segment) => ({
          id: segment.attributes.get('id') ?? '',
          source: childrenOf(segment, 'source')[0]?.children ?? [],
          target: childrenOf(segment, 'target')[0]?.children,
        })),
      });
    }
    if (units.length === 0)
      invalid(`The file "${moduleId}" has no unit.`, file);
    files.push({ moduleId: moduleId as string, units });
  }
  if (files.length === 0) invalid('The document has no <file>.', root);
  return {
    srcLang: srcLang as string,
    trgLang: trgLang as string,
    meta,
    files,
  };
}
