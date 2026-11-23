import type { ModuleMeta } from '@openfolia/content-model';

/**
 * ProseMirror's JSON form of a document, exactly as `Node.toJSON()` writes
 * it: `attrs` on every node type that has attributes (all of them, `null`
 * included), `content` only when there is some, `marks` only when there are
 * some (the converters keep an explicit empty list the model had).
 */
export interface EditorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: EditorMark[];
  text?: string;
}

/** The whole module: its ID, schema version and metadata are the document's attributes. */
export interface EditorDoc extends EditorNode {
  type: 'doc';
  attrs: {
    moduleId: string;
    schemaVersion: number;
    meta: ModuleMeta | null;
  };
}

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` as plain JSON, or `undefined` when it isn't plain JSON
 * (a function, a class instance, a non-finite number, a cycle) or nests
 * deeper than `maxDepth`. As in `JSON.stringify`, a property that is
 * `undefined` is left out and an `undefined` array element is `null`. Never
 * throws on plain data, and never copies `__proto__`. Call it only on values
 * `exceededLimit` passed: it doesn't budget shared references itself.
 */
export function plainJson(value: unknown, maxDepth: number): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    // -0 as 0: JSON has no negative zero.
    return Number.isFinite(value) ? value + 0 : undefined;
  if (maxDepth <= 0 || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value) {
      const copy = item === undefined ? null : plainJson(item, maxDepth - 1);
      if (copy === undefined) return undefined;
      out.push(copy);
    }
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || item === undefined) continue;
    const copy = plainJson(item, maxDepth - 1);
    if (copy === undefined) return undefined;
    out[key] = copy;
  }
  return out;
}
