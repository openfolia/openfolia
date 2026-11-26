import type { XmlElement, XmlNode } from '@openfolia/xml';
import {
  attr,
  elements,
  isTopic,
  nameOf,
  pushAll,
  withChildren,
} from './elements.js';
import type { KeySpace } from './keys.js';
import type { DitaDoc, Project, TopicIndex } from './load.js';
import { resolvePath, splitReference } from './paths.js';
import type { DitaReport } from './report.js';

/** How deep content references may nest (a conref in content a conref brought in, …). */
export const MAX_CONREF_DEPTH = 16;
/** The most elements conrefs may bring into one module. */
export const MAX_MODULE_EXPANSION = 200_000;
/** The most elements conrefs may bring into one import. */
export const MAX_IMPORT_EXPANSION = 2_000_000;
/** The most characters of text references and keys bring into one topic: text is charged by its length, not as one node. */
export const MAX_MODULE_EXPANSION_CHARS = 4 * 1024 * 1024;
/** The most characters of text references and keys bring into one import. */
export const MAX_IMPORT_EXPANSION_CHARS = 16 * 1024 * 1024;

/** The attribute a copied element carries the path of the file it came from in, for its own references. */
export const BASE = '{urn:openfolia:dita}base';
/** The synthetic element a conref to a whole top-level topic becomes: a module reference. */
export const MODULE_REF = '{urn:openfolia:dita}module-ref';

/** The `@outputclass` token the export marks a module reference's content reference with (#433). */
export const MODULE_REF_CLASS = 'openfolia-module-reference';
/**
 * Compatibility, for one release: the mark an export made before the product was named, read as
 * `MODULE_REF_CLASS` on import. Never written.
 */
export const LEGACY_MODULE_REF_CLASS = 'ccms-module-reference';

/** Thrown when an import would expand past its bounds: the module (or the import) is refused. */
export class ExpansionLimitError extends Error {
  override readonly name = 'ExpansionLimitError';
}

/** The count of elements conrefs brought in, per module and for the whole import. */
export class ExpansionBudget {
  private total = 0;
  private module = 0;
  private totalChars = 0;
  private moduleChars = 0;

  startModule(): void {
    this.module = 0;
    this.moduleChars = 0;
  }

  spend(count: number, chars = 0): void {
    this.module += count;
    this.total += count;
    this.moduleChars += chars;
    this.totalChars += chars;
    if (this.moduleChars > MAX_MODULE_EXPANSION_CHARS) {
      throw new ExpansionLimitError(
        `Content references and keys bring more than ${MAX_MODULE_EXPANSION_CHARS} characters of text into one topic.`,
      );
    }
    if (this.totalChars > MAX_IMPORT_EXPANSION_CHARS) {
      throw new ExpansionLimitError(
        `Content references and keys bring more than ${MAX_IMPORT_EXPANSION_CHARS} characters of text into the import.`,
      );
    }
    if (this.module > MAX_MODULE_EXPANSION) {
      throw new ExpansionLimitError(
        `Content references bring more than ${MAX_MODULE_EXPANSION} elements into one topic.`,
      );
    }
    if (this.total > MAX_IMPORT_EXPANSION) {
      throw new ExpansionLimitError(
        `Content references bring more than ${MAX_IMPORT_EXPANSION} elements into the import.`,
      );
    }
  }
}

/** Each parent's child elements and their positions, made once per parent (ranges look them up). */
const SIBLINGS = new WeakMap<
  XmlElement,
  { list: XmlElement[]; at: Map<XmlElement, number> }
>();
function siblingsOf(parent: XmlElement) {
  let found = SIBLINGS.get(parent);
  if (!found) {
    const list = elements(parent);
    found = { list, at: new Map(list.map((e, i) => [e, i])) };
    SIBLINGS.set(parent, found);
  }
  return found;
}

/** The file whose references an element's attributes are relative to. */
export const baseOf = (element: XmlElement, doc: DitaDoc) =>
  element.attributes.get(BASE) ?? doc.path;

/** A DITA fragment (`topicid`, `topicid/elementid`, `./elementid`) resolved in `doc`. */
export function findTarget(
  doc: DitaDoc,
  fragment: string | undefined,
  here: TopicIndex | undefined,
): { topic: TopicIndex; element: XmlElement } | undefined {
  if (fragment === undefined) {
    const topic = doc.firstTopic;
    return topic && { topic, element: topic.element };
  }
  const slash = fragment.indexOf('/');
  const topicId = slash === -1 ? fragment : fragment.slice(0, slash);
  const topic = topicId === '.' ? here : (doc.topics.get(topicId) ?? undefined);
  if (!topic) return undefined;
  if (slash === -1) return { topic, element: topic.element };
  const element = topic.byId.get(fragment.slice(slash + 1));
  return element && { topic, element };
}

interface Frame {
  readonly doc: DitaDoc;
  readonly topic: TopicIndex | undefined;
}

/**
 * Resolves `@conref`, `@conkeyref` and `@conrefend` (DITA 1.3, 2.4.2 and
 * 3.12.13): an element that references content is replaced by a copy of
 * the content it references (a range of siblings for `@conrefend`), its own
 * attributes over the target's (but `-dita-use-conref-target`); a
 * `@conkeyref` whose key is undefined falls back to `@conref`. A topic
 * referencing a whole top-level topic becomes a module reference. Pushing
 * content (`@conaction`) is not read: the element is left out, reported.
 * Bounded: references nest at most `MAX_CONREF_DEPTH` deep, a cycle is
 * cut and reported, and the elements brought in are counted against
 * `ExpansionBudget` (an amplification by nested references stops there).
 * Nothing is fetched: every target is a file of the archive, read already.
 */
export class Conrefs {
  constructor(
    private readonly project: Project,
    private readonly keys: KeySpace | undefined,
    private readonly report: DitaReport,
    private readonly budget: ExpansionBudget,
  ) {}

  /** `element` with every content reference in it resolved. */
  expand(element: XmlElement, doc: DitaDoc, topic: TopicIndex): XmlElement {
    const out = this.node(element, { doc, topic }, 0, []);
    const first = out.find((n): n is XmlElement => typeof n !== 'string');
    return first ?? withChildren(element, []);
  }

  private node(
    element: XmlElement,
    frame: Frame,
    depth: number,
    chain: readonly string[],
  ): XmlNode[] {
    const conaction = attr(element, 'conaction');
    if (conaction !== undefined && conaction !== '-dita-use-conref-target') {
      this.report.add(
        'conaction',
        {
          source: `${baseOf(element, frame.doc)}#${attr(element, 'id') ?? ''}`,
          kind: element.local,
        },
        `Pushed content (@conaction="${conaction}") is not imported; the element is left out.`,
      );
      return [];
    }
    if (
      attr(element, 'conref') !== undefined ||
      attr(element, 'conkeyref') !== undefined
    ) {
      const replaced = this.resolve(element, frame, depth, chain);
      if (replaced) return replaced;
    }
    return [this.children(element, frame, depth, chain)];
  }

  private children(
    element: XmlElement,
    frame: Frame,
    depth: number,
    chain: readonly string[],
  ): XmlElement {
    if (elements(element).length === 0) return element;
    const inner =
      isTopic(element) && frame.doc.topics.get(attr(element, 'id') ?? '')
        ? { ...frame, topic: frame.doc.topics.get(attr(element, 'id') ?? '') }
        : frame;
    const children: XmlNode[] = [];
    let changed = false;
    for (const c of element.children) {
      if (typeof c === 'string') {
        children.push(c);
        continue;
      }
      const out = this.node(c, inner, depth, chain);
      if (out.length !== 1 || out[0] !== c) changed = true;
      pushAll(children, out);
    }
    return changed ? withChildren(element, children) : element;
  }

  /** The content `element` references, resolved; undefined to keep the element as it is. */
  private resolve(
    element: XmlElement,
    frame: Frame,
    depth: number,
    chain: readonly string[],
  ): XmlNode[] | undefined {
    const from = baseOf(element, frame.doc);
    const place = {
      source: `${from}#${attr(element, 'id') ?? ''}`,
      kind: element.local,
    };
    const target = this.target(element, frame, from);
    if (!target) {
      this.report.add(
        'unresolved-conref',
        place,
        `The content reference ${describe(element)} names nothing in the archive; the element's own content is kept.`,
      );
      return undefined;
    }
    const key = `${target.doc.path}#${target.topic.id}/${attr(target.element, 'id') ?? ''}`;
    if (chain.includes(key) || depth >= MAX_CONREF_DEPTH) {
      this.report.add(
        'conref-cycle',
        place,
        depth >= MAX_CONREF_DEPTH
          ? `Content references nest deeper than ${MAX_CONREF_DEPTH}; this one is not followed.`
          : `The content reference ${describe(element)} leads back to itself; it is not followed.`,
      );
      return undefined;
    }
    if (nameOf(element) !== nameOf(target.element)) {
      this.report.add(
        'unresolved-conref',
        place,
        `The content reference ${describe(element)} names a <${target.element.local}>, not a <${element.local}>; the element's own content is kept.`,
      );
      return undefined;
    }
    // A topic referencing a whole top-level topic: the module it is.
    if (isTopic(element) && target.element === target.topic.element) {
      if (target.topic.topLevel) {
        return [
          {
            ns: undefined,
            local: MODULE_REF,
            attributes: new Map([
              ['path', target.doc.path],
              ['topic', target.topic.id],
              ...(attr(element, 'id') !== undefined
                ? ([['id', attr(element, 'id') as string]] as const)
                : []),
            ]),
            declarations: new Map(),
            children: [],
            line: element.line,
          },
        ];
      }
    }
    const range = this.range(element, target, frame, place);
    // A module reference as the export writes one (#433): marked, and all
    // of a top-level topic's content; the module it is. Unmarked, a range
    // is copied in, whatever it covers.
    const marked =
      !isTopic(element) &&
      (attr(element, 'outputclass') ?? '')
        .split(/\s+/)
        .some((c) => c === MODULE_REF_CLASS || c === LEGACY_MODULE_REF_CLASS);
    // Charged as the elements it covers, as a copy of them would be: the check is linear in them.
    if (marked) this.budget.spend(range.length);
    if (marked && this.wholeTopic(target.topic, range)) {
      return [
        {
          ns: undefined,
          local: MODULE_REF,
          attributes: new Map([
            ['path', target.doc.path],
            ['topic', target.topic.id],
            ...(attr(element, 'id') !== undefined
              ? ([['id', attr(element, 'id') as string]] as const)
              : []),
          ]),
          declarations: new Map(),
          children: [],
          line: element.line,
        },
      ];
    }
    const next = [...chain, key];
    const copied: XmlNode[] = [];
    range.forEach((item, i) => {
      const own = i === 0 ? merged(element, item) : item;
      const copy = this.copy(own, target.doc.path);
      copied.push(
        ...this.node(
          copy,
          { doc: target.doc, topic: target.topic },
          depth + 1,
          next,
        ),
      );
    });
    return copied;
  }

  /**
   * Whether `range` is every element of a top-level topic's content: its
   * body's children, or those of the one element its body holds (a
   * reference's untitled section, a task's context), the topic holding
   * no nested topic.
   */
  /** Per topic: its body when it has one and no nested topic, worked out once. */
  private readonly whole = new WeakMap<XmlElement, XmlElement | null>();

  private bodyOfWhole(topic: XmlElement): XmlElement | null {
    let body = this.whole.get(topic);
    if (body === undefined) {
      const children = siblingsOf(topic).list;
      body = children.some((c) => isTopic(c))
        ? null
        : (children.find((c) => /body$/i.test(c.local)) ?? null);
      this.whole.set(topic, body);
    }
    return body;
  }

  /**
   * Whether `range` is a whole topic's content. The topic's children are looked at once per
   * topic (`bodyOfWhole`), and the rest costs no more than `range.length`, already charged, so
   * many marked references to one large topic stay linear.
   */
  private wholeTopic(topic: TopicIndex, range: readonly XmlElement[]): boolean {
    const first = range[0];
    if (!topic.topLevel || first === undefined) return false;
    const body = this.bodyOfWhole(topic.element);
    if (!body) return false;
    const parent = this.project.parents.get(first);
    if (!parent) return false;
    if (parent !== body) {
      const inBody = siblingsOf(body).list;
      if (inBody.length !== 1 || inBody[0] !== parent) return false;
    }
    const all = siblingsOf(parent).list;
    if (range.length !== all.length) return false;
    if (parent !== body && all.some((c) => c.local === 'title')) return false;
    return range.every((e, i) => e === all[i]);
  }

  private target(
    element: XmlElement,
    frame: Frame,
    from: string,
  ): { doc: DitaDoc; topic: TopicIndex; element: XmlElement } | undefined {
    const conkeyref = attr(element, 'conkeyref');
    if (conkeyref !== undefined && this.keys) {
      const slash = conkeyref.indexOf('/');
      const key = slash === -1 ? conkeyref : conkeyref.slice(0, slash);
      const def = this.keys.get(key);
      if (def?.target) {
        const doc = this.project.docs.get(def.target.path);
        if (doc) {
          const topicId =
            def.target.fragment ?? doc.firstTopic?.id ?? undefined;
          const fragment =
            slash === -1
              ? topicId
              : `${topicId ?? ''}/${conkeyref.slice(slash + 1)}`;
          const found = findTarget(doc, fragment, undefined);
          if (found) return { doc, ...found };
        }
      }
    }
    const conref = attr(element, 'conref');
    if (conref === undefined) return undefined;
    const ref = splitReference(conref);
    if (!ref) return undefined;
    const path = ref.path === '' ? from : resolvePath(from, ref.path);
    const doc = path === undefined ? undefined : this.project.docs.get(path);
    if (!doc) return undefined;
    const found = findTarget(
      doc,
      ref.fragment,
      doc.path === frame.doc.path ? frame.topic : undefined,
    );
    return found && { doc, ...found };
  }

  /** The target, or with `@conrefend` its siblings up to the end element. */
  private range(
    element: XmlElement,
    target: { doc: DitaDoc; topic: TopicIndex; element: XmlElement },
    frame: Frame,
    place: { source: string; kind: string },
  ): XmlElement[] {
    const end = attr(element, 'conrefend');
    if (end === undefined) return [target.element];
    const ref = splitReference(end);
    const last =
      ref &&
      findTarget(
        target.doc,
        ref.fragment === undefined
          ? undefined
          : ref.fragment.includes('/')
            ? // With @conkeyref, the start's topic stands in for the end's (DITA 1.3, 3.12.13.8).
              `${target.topic.id}/${ref.fragment.slice(ref.fragment.indexOf('/') + 1)}`
            : ref.fragment,
        target.topic,
      )?.element;
    const parent = this.project.parents.get(target.element);
    const siblings = parent ? siblingsOf(parent) : undefined;
    const from = siblings?.at.get(target.element) ?? -1;
    const to = (last && siblings?.at.get(last)) ?? -1;
    if (from === -1 || to < from) {
      this.report.add(
        'unresolved-conref',
        place,
        `The range's end (@conrefend="${end}") is no later sibling of its start; only the start is used.`,
      );
      return [target.element];
    }
    return (siblings?.list ?? []).slice(from, to + 1);
  }

  /** A deep copy of `element`, each element marked with the file its references are relative to, counted. */
  private copy(element: XmlElement, base: string): XmlElement {
    // Charged per element as it is made, so a copy past the budget stops at once.
    // Recursion is bounded: the reader's depth (64) times the conref depth (16).
    const clone = (e: XmlElement): XmlElement => {
      // Text and attribute values alike: both are put in again with every copy.
      let chars = 0;
      for (const c of e.children) if (typeof c === 'string') chars += c.length;
      for (const value of e.attributes.values()) chars += value.length;
      this.budget.spend(1, chars);
      const attributes = new Map(e.attributes);
      if (!attributes.has(BASE)) attributes.set(BASE, base);
      return withChildren(
        e,
        e.children.map((c) => (typeof c === 'string' ? c : clone(c))),
        attributes,
      );
    };
    return clone(element);
  }
}

/** The referencing element's attributes over the target's (DITA 1.3, 2.4.2.3), the reference itself dropped. */
function merged(referencing: XmlElement, target: XmlElement): XmlElement {
  const attributes = new Map(target.attributes);
  for (const [name, value] of referencing.attributes) {
    if (name === 'conref' || name === 'conkeyref' || name === 'conrefend') {
      continue;
    }
    if (value === '-dita-use-conref-target') continue;
    // The file the target's references are relative to is the target's own.
    if (name === BASE) continue;
    attributes.set(name, value);
  }
  // The target's own references stay: they are resolved in turn (a chain), the cycle check bounding it.
  return withChildren(target, target.children, attributes);
}

function describe(element: XmlElement): string {
  const conkeyref = attr(element, 'conkeyref');
  const conref = attr(element, 'conref');
  return [
    conkeyref !== undefined ? `@conkeyref="${conkeyref}"` : undefined,
    conref !== undefined ? `@conref="${conref}"` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}
