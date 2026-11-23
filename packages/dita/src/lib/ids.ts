import { sha256Hex } from '@openfolia/content-model';

/** The longest module (and manual) ID. */
const MAX_MODULE_ID = 100;
/** The longest block ID. */
const MAX_BLOCK_ID = 64;

/**
 * `text` as a slug: letters without their diacritics, lowercase, every run
 * of anything else one `-`, none at either end. Empty when nothing is left.
 */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The first 8 hex digits of the SHA-256 of `text`: a stable, short suffix. */
const shortHash = (text: string) => sha256Hex(text).slice(0, 8);

/** `base` cut to `max` characters with `-<hash of key>`, never ending in `-`. */
function withHash(base: string, key: string, max: number): string {
  const room = max - 9;
  const cut = base.slice(0, room).replace(/-+$/, '');
  return `${cut === '' ? 'x' : cut}-${shortHash(key)}`;
}

/**
 * The module IDs of source keys (a topic file's path within its language
 * folder, with `#<topic id>` for a topic of a `<dita>` document): the slug of
 * the path without its extension, the topic ID appended. Deterministic: the
 * same key always gives the same ID, so a second import of a project updates
 * the modules the first made. A slug longer than a module ID may be, or one
 * two keys share, takes the first 8 hex digits of the key's SHA-256
 * instead of its tail (every key sharing it does, so none depends on the
 * order of the others).
 */
export function moduleIds(keys: Iterable<string>): Map<string, string> {
  const wanted = new Map<string, string>();
  const count = new Map<string, number>();
  for (const key of new Set(keys)) {
    const [path = '', topic] = key.split('#');
    const base =
      [slug(path.replace(/\.[^./]*$/, '')), topic && slug(topic)]
        .filter((part) => part)
        .join('-') || 'topic';
    wanted.set(key, base);
    count.set(base, (count.get(base) ?? 0) + 1);
  }
  const ids = new Map<string, string>();
  for (const [key, base] of wanted) {
    ids.set(
      key,
      base.length > MAX_MODULE_ID || (count.get(base) ?? 0) > 1
        ? withHash(base, key, MAX_MODULE_ID)
        : base,
    );
  }
  return ids;
}

/**
 * Block IDs for one module, given in document order: a DITA `@id` as a
 * slug (a letter first, at most 64 characters) when it is free, else
 * `<kind>-<n>`, numbered per kind. The same document structure always gives
 * the same IDs, so a translation (which keeps its source's `@id`s and
 * structure) gets its source's block IDs.
 */
export class BlockIds {
  private readonly taken = new Set<string>();
  private readonly counters = new Map<string, number>();

  /** Marks IDs as used already (a callout's, say). */
  reserve(id: string): void {
    this.taken.add(id);
  }

  take(kind: string, ditaId?: string): string {
    if (ditaId !== undefined) {
      let wanted = slug(ditaId);
      if (wanted !== '' && !/^[a-z]/.test(wanted)) wanted = `x-${wanted}`;
      if (wanted.length > MAX_BLOCK_ID) {
        wanted = withHash(wanted, ditaId, MAX_BLOCK_ID);
      }
      if (wanted !== '' && !this.taken.has(wanted)) {
        this.taken.add(wanted);
        return wanted;
      }
    }
    for (;;) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      const id = `${kind}-${n}`;
      if (!this.taken.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
  }
}
