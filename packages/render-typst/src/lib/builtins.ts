/**
 * Files the compiler provides itself, next to the document and template.
 * `CompileInput.files` cannot replace them.
 */

/**
 * Stands in for a safety symbol whose artwork is missing: a neutral grey
 * warning sign (#737373, today's muted foreground of the theme; an SVG file
 * cannot read the tokens), never a colour. `renderTypst`
 * names it in `safety(symbols: …)`, so every template gets a path it can
 * show like any other symbol.
 */
export const MISSING_SYMBOL_PATH = 'openfolia/missing-symbol.svg';

/**
 * The default brand's mark (`@openfolia/theme`'s `brand/openfolia-mark-color-light.svg`, read with
 * the theme): the default template shows it on the title page when the document sets no logo
 * (branding's own logo, in the state `"openfolia-document"`, replaces it).
 */
export const DEFAULT_LOGO_PATH = 'openfolia/logo.svg';

const MISSING_SYMBOL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M50 12 L92 86 H8 Z" fill="none" stroke="#737373" stroke-width="5" stroke-linejoin="round"/>' +
  '<rect x="47" y="38" width="6" height="28" rx="2" fill="#737373"/>' +
  '<circle cx="50" cy="75" r="3.5" fill="#737373"/></svg>\n';

/** The compiler's own files by path: these and `main.typ`, `template.typ`, `tokens.typ`. */
export const BUILTIN_FILES: Readonly<Record<string, Uint8Array>> = {
  [MISSING_SYMBOL_PATH]: new TextEncoder().encode(MISSING_SYMBOL_SVG),
};

/** Paths `files` may not use: the compiler's sources and anything under `openfolia/`. */
export function isReservedPath(normalized: string): boolean {
  return (
    ['main.typ', 'template.typ', 'tokens.typ'].includes(normalized) ||
    normalized === 'openfolia' ||
    normalized.startsWith('openfolia/')
  );
}
