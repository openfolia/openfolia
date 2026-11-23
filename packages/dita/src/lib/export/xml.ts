import { escapeXml } from '@openfolia/content-model';

/**
 * The XML the export writes, as a small tree: an element's name, its
 * attributes in order, its children. Every text and attribute value is
 * escaped once, when the tree is written (`escapeXml`: the five special
 * characters as references, characters XML 1.0 cannot hold as U+FFFD), so
 * no content of a module, a title or a value can open markup of its own.
 */
export interface El {
  readonly name: string;
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly children: readonly Node[];
}

export type Node = El | string;

/** An element; attributes whose value is `undefined` are left out. */
export function el(
  name: string,
  attrs: Readonly<Record<string, string | undefined>> = {},
  children: readonly (Node | undefined | false)[] = [],
): El {
  return {
    name,
    attrs: Object.entries(attrs).filter(
      (a): a is [string, string] => a[1] !== undefined,
    ),
    children: children.filter(
      (c): c is Node => c !== undefined && c !== false && c !== '',
    ),
  };
}

/** `element` with more attributes (those already set kept). */
export function withAttrs(
  element: El,
  attrs: ReadonlyArray<readonly [string, string]>,
): El {
  const own = new Set(element.attrs.map(([k]) => k));
  return {
    ...element,
    attrs: [...element.attrs, ...attrs.filter(([k]) => !own.has(k))],
  };
}

/** The number of nodes and characters of a tree: what writing it costs. */
export function cost(node: Node): { nodes: number; chars: number } {
  let nodes = 0;
  let chars = 0;
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    nodes++;
    if (typeof n === 'string') {
      chars += n.length;
      continue;
    }
    chars += n.name.length;
    for (const [k, v] of n.attrs) chars += k.length + v.length;
    for (const c of n.children) stack.push(c);
  }
  return { nodes, chars };
}

/** The phrase elements the export writes: whitespace beside them is content. */
// prettier-ignore
const PHRASES: ReadonlySet<string> = new Set([
  'ph', 'b', 'i', 'sub', 'sup', 'tt', 'codeph', 'uicontrol', 'userinput',
  'xref', 'term', 'keyword', 'tm', 'q', 'cite', 'line-through', 'u',
]);

/** A text longer than this is charged its escaped length before it is escaped. */
const LONG_TEXT = 64 * 1024;

/** The length `escapeXml` gives a text (each special character a reference; everything else one code unit, as U+FFFD is). */
function escapedLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38)
      length += 4; // &amp;
    else if (c === 60 || c === 62)
      length += 3; // &lt; &gt;
    else if (c === 34 || c === 39) length += 5; // &quot; &apos;
  }
  return length;
}

/**
 * Writes a tree. An element holding text or a phrase directly is written as it is, with
 * no whitespace added inside it (its text is mixed content); one holding
 * elements only gets each child on a line of its own, indented, which
 * DITA reads as no content. Iterative, so a deep tree costs no stack.
 */
export function writeXml(
  root: El,
  indentWith = '  ',
  charge?: (chars: number) => void,
): string {
  const parts: string[] = [];
  // Each piece is charged as it is made, so a caller's bound stops the writing, not the file once it is whole.
  const out = {
    push(piece: string) {
      charge?.(piece.length);
      parts.push(piece);
    },
  };
  type Frame =
    | { kind: 'open'; node: Node; depth: number; pretty: boolean }
    | { kind: 'close'; name: string; depth: number; pretty: boolean };
  const stack: Frame[] = [{ kind: 'open', node: root, depth: 0, pretty: true }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const pad = frame.pretty ? `\n${indentWith.repeat(frame.depth)}` : '';
    if (frame.kind === 'close') {
      out.push(`${pad}</${frame.name}>`);
      continue;
    }
    const node = frame.node;
    if (typeof node === 'string') {
      if (charge && node.length > LONG_TEXT) {
        // Charged before it is escaped, so a text past the bound is never escaped whole.
        charge(escapedLength(node));
        parts.push(escapeXml(node));
      } else {
        out.push(escapeXml(node));
      }
      continue;
    }
    const attrs = node.attrs
      .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
      .join('');
    if (node.children.length === 0) {
      out.push(`${frame.depth === 0 ? '' : pad}<${node.name}${attrs}/>`);
      continue;
    }
    out.push(`${frame.depth === 0 ? '' : pad}<${node.name}${attrs}>`);
    const mixed =
      !frame.pretty ||
      node.children.some((c) => typeof c === 'string' || PHRASES.has(c.name));
    stack.push({
      kind: 'close',
      name: node.name,
      depth: frame.depth,
      pretty: !mixed,
    });
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({
        kind: 'open',
        node: node.children[i] as Node,
        depth: frame.depth + 1,
        pretty: !mixed,
      });
    }
  }
  return parts.join('');
}

/** A whole DITA file: the XML declaration, the document type (for a topic or map) and the tree. */
export function ditaFile(
  root: El,
  doctype?: { readonly publicId: string; readonly systemId: string },
  charge?: (chars: number) => void,
): string {
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const type = doctype
    ? `<!DOCTYPE ${root.name} PUBLIC "${doctype.publicId}" "${doctype.systemId}">\n`
    : '';
  charge?.(head.length + type.length + 1);
  return `${head}${type}${writeXml(root, '  ', charge)}\n`;
}
