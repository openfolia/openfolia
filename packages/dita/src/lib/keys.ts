import type { XmlElement, XmlNode } from '@openfolia/xml';
import { DITA_FILTER_ATTRIBUTES } from '@openfolia/content-model';
import { attr, child, elements, nameOf, pushAll, tokens } from './elements.js';
import type { DitaDoc, Project } from './load.js';
import {
  extensionOf,
  hasScheme,
  resolvePath,
  splitReference,
} from './paths.js';
import type { DitaReport } from './report.js';

/** How many key definitions redirect to another key (`@keyref` on a key definition) before giving up. */
const MAX_KEY_REDIRECTS = 16;

/** One effective key definition. */
export interface KeyDef {
  readonly key: string;
  /** The map holding it. */
  readonly map: string;
  readonly element: XmlElement;
  /** What it points to in the archive, if anything. */
  readonly target?: { readonly path: string; readonly fragment?: string };
  /** An address outside the archive (`scope="external"`, or a scheme). */
  readonly external?: string;
  /** Its `<topicmeta>`, for text: `keywords/keyword`, `linktext`, `navtitle`. */
  readonly meta?: XmlElement;
}

/** The element a map's reference points at another map with (`<mapref>`, `format="ditamap"`). */
export function isMapReference(element: XmlElement): boolean {
  const href = attr(element, 'href');
  return (
    href !== undefined &&
    (nameOf(element) === 'mapref' ||
      attr(element, 'format') === 'ditamap' ||
      extensionOf(href.split('#')[0] ?? '') === '.ditamap')
  );
}

/** The map a map reference names, read already; undefined for none. */
export function referencedMap(
  project: Project,
  from: DitaDoc,
  element: XmlElement,
): DitaDoc | undefined {
  const ref = splitReference(attr(element, 'href') ?? '');
  if (!ref || ref.path === '') return undefined;
  const path = resolvePath(from.path, ref.path);
  const doc = path === undefined ? undefined : project.docs.get(path);
  return doc?.kind === 'map' ? doc : undefined;
}

/**
 * A root map's key space (DITA 1.3, 2.3.4.1, "Effective key definitions"):
 * the first definition of a key in a breadth-first traversal of the root
 * map and the maps it references wins, so a key the root map defines
 * overrides one of a submap. `@keyscope` is not read (one scope for the
 * whole map, reported), and a definition's own condition is not evaluated
 * (the first one wins whatever its condition; reported).
 */
export class KeySpace {
  private readonly defs = new Map<string, KeyDef>();
  /** The maps read, root first, breadth-first. */
  readonly maps: readonly DitaDoc[];

  constructor(project: Project, root: DitaDoc, report: DitaReport) {
    const maps: DitaDoc[] = [];
    const seen = new Set<string>();
    const queue: DitaDoc[] = [root];
    seen.add(root.path);
    let scopeReported = false;
    while (queue.length > 0) {
      const map = queue.shift() as DitaDoc;
      maps.push(map);
      const stack = [...elements(map.root)].reverse();
      while (stack.length > 0) {
        const element = stack.pop() as XmlElement;
        const name = nameOf(element);
        if (name === 'topicmeta' || name === 'reltable') continue;
        if (attr(element, 'keyscope') !== undefined && !scopeReported) {
          scopeReported = true;
          report.add(
            'keyscope',
            { source: map.path, kind: element.local },
            'Key scopes (@keyscope) are not read: every key of the map is in one scope, the first definition winning.',
          );
        }
        for (const key of tokens(attr(element, 'keys'))) {
          if (this.defs.has(key)) continue;
          if (
            DITA_FILTER_ATTRIBUTES.some((a) => attr(element, a) !== undefined)
          ) {
            report.add(
              'conditional-key',
              { source: `${map.path}#${key}`, kind: element.local },
              `The key "${key}" is defined with a condition, which is not evaluated: its first definition is used for every variant.`,
            );
          }
          this.defs.set(key, defOf(map, element, key));
        }
        if (isMapReference(element)) {
          const sub = referencedMap(project, map, element);
          if (sub && !seen.has(sub.path)) {
            seen.add(sub.path);
            queue.push(sub);
          }
          continue;
        }
        pushAll(stack, [...elements(element)].reverse());
      }
    }
    this.maps = maps;
  }

  /** The effective definition of `key`, following redirections (`@keyref` on a definition without `@href`). */
  get(key: string): KeyDef | undefined {
    let def = this.defs.get(key);
    for (let i = 0; def && i < MAX_KEY_REDIRECTS; i++) {
      const next = attr(def.element, 'keyref');
      if (next === undefined || def.target || def.external) return def;
      const redirected = this.defs.get(next.split('/')[0] ?? '');
      if (!redirected || redirected === def) return def;
      def = { ...redirected, key, meta: def.meta ?? redirected.meta };
    }
    return def;
  }

  /** Every key defined, in definition order. */
  keys(): string[] {
    return [...this.defs.keys()];
  }
}

function defOf(map: DitaDoc, element: XmlElement, key: string): KeyDef {
  const href = attr(element, 'href');
  const meta = child(element, 'topicmeta');
  const base = { key, map: map.path, element, ...(meta && { meta }) };
  if (href === undefined) return base;
  if (attr(element, 'scope') === 'external' || hasScheme(href)) {
    return { ...base, external: href.trim() };
  }
  const ref = splitReference(href);
  const path =
    ref && ref.path !== '' ? resolvePath(map.path, ref.path) : undefined;
  if (!ref || path === undefined) return base;
  return {
    ...base,
    target: {
      path,
      ...(ref.fragment !== undefined && { fragment: ref.fragment }),
    },
  };
}

/** The text a key holds for an element without content: `keywords/keyword`, else `linktext`, else `navtitle`. */
export function keyText(def: KeyDef): XmlElement | undefined {
  const meta = def.meta;
  if (!meta) return undefined;
  const keywords = child(meta, 'keywords');
  const keyword = keywords && child(keywords, 'keyword');
  return keyword ?? child(meta, 'linktext') ?? child(meta, 'navtitle');
}

/** Elements whose text is no part of a title's text. */
const NOT_TEXT = new Set([
  'indexterm',
  'index-base',
  'sort-as',
  'draft-comment',
  'required-cleanup',
  'fn',
  'data',
  'data-about',
  'foreign',
  'unknown',
]);

/** The most key texts put into one text (a key's text may name keys itself). */
const MAX_KEY_TEXTS = 64;
/**
 * The longest a text with keys put in may grow (a title's): past it, the
 * text is cut. A text with no key is as long as the file has it.
 */
export const MAX_KEYED_TEXT_CHARS = 4096;

/**
 * An element's text as plain text (a title's), each empty element naming a
 * key (`<ph keyref>`) replaced by the key's text, index terms, footnotes and
 * other non-text left out. With a key put in, at most
 * `MAX_KEYED_TEXT_CHARS` characters: a large key text named many times
 * multiplies nothing.
 */
export function textWithKeys(
  node: XmlNode,
  keys: KeySpace | undefined,
): string {
  if (typeof node === 'string') return node;
  let out = '';
  let substituted = 0;
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop() as XmlNode;
    if (typeof next === 'string') {
      out += next;
      if (substituted > 0 && out.length > MAX_KEYED_TEXT_CHARS) {
        // Never half a surrogate pair.
        const cut = out.slice(0, MAX_KEYED_TEXT_CHARS);
        return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
      }
      continue;
    }
    const name = nameOf(next);
    if (next !== node && name !== undefined && NOT_TEXT.has(name)) continue;
    const keyref = attr(next, 'keyref');
    const empty = next.children.every(
      (c) => typeof c === 'string' && c.trim() === '',
    );
    if (keyref !== undefined && empty && keys && substituted < MAX_KEY_TEXTS) {
      const def = keys.get(keyref.split('/')[0] ?? keyref);
      const text = def && keyText(def);
      if (text) {
        substituted++;
        stack.push(text);
      }
      continue;
    }
    for (let i = next.children.length - 1; i >= 0; i--) {
      stack.push(next.children[i] as XmlNode);
    }
  }
  return out;
}
