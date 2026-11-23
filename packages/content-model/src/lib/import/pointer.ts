import type { Block, Item } from '../blocks.js';
import { textIn } from '../localized-text.js';
import type { ManifestEntry } from '../manifest.js';

/** A JSON Pointer (RFC 6901) from its path segments. */
export function jsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map(
      (segment) =>
        '/' + String(segment).replace(/~/g, '~0').replace(/\//g, '~1'),
    )
    .join('');
}

/**
 * The JSON Pointer of every block, list item and procedure step by its ID,
 * relative to the module (`/blocks/0/items/1`). IDs are unique in a module
 * that parsed, so each has one pointer.
 */
export function blockPointers(blocks: readonly Block[]): Map<string, string> {
  const pointers = new Map<string, string>();
  const visit = (list: readonly Block[], at: string) =>
    list.forEach((block, i) => {
      const here = `${at}/${i}`;
      pointers.set(block.id, here);
      switch (block.type) {
        case 'section':
        case 'safety':
        case 'admonition':
        case 'faq':
        case 'variant':
          visit(block.blocks, `${here}/blocks`);
          break;
        case 'list':
          visitItems(block.items, `${here}/items`);
          break;
        case 'procedure':
          visitItems(block.steps, `${here}/steps`);
          break;
        case 'table':
          block.rows.forEach((row, r) =>
            row.cells.forEach((cell, c) =>
              visit(cell.blocks, `${here}/rows/${r}/cells/${c}/blocks`),
            ),
          );
          break;
        default:
          break;
      }
    });
  const visitItems = (items: readonly Item[], at: string) =>
    items.forEach((item, i) => {
      pointers.set(item.id, `${at}/${i}`);
      visit(item.blocks, `${at}/${i}/blocks`);
    });
  visit(blocks, '/blocks');
  return pointers;
}

/**
 * The pointer of the first manifest entry naming each key, a module ID or a
 * group title (what `validateManifest` puts in an issue's `at`), relative
 * to the manifest.
 */
export function entryPointers(
  entries: readonly ManifestEntry[],
  source: string,
): Map<string, string> {
  const pointers = new Map<string, string>();
  const visit = (list: readonly ManifestEntry[], at: string) =>
    list.forEach((entry, i) => {
      const here = `${at}/${i}`;
      const key =
        'module' in entry ? entry.module : textIn(entry.title, source, source);
      if (!pointers.has(key)) pointers.set(key, here);
      if ('entries' in entry) visit(entry.entries, `${here}/entries`);
    });
  visit(entries, '/entries');
  return pointers;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Pointers to the members of `raw` that parsing dropped from `parsed`
 * (unknown fields a non-strict schema strips): a typo in an optional field
 * would otherwise vanish without a word. Arrays are compared item by item
 * only when parsing kept their length.
 */
export function droppedMembers(
  raw: unknown,
  parsed: unknown,
  at = '',
): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    if (raw.length !== parsed.length) return [];
    const dropped: string[] = [];
    raw.forEach((item, i) => {
      for (const member of droppedMembers(item, parsed[i], `${at}/${i}`))
        dropped.push(member);
    });
    return dropped;
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const dropped: string[] = [];
  for (const key of Object.keys(raw)) {
    const here = at + jsonPointer([key]);
    if (!Object.hasOwn(parsed, key)) dropped.push(here);
    else
      for (const member of droppedMembers(raw[key], parsed[key], here))
        dropped.push(member);
  }
  return dropped;
}
