import { ScimInvalidValueError } from './scim-errors.js';
import { spend, weightOf } from './scim-work.js';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE_USER_SCHEMA =
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const LIST_RESPONSE_SCHEMA =
  'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** A JSON object as SCIM sends and answers resources. */
export type JsonObject = { [key: string]: unknown };

/** Whether `value` is a plain JSON object (not an array, not null). */
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keys never taken from a request: they would reach an object's prototype. */
export const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** How deep a request's JSON may nest. */
const MAX_DEPTH = 8;

/** The most attributes one object of a body may have. */
export const MAX_KEYS = 100;

/**
 * Checks what a request sent before anything reads it: no key that reaches a prototype, at most
 * `MAX_DEPTH` levels and `MAX_KEYS` attributes per object, no text the database cannot hold. 400
 * `scim-invalid-value` otherwise.
 */
export function checkJson(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new ScimInvalidValueError(
      `The body nests deeper than ${MAX_DEPTH} levels.`,
    );
  }
  if (typeof value === 'string') checkText(value);
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1);
  } else if (isObject(value)) {
    const entries = Object.entries(value);
    // A SCIM object has a few dozen attributes; names are looked up ignoring case (`keyOf`), so
    // an object with thousands would cost seconds under the access lock.
    if (entries.length > MAX_KEYS) {
      throw new ScimInvalidValueError(
        `An object of the body has more than ${MAX_KEYS} attributes.`,
      );
    }
    for (const [key, item] of entries) {
      checkText(key);
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ScimInvalidValueError(`"${key}" is no attribute.`);
      }
      checkJson(item, depth + 1);
    }
  }
}

/** 400 `scim-invalid-value` for text the database cannot hold. */
export function checkText(text: string): void {
  if (text.includes('\0') || !text.isWellFormed()) {
    throw new ScimInvalidValueError(
      'A text of the body holds U+0000 or half a surrogate pair.',
    );
  }
}

/**
 * The key of `object` naming `name`, ignoring case (SCIM's attribute names are case-insensitive,
 * RFC 7643 section 2.1); undefined when there is none.
 */
export function keyOf(object: JsonObject, name: string): string | undefined {
  const lower = name.toLowerCase();
  const keys = Object.keys(object);
  spend(1 + weightOf(name) + keys.length);
  return keys.find((key) => {
    spend(weightOf(key));
    return key.toLowerCase() === lower;
  });
}

/** A boolean, also as the string some directories send (`"True"`); undefined for anything else. */
export function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return lower === 'true' ? true : lower === 'false' ? false : undefined;
}

/** The value of the attribute `name` of `object`, ignoring case. */
export function attributeOf(object: JsonObject, name: string): unknown {
  const key = keyOf(object, name);
  return key === undefined ? undefined : object[key];
}

/**
 * The core attributes by their canonical spelling, lowercase to as written (RFC 7643, sections 4.1
 * and 4.2): what a request sent in another case is kept as.
 */
const CANONICAL = new Map(
  [
    'schemas',
    'id',
    'externalId',
    'meta',
    'userName',
    'name',
    'displayName',
    'nickName',
    'profileUrl',
    'title',
    'userType',
    'preferredLanguage',
    'locale',
    'timezone',
    'active',
    'password',
    'emails',
    'phoneNumbers',
    'ims',
    'photos',
    'addresses',
    'groups',
    'entitlements',
    'roles',
    'x509Certificates',
    'members',
    'formatted',
    'familyName',
    'givenName',
    'middleName',
    'honorificPrefix',
    'honorificSuffix',
    'value',
    'display',
    'type',
    'primary',
  ].map((name) => [name.toLowerCase(), name]),
);

/** `name` as its canonical spelling when it is a core attribute; else as given. */
export const canonical = (name: string): string =>
  CANONICAL.get(name.toLowerCase()) ?? name;

/**
 * The key to write `name` under in `object`: the one it has already (ignoring case), else the
 * canonical spelling. 400 `scim-invalid-value` for a key that would reach the prototype.
 */
export function keyToWrite(object: JsonObject, name: string): string {
  if (FORBIDDEN_KEYS.has(name)) {
    throw new ScimInvalidValueError(`"${name}" is no attribute.`);
  }
  return keyOf(object, name) ?? canonical(name);
}

/** Whether `name` is a schema URN (an extension's attributes sit under it). */
export const isSchemaUrn = (name: string): boolean => /^urn:/i.test(name);

/** Whether `schema` is one of the core schemas, whose attributes sit at the resource's top. */
export const isCoreSchema = (schema: string): boolean =>
  [USER_SCHEMA, GROUP_SCHEMA].some(
    (s) => s.toLowerCase() === schema.toLowerCase(),
  );
