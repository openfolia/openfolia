/** Very large pages (#785), each of about `bytes` characters of markup. */
export const LARGE_PAGES = {
  /** Short paragraphs, one after the other. */
  paragraphs: (bytes: number) => fill('a\n\n', bytes),
  /** One line of forced line breaks (`\\\\`) under three marks at once. */
  'stacked-marks': (bytes: number) => `*_??${fill('a\\\\', bytes)}end??_*`,
  /** Tables of one cell each. */
  tables: (bytes: number) => fill('|a|\n\n', bytes),
  /** One list of very many items. */
  list: (bytes: number) => fill('* a\n', bytes),
  /** One paragraph of images, each a block of its own after it. */
  images: (bytes: number) => fill('!x.png! ', bytes),
} as const;

export type LargePage = keyof typeof LARGE_PAGES;

function fill(unit: string, bytes: number): string {
  return unit.repeat(Math.max(1, Math.floor(bytes / unit.length)));
}
