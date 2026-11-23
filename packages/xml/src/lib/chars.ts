/**
 * Whether a code point may appear in an XML 1.0 document at all (even as
 * a character reference): tab, line feed, carriage return, and everything
 * from U+0020 except the surrogates, U+FFFE and U+FFFF.
 */
export function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}
