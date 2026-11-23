/**
 * The preview page the API renders (`GET …/preview`, `GET …/html`) is untrusted content: it is
 * shown in a sandboxed frame (no scripts, `sandbox="allow-same-origin"` only) as a document this
 * module writes anew from it. Nothing of the page is taken as it is:
 *
 * - **Head:** rebuilt here: a Content Security Policy as strict as the API's own (no script, no
 *   object, styles and fonts from the API's origin, images only as `blob:` URLs, no `<base>`, no
 *   form), no referrer, and only the stylesheets the API serves under `<api>/preview/*.css`.
 * - **Body:** the page's body, with every element that could load, run or submit something
 *   removed (scripts, frames, objects, forms, `<base>`, `<meta>`, `<link>`, `<style>`, …), every
 *   event handler and every URL attribute dropped except a link's `href` (`http:`, `https:`,
 *   `mailto:` or `#fragment`) and an image's `src`, which becomes the `blob:` URL the caller read
 *   with the person's credentials (`imageUrls`), or nothing.
 *
 * - **Image callouts** (#546): the one SVG kept, an image's callout overlay
 *   (`svg.of-callouts__overlay` in its `of-callouts__picture`), is never taken as it is
 *   either: it is drawn anew here, element by element (`line`, `circle`, `g` and `text` only),
 *   with only the attributes the renderer writes, each value matching its pattern (percentages,
 *   a radius, a style key, a callout's key) and a marker's text a number or `?`. Every other SVG is dropped.
 *
 * The API's renderer escapes by construction already (`@openfolia/render-html`, "Security"); this is
 * the second wall, so a fault there still cannot run anything in the editor's origin.
 */

/** Elements dropped with everything in them. */
const DROPPED = new Set([
  'script',
  'noscript',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'template',
  'slot',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'dialog',
  'foreignobject',
  'use',
  'image',
  'animate',
  'set',
  // Raw-text and foreign-content elements: they parse differently once serialised and parsed
  // again as `srcdoc`, so text checked here could come back as markup (mutation XSS).
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'svg',
  'math',
]);

const XHTML = 'http://www.w3.org/1999/xhtml';

/** Attributes that hold a URL or load something; dropped except as said above. */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'srcset',
  'srcdoc',
  'action',
  'formaction',
  'poster',
  'background',
  'cite',
  'data',
  'codebase',
  'longdesc',
  'ping',
  'xlink:href',
  'manifest',
  'lowsrc',
  'dynsrc',
  'imagesrcset',
]);

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/;
const ASSET_PATH = /^\/assets\/[0-9a-f]{64}$/;
/** An image uploaded into a change set, on a page of its working copies: its author's to read. */
const UPLOAD_PATH =
  /^\/change-sets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/assets\/[0-9a-f]{64}$/;
/** A safety symbol's artwork (#208), at the page's `?ref=`. */
const SYMBOL_PATH = /^\/symbols\/[a-z][a-z0-9-]{0,63}$/;
const STYLESHEET_PATH = /^\/preview\/[a-z0-9-]+\.css$/;

/** Where the API is: its root as an absolute URL (`https://editor.example/api`). */
export interface PreviewOrigin {
  /** The URL the page was read from, to resolve its relative links. */
  readonly pageUrl: string;
  /** The API's root, absolute, without a trailing slash. */
  readonly apiRoot: string;
}

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

/** `url` as a path under the API's root (`/assets/…`), or undefined when it is not one. */
function apiPath(
  raw: string,
  { pageUrl, apiRoot }: PreviewOrigin,
): { path: string; search: string } | undefined {
  let url: URL;
  let root: URL;
  try {
    url = new URL(raw, pageUrl);
    root = new URL(apiRoot);
  } catch {
    return undefined;
  }
  const base = root.pathname.replace(/\/+$/, '');
  if (url.origin !== root.origin || !url.pathname.startsWith(`${base}/`)) {
    return undefined;
  }
  return { path: url.pathname.slice(base.length), search: url.search };
}

/** Whether a URL `previewImageUrls` gave is a safety symbol's artwork (an SVG is rasterised). */
export function isSymbolUrl(url: string, apiRoot: string): boolean {
  return (
    url.startsWith(`${apiRoot}/`) &&
    SYMBOL_PATH.test(url.slice(apiRoot.length).split('?')[0] ?? '')
  );
}

/**
 * The images the page shows, as the API URLs to read them from (`<api>/assets/<sha256>?ref=…`, or
 * on a page of a change set's working copies `<api>/change-sets/<id>/assets/<sha256>`, and the
 * safety symbols' artwork `<api>/symbols/<id>?ref=…`), each once. Only the API's own asset and
 * symbol routes: anything else is not read, and shows no image.
 */
export function previewImageUrls(
  html: string,
  origin: PreviewOrigin,
): string[] {
  const urls = new Set<string>();
  for (const img of parse(html).querySelectorAll('img[src]')) {
    const url = assetUrl(img.getAttribute('src') ?? '', origin);
    if (url) urls.add(url);
  }
  return [...urls];
}

/** The asset or symbol URL an image `src` names, normalised, if it is one of the API's own. */
function assetUrl(src: string, origin: PreviewOrigin): string | undefined {
  const found = apiPath(src, origin);
  if (!found) return undefined;
  // That route takes no query: none is kept.
  if (UPLOAD_PATH.test(found.path)) return `${origin.apiRoot}${found.path}`;
  if (!ASSET_PATH.test(found.path) && !SYMBOL_PATH.test(found.path)) {
    return undefined;
  }
  const ref = new URLSearchParams(found.search).get('ref');
  return `${origin.apiRoot}${found.path}${ref === null ? '' : `?ref=${encodeURIComponent(ref)}`}`;
}

/** A link target the frame may keep: `http:`, `https:`, `mailto:` or a fragment of this page. */
function safeHref(href: string): boolean {
  const value = href.trim();
  if (/[\s\\]/.test(value) || [...value].some((c) => c.charCodeAt(0) < 32)) {
    return false;
  }
  if (value.startsWith('#')) return true;
  return /^(https?:\/\/|mailto:)/i.test(value);
}

function cleanElement(
  element: Element,
  imageFor: (src: string) => string | undefined,
): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    // `name` would let an element shadow the frame document's own members
    // (`<img name="addEventListener">`), which the frame component calls.
    if (name.startsWith('on') || name === 'is' || name === 'name') {
      element.removeAttribute(attribute.name);
    } else if (name === 'href' && element.localName === 'a') {
      if (!safeHref(attribute.value)) element.removeAttribute(attribute.name);
    } else if (name === 'src' && element.localName === 'img') {
      const url = imageFor(attribute.value);
      if (url) element.setAttribute('src', url);
      else element.removeAttribute('src');
    } else if (URL_ATTRIBUTES.has(name) || name.includes(':')) {
      element.removeAttribute(attribute.name);
    }
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?%$/;
/** The attributes a callout overlay's parts may carry, each with the values it may hold. */
const OVERLAY_ATTRIBUTES: Readonly<Record<string, RegExp>> = {
  class: /^of-callouts__(?:leader|anchor|marker)$/,
  x1: PERCENT,
  y1: PERCENT,
  x2: PERCENT,
  y2: PERCENT,
  cx: PERCENT,
  cy: PERCENT,
  x: PERCENT,
  y: PERCENT,
  r: /^\d{1,2}(?:\.\d)?$/,
  'text-anchor': /^middle$/,
  'dominant-baseline': /^central$/,
  'data-callout-style': /^[a-z][a-z0-9-]{0,63}$/,
  // A callout's key (#549): the image's output ID and the callout's, for the hover highlight.
  'data-callout': /^[a-z0-9_-]{1,200}:[a-z_][a-z0-9_-]{0,63}$/,
};
/** Which parts each part may hold: the overlay lines, dots and markers; a marker its circle and number. */
const OVERLAY_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['line', 'circle', 'g']),
  g: new Set(['circle', 'text']),
};

/** Whether `element` is a callout overlay where the renderer writes one. */
function isCalloutOverlay(element: Element): boolean {
  return (
    element.namespaceURI === SVG &&
    element.localName === 'svg' &&
    element.getAttribute('class') === 'of-callouts__overlay' &&
    element.parentElement?.namespaceURI === XHTML &&
    element.parentElement.getAttribute('class') === 'of-callouts__picture'
  );
}

/** A callout overlay drawn anew from `source`: only its known parts, attributes and numbers. */
function calloutOverlay(source: Element, doc: Document): Element {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'of-callouts__overlay');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const copy = (from: Element, to: Element, depth: number): void => {
    const allowed = OVERLAY_CHILDREN[to.localName];
    if (!allowed || depth > 1) return;
    for (const child of from.children) {
      if (child.namespaceURI !== SVG || !allowed.has(child.localName)) continue;
      const part = doc.createElementNS(SVG, child.localName);
      for (const attribute of child.attributes) {
        if (
          Object.hasOwn(OVERLAY_ATTRIBUTES, attribute.name) &&
          OVERLAY_ATTRIBUTES[attribute.name]?.test(attribute.value)
        ) {
          part.setAttribute(attribute.name, attribute.value);
        }
      }
      if (child.localName === 'text') {
        const number = child.textContent ?? '';
        if (/^(?:\d{1,3}|\?)$/.test(number)) part.textContent = number;
      } else {
        copy(child, part, depth + 1);
      }
      to.append(part);
    }
  };
  copy(source, svg, 0);
  return svg;
}

function clean(
  root: Element,
  imageFor: (src: string) => string | undefined,
): void {
  // A static list in document order: an element inside one already removed is skipped (the tree
  // it is in is detached from `root`, which itself is in no document yet).
  for (const element of [...root.querySelectorAll('*')]) {
    if (!root.contains(element)) continue;
    if (isCalloutOverlay(element)) {
      element.replaceWith(calloutOverlay(element, root.ownerDocument));
      continue;
    }
    if (
      element.namespaceURI !== XHTML ||
      DROPPED.has(element.localName.toLowerCase())
    ) {
      element.remove();
      continue;
    }
    cleanElement(element, imageFor);
  }
}

/** The policy the frame's document carries: no script, nothing but the API's styles and fonts. */
export function previewPolicy(apiOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    `style-src ${apiOrigin}`,
    "style-src-attr 'unsafe-inline'",
    'img-src blob:',
    `font-src ${apiOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The document the frame shows, written from the API's page (see above). `images` maps each URL
 * `previewImageUrls` gave to the `blob:` URL of the bytes read; an image without one shows none.
 */
export function previewDocument(
  html: string,
  origin: PreviewOrigin,
  options: {
    readonly dark: boolean;
    readonly images: ReadonlyMap<string, string>;
  },
): string {
  const source = parse(html);
  const apiOrigin = new URL(origin.apiRoot).origin;
  const out = document.implementation.createHTMLDocument('');
  const lang = source.documentElement.getAttribute('lang') ?? '';
  if (LANGUAGE_TAG.test(lang)) out.documentElement.setAttribute('lang', lang);
  // The page's direction (#458): only the two values, as the API writes them.
  const dir = source.documentElement.getAttribute('dir');
  if (dir === 'ltr' || dir === 'rtl')
    out.documentElement.setAttribute('dir', dir);
  if (options.dark) out.documentElement.classList.add('dark');

  const head = out.head;
  head.replaceChildren();
  const meta = (attributes: Record<string, string>) => {
    const element = out.createElement('meta');
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    head.append(element);
  };
  meta({ charset: 'utf-8' });
  meta({
    'http-equiv': 'Content-Security-Policy',
    content: previewPolicy(apiOrigin),
  });
  meta({ name: 'referrer', content: 'no-referrer' });
  meta({ name: 'color-scheme', content: options.dark ? 'dark' : 'light' });
  for (const link of source.querySelectorAll('link[rel="stylesheet"]')) {
    // A stylesheet for a media query (the API's `auto` theme) is the host's choice here.
    if (link.hasAttribute('media')) continue;
    const found = apiPath(link.getAttribute('href') ?? '', origin);
    if (!found || found.search !== '' || !STYLESHEET_PATH.test(found.path)) {
      continue;
    }
    const element = out.createElement('link');
    element.setAttribute('rel', 'stylesheet');
    element.setAttribute('href', `${origin.apiRoot}${found.path}`);
    head.append(element);
  }

  const body = out.importNode(source.body, true);
  clean(body, (src) => {
    const url = assetUrl(src, origin);
    return url === undefined ? undefined : options.images.get(url);
  });
  for (const attribute of [...body.attributes]) {
    body.removeAttribute(attribute.name);
  }
  out.documentElement.replaceChild(body, out.body);
  const written = out.body.innerHTML;
  // The frame parses what is written here again: it must read back as the same tree, or a
  // parser difference has turned text into markup. Then the body is shown as plain text.
  const reread = parse(`<!doctype html><body>${written}`).body.innerHTML;
  // A carriage return (`&#13;` in the page) is read back as a line feed: not a difference.
  if (reread !== written.replace(/\r\n?/g, '\n'))
    out.body.replaceChildren(out.createTextNode(body.textContent ?? ''));
  return `<!doctype html>\n${out.documentElement.outerHTML}`;
}
