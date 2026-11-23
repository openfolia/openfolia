import {
  readXml,
  XML_NAMESPACE,
  type XmlElement,
  type XmlLimits,
} from './xml-read.js';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** What an SVG to make inert may hold before it is refused: a drawing, not a document. */
export const SVG_LIMITS: XmlLimits = {
  maxLength: 8 * 1024 * 1024,
  maxDepth: 48,
  maxNodes: 200_000,
  maxAttributes: 64,
};

/**
 * The elements a drawing is made of. Everything else goes with all it holds:
 * `script`, `foreignObject`, `iframe`, `image`, `feImage`, the
 * animation elements (`set`, `animate`, … which can rewrite an attribute into
 * a link), and any element of another namespace.
 */
const ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'metadata',
  'switch',
  'style',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
]);

/** The elements a link inside is text, not shapes. */
const TEXT: ReadonlySet<string> = new Set(['text', 'tspan', 'textPath']);

/** An attribute's name as SVG writes them: letters, digits, `-`; never an event handler. */
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Whether an attribute's value refers to nothing outside the drawing: no
 * `url(…)` but to an element of its own (`url(#id)`), no scheme such as
 * `javascript:` or `data:`, no CSS escape or at-rule that could hide one.
 */
function inert(value: string): boolean {
  const rest = plainCss(value);
  if (rest === undefined) return false;
  // What is left may hold no `url(` (each read and taken out), no `//`, no CSS escape or at-rule,
  // no scheme, and none of the CSS functions that load an image from a
  // string (`image-set`, `cross-fade`, `image`, `src`, `element`, `paint`).
  if (/[\\@]|\/\/|url\s*\(/i.test(rest)) return false;
  if (/(image-set|cross-fade|image|src|element|paint)\s*\(/i.test(rest)) {
    return false;
  }
  return !/(^|[^a-z0-9-])(javascript|vbscript|data|file|https?|ftp|smb)\s*:/i.test(
    rest,
  );
}

/**
 * `value` read left to right as CSS reads it, strings, comments and `url(…)`
 * in one pass (so a `/*` in a string, a quote in a comment or a comment in a
 * `url(` means what it means to a browser): a `url(…)` only to `#id` and each
 * comment become a space, each string an `x` when its text is a plain name
 * (`font-family: 'Arial MT'`, `[A-Za-z0-9 ,_.-]`). Undefined for a string,
 * comment or `url(` left open, a string of anything else, a `url(` to
 * anything but `#id`, or any backslash (a CSS escape can spell anything).
 */
function plainCss(value: string): string | undefined {
  let out = '';
  for (let at = 0; at < value.length;) {
    const c = value[at] as string;
    if (c === '\\') return undefined;
    // A `url(` is one token to CSS, comments and all: whole, `#id` only.
    if (/^url\s*\(/i.test(value.slice(at, at + 64))) {
      const end = value.indexOf(')', at);
      if (end < 0) return undefined;
      const inside = value.slice(value.indexOf('(', at) + 1, end);
      // CSS's whitespace only (`\s` holds more, such as U+00A0).
      if (
        !/^[ \t\n\r\f]*(['"]?)#[A-Za-z_][\w.:-]*\1[ \t\n\r\f]*$/.test(inside)
      ) {
        return undefined;
      }
      out += ' ';
      at = end + 1;
      continue;
    }
    if (c === '/' && value[at + 1] === '*') {
      const end = value.indexOf('*/', at + 2);
      if (end < 0) return undefined;
      out += ' ';
      at = end + 2;
    } else if (c === '"' || c === "'") {
      const end = value.indexOf(c, at + 1);
      if (end < 0) return undefined;
      const text = value.slice(at + 1, end);
      if (!/^[A-Za-z0-9 ,_.-]*$/.test(text)) return undefined;
      out += 'x';
      at = end + 1;
    } else {
      out += c;
      at += 1;
    }
  }
  return out;
}

/** A link inside the drawing only: `#id`, nothing else. */
const LOCAL_LINK = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

const escText = (text: string) =>
  text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
const escAttr = (text: string) =>
  text.replace(/[&<>"\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`);

function attributesOf(element: XmlElement): string {
  let out = '';
  const written = new Set<string>();
  for (const [key, value] of element.attributes) {
    let name: string;
    if (key.startsWith('{')) {
      const end = key.indexOf('}');
      const ns = key.slice(1, end);
      const local = key.slice(end + 1);
      if (ns === XLINK_NAMESPACE && local === 'href') {
        if (!LOCAL_LINK.test(value)) continue;
        name = 'href';
      } else if (
        ns === XML_NAMESPACE &&
        (local === 'space' || local === 'lang')
      ) {
        name = `xml:${local}`;
      } else {
        continue;
      }
    } else {
      if (!NAME.test(key) || /^on/i.test(key)) continue;
      if (key === 'href' && !LOCAL_LINK.test(value)) continue;
      name = key;
    }
    // `xlink:href` and `href` both become `href`: the first one only.
    if (written.has(name) || !inert(value)) continue;
    written.add(name);
    out += ` ${name}="${escAttr(value)}"`;
  }
  return out;
}

/**
 * `text`, an SVG from content, made inert: only drawing elements (`ELEMENTS`)
 * and their attributes, every event handler, script, foreign object, embedded
 * image, animation and link out of the drawing left out (a link's shapes kept
 * as a group; a style sheet kept only when it refers to nothing outside), written again as
 * plain SVG (no DTD, no entity, no processing instruction, no comment). So the
 * file shows the same drawing and runs nothing, even opened on its own, as a
 * document. Throws `XmlReadError` for one that is no well-formed XML within
 * `SVG_LIMITS`, and a `TypeError` for one whose root is no SVG.
 */
export function sanitizeSvg(text: string): string {
  // A DOCTYPE naming the SVG DTD (as editors export SVG 1.1) is skipped, never
  // opened; one with an internal subset (entities) is still refused.
  const root = readXml(text, SVG_LIMITS, { doctype: 'external-id' });
  if (root.ns !== SVG_NAMESPACE || root.local !== 'svg') {
    throw new TypeError('The file is no SVG.');
  }
  const write = (element: XmlElement, top: boolean, inText = false): string => {
    if (element.ns !== SVG_NAMESPACE) return '';
    // A link's drawing is kept, without the link.
    if (element.local === 'a') {
      const inner = element.children
        .map((c) =>
          typeof c === 'string' ? escText(c) : write(c, false, inText),
        )
        .join('');
      // In text, a group is not allowed: the linked text as it is.
      return inText ? inner : `<g>${inner}</g>`;
    }
    if (!ELEMENTS.has(element.local)) return '';
    // A style sheet only when it, as a whole, refers to nothing outside the drawing.
    if (element.local === 'style') {
      const sheet = element.children
        .filter((c) => typeof c === 'string')
        .join('');
      return inert(sheet) ? `<style>${escText(sheet)}</style>` : '';
    }
    const children = element.children
      .map((child) =>
        typeof child === 'string'
          ? escText(child)
          : write(child, false, inText || TEXT.has(element.local)),
      )
      .join('');
    const ns = top ? ` xmlns="${SVG_NAMESPACE}"` : '';
    return `<${element.local}${ns}${attributesOf(element)}>${children}</${element.local}>`;
  };
  return write(root, true);
}
