import {
  InlineContent,
  InlineTitle,
  MARK_ORDER,
  type Inline,
  type Mark,
  type TextNode,
  type TranslatablePart,
} from '@openfolia/content-model';
import { OWN_NAMESPACE, CodeIds, inlineContent } from './inline.js';
import type { ReadUnit } from './read.js';
import type { XliffUnit } from './units.js';
import { XLIFF_NAMESPACE } from './write.js';
import { readXml, type XmlElement, type XmlNode } from '@openfolia/xml';

/**
 * Why a unit's target is refused (`broken-markup`), each a stable code:
 *
 * - `missing-segment`, `extra-segment`: its segments are not those sent
 *   (one per part: `content`, an image's `alt` and `title`, …);
 * - `missing-target`: a segment has no `<target>`;
 * - `unsupported-markup`: an element in the target that is no `<pc>`,
 *   `<ph>` or `<cp>`, or one that is malformed (a `<ph>` with content, a
 *   `<cp>` naming no character);
 * - `unknown-code`: a `<pc>` or `<ph>` whose `id` the source has not;
 * - `code-mismatch`: one that is a `<pc>` in the source and a `<ph>` in
 *   the target (or the other way round), or that sits in another segment;
 * - `missing-code`, `extra-code`: a code of the source left out, or one
 *   given twice;
 * - `nesting`: a code in another `<pc>` than in the source (reordered
 *   across nesting);
 * - `line-break`: a line break typed in the text (the source's own are
 *   codes);
 * - `empty`: a segment with no text;
 * - `invalid-content`: what the target makes is no valid content (a line
 *   break in a title, say).
 */
export type TargetRefusal =
  | 'missing-segment'
  | 'extra-segment'
  | 'missing-target'
  | 'unsupported-markup'
  | 'unknown-code'
  | 'code-mismatch'
  | 'missing-code'
  | 'extra-code'
  | 'nesting'
  | 'line-break'
  | 'empty'
  | 'invalid-content';

export type TargetResult =
  | { readonly ok: true; readonly parts: readonly TranslatablePart[] }
  | {
      readonly ok: false;
      readonly reason: TargetRefusal;
      readonly detail: string;
    };

/** One inline code of the source as sent: what it is, where it sits, and its trusted attributes. */
interface SentCode {
  readonly element: 'pc' | 'ph';
  readonly field: string;
  /** The `<pc>` around it; undefined at the segment's top. */
  readonly parent: string | undefined;
  readonly code: XmlElement;
}

const own = (local: string) => `{${OWN_NAMESPACE}}${local}`;

/** Whether an element is in XLIFF's namespace (as every inline code is). */
const isCode = (node: XmlElement): boolean => node.ns === XLIFF_NAMESPACE;

/**
 * The source of each part of `sent` as the writer writes it, read back as
 * XML: the codes with their IDs (numbered across the unit's segments as
 * the writer numbers them), their nesting and their attributes. Made from
 * the content model, never from the uploaded file, so a target's codes
 * take their meaning (a link's address, a cross-reference's target, an
 * attribute's name) from what was sent, not from what came back.
 */
function sentSources(sent: XliffUnit): Map<string, readonly XmlNode[]> {
  const ids = new CodeIds();
  const sources = new Map<string, readonly XmlNode[]>();
  for (const part of sent.parts) {
    const xml = `<source xmlns="${XLIFF_NAMESPACE}" xmlns:ccms="${OWN_NAMESPACE}">${inlineContent(part.content, ids)}</source>`;
    sources.set(part.field, readXml(xml).children);
  }
  return sources;
}

/** Only white space: text runs of nothing else, and no code. */
const isBlank = (content: readonly Inline[]) =>
  content.every((node) => node.type === 'text' && node.text.trim() === '');

function codesOf(sources: ReadonlyMap<string, readonly XmlNode[]>) {
  const codes = new Map<string, SentCode>();
  for (const [field, nodes] of sources) {
    // A stack (the order of codes found does not matter here).
    const pending: { node: XmlNode; parent: string | undefined }[] = nodes.map(
      (node) => ({ node, parent: undefined }),
    );
    while (pending.length > 0) {
      const { node, parent } = pending.pop() as (typeof pending)[number];
      if (
        typeof node === 'string' ||
        !isCode(node) ||
        (node.local !== 'pc' && node.local !== 'ph')
      ) {
        continue;
      }
      const id = node.attributes.get('id') as string;
      codes.set(id, { element: node.local, field, parent, code: node });
      for (const child of node.children)
        pending.push({ node: child, parent: id });
    }
  }
  return codes;
}

class Refused extends Error {
  constructor(
    readonly reason: TargetRefusal,
    detail: string,
  ) {
    super(detail);
  }
}

/** The fields a part's content is a title in (no line breaks). */
const TITLE_FIELDS = new Set(['title', 'hazard', 'question', 'legend']);

/**
 * The translated parts of a unit from its `<target>`s, checked against
 * what was sent (`sent`: the unit as exported, from the content model):
 *
 * - one segment per part, each with a target;
 * - exactly the source's inline codes, each once, as the same element
 *   (`<pc>` or `<ph>`), in the same segment and inside the same `<pc>` as
 *   in the source; their order among their siblings may change (a
 *   translation moves words). Nothing else but text and `<cp>`.
 *
 * Each code means what it meant in the source: its attributes in the
 * target are not read, so a target can neither point a link elsewhere nor
 * name another attribute or module. Refused, with a reason
 * (`TargetRefusal`) and a detail naming the code, unit by unit.
 */
export function targetParts(sent: XliffUnit, read: ReadUnit): TargetResult {
  try {
    return { ok: true, parts: convert(sent, read) };
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, reason: error.reason, detail: error.message };
    }
    throw error;
  }
}

function convert(sent: XliffUnit, read: ReadUnit): TranslatablePart[] {
  const codes = codesOf(sentSources(sent));
  const fields = new Set(sent.parts.map((p) => p.field as string));
  const segments = new Map<string, ReadUnit['segments'][number]>();
  for (const segment of read.segments) {
    if (!fields.has(segment.id) || segments.has(segment.id)) {
      throw new Refused(
        'extra-segment',
        `The segment "${segment.id}" was not sent${segments.has(segment.id) ? ' twice' : ''}.`,
      );
    }
    segments.set(segment.id, segment);
  }
  const seen = new Set<string>();
  const parts: TranslatablePart[] = [];
  for (const part of sent.parts) {
    const segment = segments.get(part.field);
    if (!segment) {
      throw new Refused(
        'missing-segment',
        `The segment "${part.field}" is missing.`,
      );
    }
    if (segment.target === undefined) {
      throw new Refused(
        'missing-target',
        `The segment "${part.field}" has no target.`,
      );
    }
    const content = inline(segment.target, part.field, codes, seen);
    if (content.length === 0 || isBlank(content)) {
      throw new Refused('empty', `The target of "${part.field}" has no text.`);
    }
    const schema = TITLE_FIELDS.has(part.field) ? InlineTitle : InlineContent;
    if (!schema.safeParse(content).success) {
      throw new Refused(
        'invalid-content',
        `The target of "${part.field}" is no valid ${TITLE_FIELDS.has(part.field) ? 'title' : 'text'}.`,
      );
    }
    parts.push({ field: part.field, content });
  }
  for (const [id, code] of codes) {
    if (!seen.has(id)) {
      throw new Refused(
        'missing-code',
        `The code ${id} (<${code.element}>) of the segment "${code.field}" is missing from the target.`,
      );
    }
  }
  return parts;
}

/** What one text run is marked with, in the model's order. */
const MARKS: Readonly<Record<string, Mark['type']>> = {
  'xlf:b': 'strong',
  'xlf:i': 'emphasis',
  'ccms:code': 'code',
  'ccms:sub': 'sub',
  'ccms:sup': 'sup',
  'ccms:ui': 'ui',
  'ccms:link': 'link',
  'ccms:term': 'term',
};

function inline(
  nodes: readonly XmlNode[],
  field: string,
  codes: ReadonlyMap<string, SentCode>,
  seen: Set<string>,
): Inline[] {
  const out: Inline[] = [];
  /** Where text goes: the segment, or an open cross-reference's text. */
  let runs: Inline[] = out;
  type Pending = {
    node: XmlNode | 'close';
    parent: string | undefined;
    marks: readonly Mark[];
  };
  // A stack, its next node last: `pop` and `push` cost the same however
  // large the target (`shift` and `unshift` would not).
  const pending: Pending[] = [];
  const pushAll = (items: readonly Pending[]) => {
    for (let i = items.length - 1; i >= 0; i--)
      pending.push(items[i] as Pending);
  };
  pushAll(nodes.map((node) => ({ node, parent: undefined, marks: [] })));
  const pushText = (text: string, marks: readonly Mark[]) => {
    if (text.length === 0) return;
    if (/[\r\n]/.test(text)) {
      throw new Refused(
        'line-break',
        `The target of "${field}" has a line break in its text; the source's line breaks are codes.`,
      );
    }
    const sorted = [...marks].sort(
      (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
    );
    const last = runs[runs.length - 1];
    if (last?.type === 'text' && sameMarks(last.marks ?? [], sorted)) {
      runs[runs.length - 1] = { ...last, text: last.text + text };
      return;
    }
    runs.push({
      type: 'text',
      text,
      ...(sorted.length > 0 && { marks: sorted }),
    });
  };
  let xref: Extract<Inline, { type: 'xref' }> | undefined;
  while (pending.length > 0) {
    const { node, parent, marks } = pending.pop() as Pending;
    if (node === 'close') {
      // The end of a cross-reference's text.
      if (xref) {
        out.push(
          runs.length > 0 ? { ...xref, text: runs as TextNode[] } : xref,
        );
      }
      xref = undefined;
      runs = out;
      continue;
    }
    if (typeof node === 'string') {
      pushText(node, marks);
      continue;
    }
    if (!isCode(node)) {
      throw new Refused(
        'unsupported-markup',
        `The target of "${field}" holds <${node.local}>, which is no XLIFF inline code here.`,
      );
    }
    if (node.local === 'cp') {
      const hex = node.attributes.get('hex') ?? '';
      const cp = /^[0-9A-Fa-f]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN;
      if (
        !Number.isFinite(cp) ||
        cp > 0x10ffff ||
        cp === 0 ||
        (cp >= 0xd800 && cp <= 0xdfff) ||
        node.children.length > 0
      ) {
        throw new Refused(
          'unsupported-markup',
          `A <cp> in "${field}" names no character.`,
        );
      }
      pushText(String.fromCodePoint(cp), marks);
      continue;
    }
    if (node.local !== 'pc' && node.local !== 'ph') {
      throw new Refused(
        'unsupported-markup',
        `The target of "${field}" holds <${node.local}>; only <pc>, <ph> and <cp> are read.`,
      );
    }
    const id = node.attributes.get('id');
    const code = id === undefined ? undefined : codes.get(id);
    if (id === undefined || !code) {
      throw new Refused(
        'unknown-code',
        `The target of "${field}" has a <${node.local}>${id === undefined ? ' without an id' : ` with the id ${id}`} that the source has not.`,
      );
    }
    if (code.element !== node.local || code.field !== field) {
      throw new Refused(
        'code-mismatch',
        `The code ${id} is a <${code.element}> in the segment "${code.field}" of the source, not a <${node.local}> in "${field}".`,
      );
    }
    if (seen.has(id)) {
      throw new Refused('extra-code', `The code ${id} is in the target twice.`);
    }
    seen.add(id);
    if (code.parent !== parent) {
      throw new Refused(
        'nesting',
        `The code ${id} lies ${code.parent === undefined ? 'outside every <pc>' : `inside <pc id="${code.parent}">`} in the source, not ${parent === undefined ? 'outside' : `inside <pc id="${parent}">`}.`,
      );
    }
    const subType = code.code.attributes.get('subType') ?? '';
    if (node.local === 'ph') {
      if (node.children.length > 0) {
        throw new Refused(
          'unsupported-markup',
          `The <ph id="${id}"> has content.`,
        );
      }
      const found = placeholder(code.code, subType);
      if (runs !== out) {
        // Only text inside a cross-reference; the source had none there.
        throw new Refused(
          'nesting',
          `The code ${id} lies inside a cross-reference.`,
        );
      }
      out.push(found);
      continue;
    }
    // A <pc>: a mark around its content, or a cross-reference with text.
    const children = node.children.map((child) => ({
      node: child,
      parent: id,
      marks,
    }));
    if (subType === 'ccms:xref') {
      xref = {
        type: 'xref',
        module: code.code.attributes.get(own('module')) as string,
        ...(code.code.attributes.has(own('block')) && {
          block: code.code.attributes.get(own('block')) as string,
        }),
      };
      runs = [];
      pushAll([...children, { node: 'close', parent, marks }]);
      continue;
    }
    const type = MARKS[subType];
    if (type === undefined) {
      throw new Refused('unknown-code', `The code ${id} is of no known kind.`);
    }
    const mark: Mark =
      type === 'link'
        ? { type, href: code.code.attributes.get(own('href')) as string }
        : type === 'term'
          ? {
              type,
              termId: code.code.attributes.get(own('term-id')) as string,
            }
          : { type };
    const marked = [...marks, mark];
    pushAll(children.map((child) => ({ ...child, marks: marked })));
  }
  return out;
}

/** The inline node a `<ph>` of the source stands for. */
function placeholder(code: XmlElement, subType: string): Inline {
  switch (subType) {
    case 'ccms:attribute':
      return {
        type: 'attribute',
        name: code.attributes.get(own('name')) as string,
      };
    case 'ccms:kbd':
      return {
        type: 'kbd',
        keys: JSON.parse(
          code.attributes.get(own('keys')) as string,
        ) as string[],
      };
    case 'ccms:xref': {
      const block = code.attributes.get(own('block'));
      return {
        type: 'xref',
        module: code.attributes.get(own('module')) as string,
        ...(block !== undefined && { block }),
      };
    }
    case 'ccms:placeholder':
      return {
        type: 'placeholder',
        key: code.attributes.get(own('key')) as string,
      };
    case 'ccms:callout':
      return {
        type: 'calloutRef',
        block: code.attributes.get(own('block')) as string,
        callout: code.attributes.get(own('callout')) as string,
      };
    case 'xlf:lb':
      return { type: 'hardBreak' };
    default:
      throw new Refused(
        'unknown-code',
        `A code is of no known kind (${subType}).`,
      );
  }
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (mark, i) =>
        mark.type === b[i]?.type &&
        (mark.type !== 'link' ||
          (b[i]?.type === 'link' &&
            mark.href === (b[i] as { href: string }).href)) &&
        (mark.type !== 'term' ||
          (b[i]?.type === 'term' &&
            mark.termId === (b[i] as { termId: string }).termId)),
    )
  );
}
