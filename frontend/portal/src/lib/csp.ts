/**
 * The Content Security Policy of every page: every script and stylesheet is a file of this
 * site; inline style attributes only, which the renderer writes for image and column widths.
 * 'wasm-unsafe-eval' is Pagefind's search index, `data:` images its search field's icon (an
 * image never runs script). The pages carry it as a meta tag, so it holds on any host.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * The policy a host sends as a header (README, "Hosting"): the pages' own plus what a meta tag
 * cannot say, `frame-ancestors` (no other site may frame the portal).
 */
export const HOST_CSP = `${PAGE_CSP}; frame-ancestors 'none'`;
