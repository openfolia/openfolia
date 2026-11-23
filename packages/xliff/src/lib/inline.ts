import {
  placeholderText,
  MARK_ORDER,
  type Inline,
  type Mark,
  type TextNode,
} from '@openfolia/content-model';
import { attributes, inlineText } from './xml.js';

/**
 * The XLIFF namespace of the platform's own attributes (`ccms:`). Compatibility: the URI and the
 * `ccms:` prefix (and the `ccms:` subtypes below) keep the working name, so an XLIFF file exported
 * before the product was named still imports; an exchange format's identifiers never change.
 */
export const OWN_NAMESPACE = 'urn:ccms:xliff:1.0';

/**
 * How each mark becomes a `<pc>`: XLIFF's own `type` and, where XLIFF
 * names one, its `subType` (`xlf:b`, `xlf:i`); the rest name ours
 * (`ccms:…`). A link keeps its address in `ccms:href`, a term link its
 * term's ID in `ccms:term-id`.
 */
const MARK_CODES: Record<
  Mark['type'],
  { readonly type: string; readonly subType: string }
> = {
  strong: { type: 'fmt', subType: 'xlf:b' },
  emphasis: { type: 'fmt', subType: 'xlf:i' },
  code: { type: 'fmt', subType: 'ccms:code' },
  sub: { type: 'fmt', subType: 'ccms:sub' },
  sup: { type: 'fmt', subType: 'ccms:sup' },
  ui: { type: 'ui', subType: 'ccms:ui' },
  link: { type: 'link', subType: 'ccms:link' },
  term: { type: 'link', subType: 'ccms:term' },
};

/** Gives the inline codes of one unit their IDs: unique within the unit. */
export class CodeIds {
  #next = 1;

  next(): string {
    return String(this.#next++);
  }
}

const rank = (mark: Mark) => MARK_ORDER.indexOf(mark.type);

const sameMark = (a: Mark, b: Mark) =>
  a.type === b.type &&
  (a.type !== 'link' || (b.type === 'link' && a.href === b.href)) &&
  (a.type !== 'term' || (b.type === 'term' && a.termId === b.termId));

function openMark(mark: Mark, ids: CodeIds): string {
  const { type, subType } = MARK_CODES[mark.type];
  return `<pc${attributes([
    ['id', ids.next()],
    ['type', type],
    ['subType', subType],
    ['ccms:href', mark.type === 'link' ? mark.href : undefined],
    ['ccms:term-id', mark.type === 'term' ? mark.termId : undefined],
  ])}>`;
}

/**
 * Text runs as XLIFF: each mark a `<pc>`, opened in the model's canonical
 * order (`MARK_ORDER`), so neighbouring runs sharing their outer marks
 * share their `<pc>` too. Marks a run has that its neighbour lacks are
 * closed and opened again as needed; reading the result back and
 * normalizing it gives the same runs.
 */
function runs(nodes: readonly TextNode[], ids: CodeIds): string {
  let out = '';
  const open: Mark[] = [];
  for (const node of nodes) {
    const marks = [...(node.marks ?? [])].sort((a, b) => rank(a) - rank(b));
    let common = 0;
    while (
      common < open.length &&
      common < marks.length &&
      sameMark(open[common] as Mark, marks[common] as Mark)
    ) {
      common++;
    }
    out += '</pc>'.repeat(open.length - common);
    open.length = common;
    for (const mark of marks.slice(common)) {
      out += openMark(mark, ids);
      open.push(mark);
    }
    out += inlineText(node.text);
  }
  return out + '</pc>'.repeat(open.length);
}

/**
 * Inline content as the content of an XLIFF `<source>`:
 *
 * - text runs, with each mark a `<pc>` (`runs`);
 * - an attribute reference: `<ph subType="ccms:attribute" ccms:name>`;
 * - a cross-reference: a `<pc subType="ccms:xref">` around its own link
 *   text, which is translated; one without text is a `<ph>` (it shows the
 *   target's title, translated with the target); both name the target in
 *   `ccms:module` and `ccms:block`;
 * - a keyboard shortcut: `<ph subType="ccms:kbd">` with the keys as a
 *   JSON array in `ccms:keys` (keys are not translated);
 * - a page design's placeholder (#390): `<ph subType="ccms:placeholder">` with its
 *   key in `ccms:key` (not translated);
 * - a callout reference: `<ph subType="ccms:callout">` naming the image and
 *   the callout in `ccms:block` and `ccms:callout` (its number depends on
 *   the variant);
 * - a hard break: `<ph type="fmt" subType="xlf:lb">`.
 *
 * Every `<ph>` carries `disp`, what a translation tool shows for it.
 */
export function inlineContent(
  content: readonly Inline[],
  ids: CodeIds,
): string {
  let out = '';
  let pending: TextNode[] = [];
  const flush = () => {
    out += runs(pending, ids);
    pending = [];
  };
  for (const node of content) {
    if (node.type === 'text') {
      pending.push(node);
      continue;
    }
    flush();
    switch (node.type) {
      case 'attribute':
        out += `<ph${attributes([
          ['id', ids.next()],
          ['type', 'other'],
          ['subType', 'ccms:attribute'],
          ['disp', `{${node.name}}`],
          ['ccms:name', node.name],
        ])}/>`;
        break;
      case 'xref': {
        const target: [string, string | undefined][] = [
          ['ccms:module', node.module],
          ['ccms:block', node.block],
        ];
        out += node.text
          ? `<pc${attributes([
              ['id', ids.next()],
              ['type', 'link'],
              ['subType', 'ccms:xref'],
              ...target,
            ])}>${runs(node.text, ids)}</pc>`
          : `<ph${attributes([
              ['id', ids.next()],
              ['type', 'link'],
              ['subType', 'ccms:xref'],
              ['disp', `[${node.module}${node.block ? `#${node.block}` : ''}]`],
              ...target,
            ])}/>`;
        break;
      }
      case 'kbd':
        out += `<ph${attributes([
          ['id', ids.next()],
          ['type', 'ui'],
          ['subType', 'ccms:kbd'],
          ['disp', node.keys.join('+')],
          ['ccms:keys', JSON.stringify(node.keys)],
        ])}/>`;
        break;
      case 'placeholder':
        out += `<ph${attributes([
          ['id', ids.next()],
          ['type', 'other'],
          ['subType', 'ccms:placeholder'],
          ['disp', placeholderText(node.key)],
          ['ccms:key', node.key],
        ])}/>`;
        break;
      case 'calloutRef':
        // Its number depends on the variant: the translator sees the callout's ID.
        out += `<ph${attributes([
          ['id', ids.next()],
          ['type', 'other'],
          ['subType', 'ccms:callout'],
          ['disp', `(${node.callout})`],
          ['ccms:block', node.block],
          ['ccms:callout', node.callout],
        ])}/>`;
        break;
      case 'hardBreak':
        out += `<ph${attributes([
          ['id', ids.next()],
          ['type', 'fmt'],
          ['subType', 'xlf:lb'],
          ['equiv', '\n'],
        ])}/>`;
        break;
      default:
        node satisfies never;
    }
  }
  flush();
  return out;
}
