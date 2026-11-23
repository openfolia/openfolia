import {
  type Attribute,
  type Extensions,
  Mark,
  Node,
  type NodeConfig,
  getSchema,
} from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import {
  isLinkHref,
  isTermId,
  placeholderText,
} from '@openfolia/content-model';
import { isRecord } from './json.js';
import {
  type AttrDef,
  type AttrKind,
  MARK_ATTRS,
  MARK_NAMES,
  NODE_ATTRS,
  type NodeName,
} from './spec.js';

/**
 * The editor's schema as TipTap extensions, built from the table in
 * `spec.ts`. Headless: no node views, menus or key bindings (the editor adds
 * those). The HTML they render and parse carries every attribute in a
 * `data-*` attribute, so copy and paste inside the editor keeps them.
 */

function validator(kind: AttrKind): string | ((value: unknown) => void) {
  switch (kind) {
    case 'id':
    case 'string?':
      return 'string|null';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'number?':
      return 'number|null';
    case 'boolean':
      return 'boolean';
    case 'array':
      return (value) => {
        if (!Array.isArray(value)) throw new RangeError('expected an array');
      };
    case 'array?':
      return (value) => {
        if (value !== null && !Array.isArray(value))
          throw new RangeError('expected an array or null');
      };
    case 'object?':
      return (value) => {
        if (value !== null && !isRecord(value))
          throw new RangeError('expected an object or null');
      };
    default:
      return kind satisfies never;
  }
}

function fits(kind: AttrKind, value: unknown): boolean {
  switch (kind) {
    case 'id':
    case 'string':
    case 'string?':
      return typeof value === 'string';
    case 'number':
    case 'number?':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
    case 'array?':
      return Array.isArray(value);
    case 'object?':
      return isRecord(value);
    default:
      return kind satisfies never;
  }
}

/** `moduleId` → `data-module-id`. */
function dataAttribute(name: string): string {
  return `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Every attribute travels through HTML as JSON in its own `data-*` attribute. */
function attributes(defs: Record<string, AttrDef>): Record<string, Attribute> {
  const out: Record<string, Attribute> = {};
  for (const [name, def] of Object.entries(defs)) {
    const html = dataAttribute(name);
    out[name] = {
      default: def.default,
      validate: validator(def.kind),
      // A split block is a new block: it gets an ID of its own later.
      keepOnSplit: def.kind !== 'id',
      parseHTML: (element) => {
        const raw = element.getAttribute(html);
        if (raw === null) return null;
        try {
          const value: unknown = JSON.parse(raw);
          // Pasted HTML can say anything: a value of the wrong type is no value.
          return fits(def.kind, value) ? value : null;
        } catch {
          return null;
        }
      },
      renderHTML: (attrs) =>
        attrs[name] === null || attrs[name] === undefined
          ? {}
          : { [html]: JSON.stringify(attrs[name]) },
    };
  }
  return out;
}

/** A `data-*` attribute's JSON value; undefined when it is missing or no JSON. */
function jsonAttribute(
  element: { getAttribute(name: string): string | null },
  name: string,
): unknown {
  const raw = element.getAttribute(name);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

type Config = Omit<NodeConfig, 'name' | 'addAttributes'>;

function node(name: NodeName, config: Config) {
  return Node.create({
    name,
    ...config,
    addAttributes: () => attributes(NODE_ATTRS[name]),
  });
}

/** A container rendered as `<tag data-node="name">`, parsed back from the same. */
function container(name: NodeName, tag: string, config: Config) {
  const selector = `${tag}[data-node="${name}"]`;
  return node(name, {
    parseHTML: () => [{ tag: selector }],
    renderHTML: ({ HTMLAttributes }) => [
      tag,
      { ...HTMLAttributes, 'data-node': name },
      0,
    ],
    ...config,
  });
}

/** Inline content keeps its whitespace when parsed: it is the author's text. */
function textblock(name: NodeName, tag: string, content: string) {
  return node(name, {
    content,
    parseHTML: () => [
      { tag: `${tag}[data-node="${name}"]`, preserveWhitespace: true },
    ],
    renderHTML: ({ HTMLAttributes }) => [
      tag,
      { ...HTMLAttributes, 'data-node': name },
      0,
    ],
  });
}

const BLOCK_CONTAINER = { isolating: true, defining: true } as const;

const nodes = [
  // A page break only where a page can break: in the document and a section, between blocks.
  node('doc', { topNode: true, content: '(block | pageBreak)* section*' }),
  // Paragraph first: it is the block ProseMirror fills an empty container with.
  node('paragraph', {
    group: 'block',
    content: 'inline*',
    parseHTML: () => [{ tag: 'p', preserveWhitespace: true }],
    renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
  }),
  container('section', 'section', {
    content: 'title (block | pageBreak)* section*',
    defining: true,
  }),
  textblock('title', 'div', 'titleInline*'),
  container('list', 'div', { group: 'block', content: 'listItem+' }),
  container('listItem', 'div', { content: 'itemText block*', defining: true }),
  textblock('itemText', 'div', 'inline*'),
  container('procedure', 'div', {
    group: 'block',
    content: 'title? listItem+',
  }),
  container('table', 'div', {
    group: 'block',
    content: 'title? tableRow+',
    isolating: true,
  }),
  container('tableRow', 'div', { content: 'tableCell+' }),
  container('tableCell', 'div', { content: 'block+', ...BLOCK_CONTAINER }),
  // The callouts after the title, in the stored (the author's) order; each holds its legend.
  container('image', 'figure', { group: 'block', content: 'title? callout*' }),
  textblock('callout', 'div', 'titleInline*'),
  container('safety', 'aside', {
    group: 'block',
    content: 'hazard block*',
    ...BLOCK_CONTAINER,
  }),
  textblock('hazard', 'div', 'titleInline*'),
  container('admonition', 'aside', {
    group: 'block',
    content: 'block+',
    ...BLOCK_CONTAINER,
  }),
  // The answer below its question; `block+` as in the model.
  container('faq', 'div', {
    group: 'block',
    content: 'question block+',
    ...BLOCK_CONTAINER,
  }),
  textblock('question', 'div', 'titleInline*'),
  container('variant', 'div', {
    group: 'block',
    content: 'block+',
    ...BLOCK_CONTAINER,
  }),
  node('moduleRef', {
    group: 'block',
    atom: true,
    selectable: true,
    parseHTML: () => [{ tag: 'div[data-node="moduleRef"]' }],
    renderHTML: ({ node: n, HTMLAttributes }) => [
      'div',
      { ...HTMLAttributes, 'data-node': 'moduleRef' },
      n.attrs['block'] === null
        ? String(n.attrs['module'])
        : `${String(n.attrs['module'])}#${String(n.attrs['block'])}`,
    ],
  }),
  node('attachment', {
    group: 'block',
    atom: true,
    selectable: true,
    parseHTML: () => [{ tag: 'div[data-node="attachment"]' }],
    renderHTML: ({ node: n, HTMLAttributes }) => [
      'div',
      { ...HTMLAttributes, 'data-node': 'attachment' },
      String(n.attrs['name']),
    ],
  }),
  node('pageBreak', {
    atom: true,
    selectable: true,
    parseHTML: () => [{ tag: 'hr[data-node="pageBreak"]' }],
    renderHTML: ({ HTMLAttributes }) => [
      'hr',
      { ...HTMLAttributes, 'data-node': 'pageBreak' },
    ],
  }),
  node('literal', {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    parseHTML: () => [
      {
        tag: 'pre[data-node="literal"]',
        contentElement: 'code',
        preserveWhitespace: 'full',
      },
    ],
    // Inside `code`: HTML drops a line break right after `<pre>`.
    renderHTML: ({ HTMLAttributes }) => [
      'pre',
      { ...HTMLAttributes, 'data-node': 'literal' },
      ['code', 0],
    ],
  }),
  node('passthrough', {
    group: 'block',
    atom: true,
    selectable: true,
    parseHTML: () => [{ tag: 'pre[data-node="passthrough"]' }],
    renderHTML: ({ node: n, HTMLAttributes }) => [
      'pre',
      { ...HTMLAttributes, 'data-node': 'passthrough' },
      String(n.attrs['raw']),
    ],
  }),
  node('text', { group: 'inline titleInline' }),
  inlineAtom('attribute', 'span', (attrs) => `{${String(attrs['name'])}}`),
  inlineAtom('xref', 'span', (attrs) =>
    Array.isArray(attrs['text'])
      ? attrs['text']
          .map((run: unknown) =>
            isRecord(run) && typeof run['text'] === 'string' ? run['text'] : '',
          )
          .join('')
      : String(attrs['module']),
  ),
  inlineAtom('kbd', 'kbd', (attrs) =>
    Array.isArray(attrs['keys']) ? attrs['keys'].join('+') : '',
  ),
  inlineAtom('placeholder', 'span', (attrs) =>
    placeholderText(String(attrs['key'])),
  ),
  // Its number depends on the variant: the editor's node view shows it.
  inlineAtom('calloutRef', 'span', (attrs) => `(${String(attrs['callout'])})`),
  node('hardBreak', {
    group: 'inline',
    inline: true,
    selectable: false,
    parseHTML: () => [{ tag: 'br' }],
    renderHTML: () => ['br'],
  }),
];

/** An inline atom shows a label; its attributes are its content. */
function inlineAtom(
  name: NodeName,
  tag: string,
  label: (attrs: Record<string, unknown>) => string,
) {
  return node(name, {
    group: 'inline titleInline',
    inline: true,
    atom: true,
    selectable: true,
    parseHTML: () => [{ tag: `${tag}[data-node="${name}"]` }],
    renderHTML: ({ node: n, HTMLAttributes }) => [
      tag,
      { ...HTMLAttributes, 'data-node': name },
      label(n.attrs),
    ],
  });
}

const MARK_TAGS: Record<(typeof MARK_NAMES)[number], string> = {
  link: 'a',
  term: 'span',
  ui: 'span',
  strong: 'strong',
  emphasis: 'em',
  code: 'code',
  sub: 'sub',
  sup: 'sup',
};

/** Formatting pasted from elsewhere. */
const PLAIN_MARK_RULES: Record<
  (typeof MARK_NAMES)[number],
  {
    tag: string;
    getAttrs?: (element: {
      getAttribute(name: string): string | null;
    }) => Record<string, unknown> | false;
  }[]
> = {
  link: [
    {
      tag: 'a[href]',
      // A pasted link to any other address than the model's (http, https, mailto) stays text.
      getAttrs: (element) => {
        const href = element.getAttribute('href');
        return isLinkHref(href) ? { href } : false;
      },
    },
  ],
  // A term link is our own markup only: nothing pasted from elsewhere is one.
  term: [],
  ui: [],
  strong: [{ tag: 'strong' }, { tag: 'b' }],
  emphasis: [{ tag: 'em' }, { tag: 'i' }],
  code: [{ tag: 'code' }],
  sub: [{ tag: 'sub' }],
  sup: [{ tag: 'sup' }],
};

// Created in the model's mark order, so ProseMirror ranks (and sorts) marks the same way.
const marks = MARK_NAMES.map((name) =>
  Mark.create({
    name,
    ...(name === 'link' || name === 'term' ? { inclusive: false } : {}),
    // A link and a term link never mark the same text (the model refuses it).
    ...(name === 'link' ? { excludes: 'link term' } : {}),
    ...(name === 'term' ? { excludes: 'term link' } : {}),
    addAttributes: () => attributes(MARK_ATTRS[name]),
    parseHTML: () => [
      name === 'link'
        ? // Our own markup can be written by any page: a link to an address the model refuses is no link.
          {
            tag: `a[data-mark="link"]`,
            getAttrs: (element: {
              getAttribute(name: string): string | null;
            }) =>
              isLinkHref(jsonAttribute(element, 'data-href')) ? null : false,
          }
        : name === 'term'
          ? {
              tag: `span[data-mark="term"]`,
              getAttrs: (element: {
                getAttribute(name: string): string | null;
              }) =>
                isTermId(jsonAttribute(element, 'data-term-id')) ? null : false,
            }
          : { tag: `${MARK_TAGS[name]}[data-mark="${name}"]` },
      ...PLAIN_MARK_RULES[name],
    ],
    renderHTML: ({ mark, HTMLAttributes }) => {
      const href = mark.attrs['href'];
      return [
        MARK_TAGS[name],
        {
          ...HTMLAttributes,
          'data-mark': name,
          // Only an address the model takes becomes a real `href`; anything else stays inert.
          ...(isLinkHref(href)
            ? { href, rel: 'noopener noreferrer nofollow' }
            : {}),
        },
        0,
      ];
    },
  }),
);

/**
 * The extensions that make up the editor's schema: exactly the model's node
 * and mark types. The editor adds behaviour on top, never another node type.
 */
export function createEditorExtensions(): Extensions {
  return [...nodes, ...marks];
}

let schema: Schema | undefined;

/** The ProseMirror schema of `createEditorExtensions()`. */
export function getEditorSchema(): Schema {
  schema ??= getSchema(createEditorExtensions());
  return schema;
}
