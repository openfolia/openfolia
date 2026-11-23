/**
 * The only ways text reaches the output. Every string from the content
 * (and from the caller's callbacks) goes through one of these; markup is
 * only ever written by the renderer itself.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text content or an attribute value, escaped. Also used for attributes, so
 * quotes are escaped too. NUL (which an HTML parser drops or replaces) and
 * carriage returns (which it folds into line feeds) are written as
 * references, so the text reads back exactly as given.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'\0\r]/g, (ch) =>
    ch === '\0' ? '�' : ch === '\r' ? '&#13;' : (ENTITIES[ch] as string),
  );
}

/** Schemes a link may use; anything else (javascript:, data:, vbscript:, file:, …) is refused. */
const SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The URL if it may be put in an `href` or `src`, else undefined: an
 * absolute `http:`, `https:` or `mailto:` URL, or a relative one (a path,
 * `?query` or `#fragment`). Refused: any other scheme, and any URL with
 * whitespace, control characters or a backslash, which browsers strip or
 * rewrite before reading the scheme (`java\tscript:`, ` javascript:`).
 */
export function safeUrl(url: string): string | undefined {
  if (url.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) return undefined;
  // A scheme is whatever precedes the first ":" that comes before any "/", "?" or "#".
  const scheme = /^([^/?#]*?):/.exec(url)?.[1];
  if (scheme === undefined) return url;
  return SCHEMES.has(scheme.toLowerCase()) ? url : undefined;
}
