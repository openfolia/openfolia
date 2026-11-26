import { isDeepStrictEqual } from 'node:util';
import { ScimInvalidValueError } from './scim-errors.js';
import {
  booleanOf,
  canonical,
  ENTERPRISE_USER_SCHEMA,
  FORBIDDEN_KEYS,
  GROUP_SCHEMA,
  isObject,
  type JsonObject,
  keyOf,
  MAX_KEYS,
  USER_SCHEMA,
} from './scim-json.js';

/**
 * One attribute, however a request spells it (#938). A core attribute may be named by itself
 * (`active`), in any case, in a container named by the core schema (`{ "urn:…:User": { "active": …
 * } }`) or with the schema before it (`urn:…:User:active`), and an extension's attribute in its
 * container or with the extension before it. What reads, checks or keeps a resource looks for
 * the plain names alone, so every body and every PATCH value goes through `resolveNames` first.
 */

const SCHEMAS = [USER_SCHEMA, GROUP_SCHEMA, ENTERPRISE_USER_SCHEMA];
/** What a core schema's URN begins with, in this version of SCIM and the one before. */
const CORE_URNS = [
  'urn:ietf:params:scim:schemas:core:',
  'urn:scim:schemas:core:',
];
const PLAIN_NAME = /^[A-Za-z$][\w$-]*$/;
/** A name with a path after it: `name.givenName`, `emails[type eq "work"]`. */
const PATH_NAME = /^[A-Za-z$][\w$-]*[.[]/;

/** What `name` names: a schema known here, or (`attr`) an attribute of it. */
export function schemaNamed(
  name: string,
): { schema: string; core: boolean; attr?: string } | undefined {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  for (const schema of SCHEMAS) {
    const core = schema !== ENTERPRISE_USER_SCHEMA;
    const own = schema.toLowerCase();
    if (lower === own) return { schema, core };
    if (lower.startsWith(`${own}:`)) {
      return { schema, core, attr: trimmed.slice(own.length + 1) };
    }
  }
  return undefined;
}

/** Whether `name` begins as a core schema does: one that `schemaNamed` does not know is refused. */
export function isCoreUrn(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return CORE_URNS.some((urn) => lower.startsWith(urn));
}

/**
 * `body` with each core attribute under its plain name and each enterprise attribute in the one
 * container, the first spelling's value kept; at most `MAX_KEYS` in each. 400
 * `scim-invalid-value` for two spellings that disagree, for a core schema that holds no
 * attributes, for a name of a core schema that names none, and for a schema named inside a
 * container (each is read at the top level only). `paths` keeps what follows a schema when it is
 * a path (`name.givenName`), for a PATCH to apply; otherwise that is refused too. Unassigned
 * (null) containers are left out, or kept for the enterprise one, which a PATCH may clear.
 */
export function resolveNames(body: JsonObject, paths = false): JsonObject {
  const into: JsonObject = {};
  const attribute = (
    schema: string,
    core: boolean,
    attr: string,
    value: unknown,
  ) => {
    if (PLAIN_NAME.test(attr)) {
      put(core ? into : containerIn(into, schema), attr, value);
    } else if (paths && PATH_NAME.test(attr)) {
      put(into, core ? attr : `${schema}:${attr}`, value);
    } else throw noAttribute(`${schema}:${attr}`);
  };
  for (const [key, value] of Object.entries(body)) {
    const named = schemaNamed(key);
    if (named === undefined) {
      if (isCoreUrn(key)) throw noAttribute(key);
      put(into, key, value);
    } else if (named.attr !== undefined) {
      attribute(named.schema, named.core, named.attr, value);
    } else if (isObject(value)) {
      if (!named.core) containerIn(into, named.schema);
      for (const [inner, item] of Object.entries(value)) {
        if (schemaNamed(inner) || isCoreUrn(inner)) throw noAttribute(inner);
        attribute(named.schema, named.core, inner.trim(), item);
      }
    } else if (value !== null) throw noAttribute(key);
    else if (!named.core) put(into, named.schema, value);
  }
  return into;
}

function containerIn(into: JsonObject, schema: string): JsonObject {
  const current = into[schema];
  if (isObject(current)) return current;
  if (current !== undefined) throw disagree(schema);
  put(into, schema, {});
  return into[schema] as JsonObject;
}

function put(into: JsonObject, given: string, value: unknown): void {
  const name = given.trim();
  if (FORBIDDEN_KEYS.has(name)) throw noAttribute(name);
  const key = keyOf(into, name);
  if (key !== undefined) {
    if (!isDeepStrictEqual(into[key], value)) throw disagree(name);
    return;
  }
  if (Object.keys(into).length >= MAX_KEYS) {
    throw new ScimInvalidValueError(
      `The body has more than ${MAX_KEYS} attributes.`,
    );
  }
  into[canonical(name)] = value;
}

/**
 * 400 `scim-invalid-value` for an object, at any depth of `value`, that has one attribute twice,
 * in different cases and with different values: names ignore case, so which one is read would be
 * chance. `value` is checked (`checkJson`).
 */
export function checkSpellings(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) checkSpellings(item);
  } else if (isObject(value)) {
    const byName = new Map<string, unknown>();
    for (const [key, item] of Object.entries(value)) {
      const name = key.toLowerCase();
      if (byName.has(name) && !isDeepStrictEqual(byName.get(name), item)) {
        throw disagree(key);
      }
      byName.set(name, item);
      checkSpellings(item);
    }
  }
}

/**
 * Whether `body`, which may be wrong in anything else, says in some spelling that the user is
 * inactive, and in none that they are anything else; undefined when it says nothing. What a
 * refused request says of it is read so: a deactivation is never held up by the rest.
 */
export function saysInactive(body: unknown): boolean | undefined {
  if (!isObject(body)) return undefined;
  const values = Object.entries(body).flatMap(([key, value]) => {
    const named = schemaNamed(key);
    if (!named) return isActive(key) ? [value] : [];
    if (!named.core) return [];
    if (named.attr !== undefined) return isActive(named.attr) ? [value] : [];
    if (!isObject(value)) return [];
    return Object.entries(value).flatMap(([k, v]) => (isActive(k) ? [v] : []));
  });
  if (values.length === 0) return undefined;
  return values.every((value) => booleanOf(value) === false);
}

export const isActive = (name: string): boolean =>
  name.trim().toLowerCase() === 'active';

const noAttribute = (name: string) =>
  new ScimInvalidValueError(`"${name.slice(0, 200)}" names no attribute.`);

const disagree = (name: string) =>
  new ScimInvalidValueError(
    `"${name.slice(0, 200)}" is given twice, with different values.`,
  );

/** A key a password is under: `password`, or one that ends so (`urn:…:password`, `x.password`). */
const PASSWORD = /(^|[:.\s])password($|[:.\s[])/i;

/** `value` without any password, at any depth: none is ever kept, in an extension neither. */
export function withoutPasswords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPasswords);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PASSWORD.test(key))
      .map(([key, item]) => [key, withoutPasswords(item)]),
  );
}
