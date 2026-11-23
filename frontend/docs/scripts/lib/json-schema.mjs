// A JSON Schema as a table of its fields (`a.b`, `a[]`, `a.<key>`), for the references made from
// schemas: the project configuration (`openfolia.yaml`), the import format and the MCP tools' inputs.
import { breakableCode, cell, code, table } from './markdown.mjs';

const MAX_DEPTH = 8;

function resolve(schema, root) {
  let at = schema;
  for (let i = 0; i < 20 && at?.$ref; i++) {
    const ref = at.$ref;
    if (!ref.startsWith('#/')) return at;
    at = ref
      .slice(2)
      .split('/')
      .reduce(
        (node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')],
        root,
      );
  }
  return at ?? {};
}

/** The schemas a union or intersection is made of, resolved. */
function variants(schema, root) {
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].map((s) =>
    resolve(s, root),
  );
}

/** A short type: `string`, `"a" \| "b"`, `integer (1 to 10)`, `string[]`, `object`. */
export function typeOf(schema, root) {
  const s = resolve(schema, root);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum))
    return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const union = variants(s, root);
  if (union.length > 0)
    return [...new Set(union.map((v) => typeOf(v, root)))].join(' | ');
  if (s.allOf?.length === 1) return typeOf(s.allOf[0], root);
  const type = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (type === 'array') return `${s.items ? typeOf(s.items, root) : 'any'}[]`;
  if (type === 'integer' || type === 'number') {
    const min = s.minimum ?? s.exclusiveMinimum;
    const max = s.maximum ?? s.exclusiveMaximum;
    if (min !== undefined && max !== undefined)
      return `${type} (${min} to ${max})`;
    if (min !== undefined) return `${type} (from ${min})`;
    if (max !== undefined) return `${type} (up to ${max})`;
  }
  if (type === 'string') {
    if (s.format) return `string (${s.format})`;
    if (s.maxLength !== undefined) return `string (at most ${s.maxLength})`;
  }
  if (type === 'object' && !s.properties && s.additionalProperties)
    return 'object';
  return type ?? 'any';
}

/**
 * One row per field, nested objects and arrays of objects walked to their fields.
 *
 * @returns {{ path: string, type: string, required: boolean, default: unknown, description: string }[]}
 */
export function fields(
  schema,
  root = schema,
  prefix = '',
  depth = 0,
  seen = new Set(),
) {
  const s = resolve(schema, root);
  if (depth > MAX_DEPTH || seen.has(s)) return [];
  const next = new Set(seen).add(s);
  const rows = [];
  const objects = [
    s,
    ...variants(s, root),
    ...(s.allOf ?? []).map((x) => resolve(x, root)),
  ].filter(
    (x) =>
      x.properties ||
      (x.additionalProperties && typeof x.additionalProperties === 'object'),
  );
  for (const object of objects) {
    const required = new Set(object.required ?? []);
    for (const [name, child] of Object.entries(object.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      const c = resolve(child, root);
      rows.push({
        path,
        type: typeOf(child, root),
        required: required.has(name),
        default: c.default,
        description: c.description ?? child.description ?? '',
      });
      rows.push(...nested(c, root, path, depth, next));
    }
    if (
      object.additionalProperties &&
      typeof object.additionalProperties === 'object'
    ) {
      const path = `${prefix ? `${prefix}.` : ''}<key>`;
      const c = resolve(object.additionalProperties, root);
      if (c.properties || c.type === 'array' || variants(c, root).length > 0) {
        rows.push({
          path,
          type: typeOf(c, root),
          required: false,
          default: undefined,
          description: c.description ?? '',
        });
        rows.push(...nested(c, root, path, depth, next));
      }
    }
  }
  return mergeRows(rows);
}

/**
 * One row per path: a field the variants of a union share (`kind` of each variant) is one row,
 * its types joined (`"enum" | "version"`), its description the first one given.
 */
function mergeRows(rows) {
  const byPath = new Map();
  for (const row of rows) {
    const held = byPath.get(row.path);
    if (!held) {
      byPath.set(row.path, { ...row });
      continue;
    }
    const types = held.type.split(' | ');
    for (const type of row.type.split(' | ')) {
      if (!types.includes(type)) types.push(type);
    }
    held.type = types.join(' | ');
    held.description ||= row.description;
  }
  return [...byPath.values()];
}

/** The fields without a description, as problems for the build to fail on (`what`: the reference). */
export function undescribedFields(rows, what) {
  return rows
    .filter((r) => !r.description.trim())
    .map((r) => `${what}: \`${r.path}\` has no description`);
}

function nested(schema, root, path, depth, seen) {
  if (schema.type === 'array' && schema.items) {
    const item = resolve(schema.items, root);
    return fields(item, root, `${path}[]`, depth + 1, seen);
  }
  return fields(schema, root, path, depth + 1, seen);
}

/** JSON on one line with a space after each `,` and `:`, so a long default wraps in its cell. */
export function compactJson(value) {
  return (
    JSON.stringify(value, null, 1)?.replace(/\n\s*/g, ' ') ?? String(value)
  );
}

/** The rows as a table. */
export function fieldsTable(rows, { required = true } = {}) {
  return table(
    [
      'Field',
      'Type',
      ...(required ? ['Required'] : []),
      'Default',
      'Description',
    ],
    rows.map((r) => [
      breakableCode(r.path),
      cell(code(r.type)),
      ...(required ? [r.required ? 'yes' : ''] : []),
      r.default === undefined ? '' : cell(code(compactJson(r.default))),
      cell(r.description),
    ]),
  );
}
