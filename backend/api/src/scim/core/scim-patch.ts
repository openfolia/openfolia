import { isDeepStrictEqual } from 'node:util';
import {
  ScimInvalidPathError,
  ScimInvalidSyntaxError,
  ScimInvalidValueError,
  ScimMutabilityError,
  ScimNoTargetError,
} from './scim-errors.js';
import {
  attrPathOf,
  type AttrPath,
  type Filter,
  matches,
  MAX_FILTER_LENGTH,
  Parser,
  tokenize,
} from './scim-filter.js';
import {
  attributeOf,
  booleanOf,
  checkJson,
  isObject,
  isSchemaUrn,
  type JsonObject,
  keyOf,
  keyToWrite,
} from './scim-json.js';
import {
  checkSpellings,
  isActive,
  isCoreUrn,
  resolveNames,
  saysInactive,
  schemaNamed,
} from './scim-names.js';
import { jsonOf, spend, withBudget } from './scim-work.js';

/**
 * SCIM's PATCH (RFC 7644, section 3.5.2): `add`, `replace` and `remove`, with or without a
 * `path`, value paths (`emails[type eq "work"].value`, `members[value eq "…"]`) and paths into
 * an extension (`urn:…:enterprise:2.0:User:manager`). Applied to a resource as the API answers it;
 * the caller then saves the result as if it had been sent whole (a PUT), so every check of a
 * resource holds for a patched one too. Operation names ignore case, as directories send them
 * (`Replace`). Two leniencies directories rely on: an `add` or `replace` of a value filter
 * `attr eq "x"` with a sub-attribute that matches nothing adds the value (`{ attr: "x", sub: … }`),
 * and a `remove` of a multi-valued attribute with a `value` removes the values listed (by their
 * `value`), as a group's members are removed.
 */

export interface PatchOperation {
  readonly op: 'add' | 'replace' | 'remove';
  readonly path?: string;
  readonly value?: unknown;
}

/** The most operations one PATCH may hold. */
export const MAX_OPERATIONS = 1000;

/** A patch `path`: an attribute path, with a value filter and a sub-attribute after it. */
export interface PatchPath {
  readonly path: AttrPath;
  readonly filter?: Filter;
  /** After a value filter: `emails[type eq "work"].value`. */
  readonly sub?: string;
}

/** Reads a PatchOp request body (`schemas`, `Operations`); 400 `scim-invalid-syntax` otherwise. */
export function patchOperationsOf(body: unknown): PatchOperation[] {
  if (!isObject(body)) throw syntax('The body is no PatchOp object.');
  checkMembers(body);
  const operations = attributeOf(body, 'Operations');
  if (!Array.isArray(operations) || operations.length === 0) {
    throw syntax('A PatchOp needs a non-empty "Operations" list.');
  }
  if (operations.length > MAX_OPERATIONS) {
    throw new ScimInvalidValueError(
      `A PatchOp holds at most ${MAX_OPERATIONS} operations.`,
    );
  }
  return operations.map(operationOf);
}

/**
 * `patchOperationsOf` for a user: a body it refuses whose operations, those that can be read,
 * leave the user inactive is the deactivation alone.
 */
export function userOperationsOf(body: unknown): PatchOperation[] {
  try {
    return patchOperationsOf(body);
  } catch (error) {
    const sent = Object.entries(isObject(body) ? body : {})
      .filter(([key]) => key.toLowerCase() === 'operations')
      .flatMap(([, operations]) => operations);
    const readable = sent.flatMap((operation) => {
      try {
        return [operationOf(operation)];
      } catch {
        return [];
      }
    });
    if (!leavesInactive(readable)) throw error;
    return [{ op: 'replace', path: 'active', value: false }];
  }
}

function operationOf(operation: unknown): PatchOperation {
  if (!isObject(operation)) throw syntax('An operation is no object.');
  checkMembers(operation);
  const op = attributeOf(operation, 'op');
  const name = typeof op === 'string' ? op.toLowerCase() : '';
  if (name !== 'add' && name !== 'replace' && name !== 'remove') {
    throw syntax('An operation\'s "op" is add, replace or remove.');
  }
  const path = attributeOf(operation, 'path');
  if (path !== undefined && path !== null && typeof path !== 'string') {
    throw new ScimInvalidPathError('An operation\'s "path" is a string.');
  }
  return {
    op: name,
    ...(typeof path === 'string' && path.trim() !== '' && { path }),
    ...(keyOf(operation, 'value') !== undefined && {
      value: attributeOf(operation, 'value'),
    }),
  };
}

function checkMembers(object: JsonObject): void {
  const names = Object.keys(object).map((k) => k.toLowerCase());
  if (new Set(names).size < names.length) {
    throw syntax('A PatchOp has a member twice, in different cases.');
  }
}

const syntax = (detail: string) => new ScimInvalidSyntaxError(detail);

/** Parses a patch path; 400 `scim-invalid-path` for one that does not parse. */
export function parsePatchPath(text: string): PatchPath {
  if (text.length > MAX_FILTER_LENGTH) {
    throw new ScimInvalidPathError(
      `A path is at most ${MAX_FILTER_LENGTH} characters long.`,
    );
  }
  try {
    const open = text.indexOf('[');
    if (open < 0) return { path: patchable(attrPathOf(text.trim())) };
    const close = text.lastIndexOf(']');
    if (close < open) throw new Error('unclosed');
    const path = patchable(attrPathOf(text.slice(0, open).trim()));
    if (path.sub !== undefined) throw new Error('sub before filter');
    const parser = new Parser(tokenize(text.slice(open + 1, close)));
    const filter = parser.filter();
    if (!parser.done) throw new Error('trailing');
    const after = text.slice(close + 1).trim();
    if (after === '') return { path, filter };
    const sub = /^\.([A-Za-z$][\w$-]*)$/.exec(after)?.[1];
    if (sub === undefined) throw new Error('bad sub');
    return { path, filter, sub };
  } catch {
    throw new ScimInvalidPathError(`The path "${text}" does not parse.`);
  }
}

/**
 * `path`, unless what comes before its last `:` is a core schema this API has none of, or it goes
 * on from a schema's name (`urn:…:User.active`) or an attribute's (`urn:…:User:manager:x`): that would be written where nothing reads it.
 */
function patchable(path: AttrPath): AttrPath {
  const { schema, attr } = path;
  if (schema === undefined) return path;
  const named = schemaNamed(`${schema}:${attr}`);
  if (isCoreUrn(`${schema}:`) || (named && named.attr !== attr)) {
    throw new Error('no attribute');
  }
  return path;
}

/** Attributes no patch may change: the server's own. */
const READ_ONLY = new Set(['id', 'meta', 'groups']);

/**
 * Applies `operations` to a copy of `resource` and answers it. 400 with the `scimType` the
 * standard gives for a path that does not parse, selects nothing it could change, or names a
 * read-only attribute.
 */
export function applyPatch(
  resource: JsonObject,
  operations: readonly PatchOperation[],
): JsonObject {
  const result = structuredClone(resource);
  seen = new WeakMap();
  withBudget(() => {
    for (const { value, ...operation } of operations) {
      checkJson(operation);
      checkJson(value);
      checkSpellings(value);
      // Cloned: it becomes the result's, which later operations change in place, and a
      // contended change runs again on the same operations.
      apply(result, { ...operation, value: structuredClone(value) });
    }
  });
  return result;
}

/**
 * Whether `operations`, some of which may be wrong, leave a user inactive by what they say of
 * `active` (`saysInactive`).
 */
export function leavesInactive(operations: readonly PatchOperation[]): boolean {
  let inactive: boolean | undefined;
  for (const { op, path, value } of operations) {
    const whole = path === undefined ? undefined : schemaNamed(path);
    if (path === undefined || (whole?.core && whole.attr === undefined)) {
      if (op !== 'remove') inactive = saysInactive(value) ?? inactive;
    } else if (isActive(whole?.core ? (whole.attr ?? '') : path)) {
      inactive = op !== 'remove' && booleanOf(value) === false;
    }
  }
  return inactive === true;
}

/**
 * The JSON of each value of a multi-valued attribute, kept for the PATCH's next add to the same
 * values (a directory adds members one by one); forgotten where they change in place.
 */
let seen = new WeakMap<unknown[], Set<string | undefined>>();

function apply(
  resource: JsonObject,
  { op, path, value: given }: PatchOperation,
): void {
  // A null beside a remove is how some clients leave the value out.
  const value = op === 'remove' && given === null ? undefined : given;
  if (path === undefined) {
    if (op === 'remove') {
      throw new ScimNoTargetError('A remove needs a "path".');
    }
    if (!isObject(value)) {
      throw new ScimInvalidValueError(
        `An ${op} without a "path" needs an object as its "value".`,
      );
    }
    for (const [name, item] of Object.entries(resolveNames(value, true))) {
      const extension =
        isSchemaUrn(name) && schemaNamed(name)?.attr === undefined;
      if (extension && isObject(item)) {
        // An extension's attributes, each one by one.
        const container = objectAt(resource, name);
        for (const [inner, innerItem] of Object.entries(item)) {
          setAttribute(container, inner, innerItem, op);
        }
      } else if (/[.[]/.test(name) && item !== null) {
        // A path as a name, as some directories send (`name.givenName`, `urn:…:User:manager`).
        apply(resource, { op, path: name, value: item });
      } else {
        if (isReadOnly(resource, name, item)) continue;
        setAttribute(resource, name, item, op);
      }
    }
    return;
  }
  const whole = schemaNamed(path);
  if (whole && whole.attr === undefined) {
    // A schema as the path: its attributes are the value's.
    if (op !== 'remove') {
      if (!isObject(value)) {
        throw new ScimInvalidValueError(
          `An ${op} of a schema needs an object as its "value".`,
        );
      }
      return apply(resource, { op, value: { [whole.schema]: value } });
    }
    if (whole.core) {
      throw new ScimNoTargetError('A remove names the attribute to remove.');
    }
    return removeKey(resource, whole.schema);
  }
  const target = parsePatchPath(path);
  if (op !== 'remove' && value === undefined) {
    throw new ScimInvalidValueError(`An ${op} needs a "value".`);
  }
  const { attr, sub } = target.path;
  // Only a whole attribute may be named with the value it has; a part or a removal is a change.
  const same =
    op !== 'remove' && !target.filter && sub === undefined ? value : undefined;
  if (!target.path.schema && isReadOnly(resource, attr, same)) return;
  const container = target.path.schema
    ? op === 'remove'
      ? attributeOf(resource, target.path.schema)
      : objectAt(resource, target.path.schema)
    : resource;
  if (!isObject(container)) return;
  if (target.filter) return applyFiltered(container, target, op, value);
  if (sub !== undefined) {
    const key = keyToWrite(container, attr);
    const current = container[key];
    if (op === 'remove') {
      if (Array.isArray(current)) {
        spend(current.length);
        seen.delete(current);
      }
      for (const item of Array.isArray(current) ? current : [current]) {
        if (isObject(item)) removeKey(item, sub);
      }
      return;
    }
    if (current !== undefined && !isObject(current)) {
      throw new ScimNoTargetError(`"${attr}" has no sub-attributes.`);
    }
    const object = (container[key] = current ?? {}) as JsonObject;
    setAttribute(object, sub, value, op);
    return;
  }
  if (op === 'remove') {
    const key = keyOf(container, attr);
    if (key === undefined) return;
    const current = container[key];
    if (value !== undefined && Array.isArray(current)) {
      // A remove with the values to take out (as directories remove a group's members).
      const items = Array.isArray(value) ? value : [value];
      const listed = new Set(items.map((item) => jsonOf(identityOf(item))));
      const kept = current.filter(
        (item) => !listed.has(jsonOf(identityOf(item))),
      );
      // Values someone meant to remove, none of which names one: not a removal that looks done.
      if (
        kept.length === current.length &&
        items.every((v) => isObject(v) && identityOf(v) === v)
      ) {
        throw new ScimNoTargetError(
          `The values to remove name none of "${attr}".`,
        );
      }
      container[key] = kept;
      return;
    }
    delete container[key];
    return;
  }
  setAttribute(container, attr, value, op);
}

/** An `add` or `replace` of one attribute of `object`, as the standard has them. */
function setAttribute(
  object: JsonObject,
  name: string,
  value: unknown,
  op: 'add' | 'replace' | 'remove',
): void {
  const key = keyToWrite(object, name);
  const current = object[key];
  if (op === 'add' && Array.isArray(current)) {
    // Added to a multi-valued attribute: appended, a value already there not twice.
    let known = seen.get(current);
    if (!known) {
      known = new Set(current.map(jsonOf));
      seen.set(current, known);
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = jsonOf(item);
      if (!known.has(text)) {
        known.add(text);
        current.push(item);
        if (isPrimary(item)) demoteOthers(current, item);
      }
    }
    return;
  }
  if (op === 'add' && isObject(current) && isObject(value)) {
    for (const [inner, item] of Object.entries(value)) {
      current[keyToWrite(current, inner)] = item;
    }
    return;
  }
  if (op === 'replace' && isObject(current) && isObject(value)) {
    // Replacing a complex attribute replaces the sub-attributes given.
    for (const [inner, item] of Object.entries(value)) {
      current[keyToWrite(current, inner)] = item;
    }
    return;
  }
  object[key] = value;
}

/** `add`, `replace` or `remove` through a value filter: on the values it selects. */
function applyFiltered(
  container: JsonObject,
  { path, filter, sub }: PatchPath,
  op: 'add' | 'replace' | 'remove',
  value: unknown,
): void {
  const key = keyToWrite(container, path.attr);
  const current = container[key];
  const items = Array.isArray(current)
    ? current
    : current === undefined
      ? []
      : [current];
  const parent = path.attr.toLowerCase();
  spend(items.length);
  // Its values may change in place below: the next add reads them again.
  if (Array.isArray(current)) seen.delete(current);
  const selected = items.filter(
    (item): item is JsonObject =>
      isObject(item) && matches(filter!, item, parent),
  );
  if (op === 'remove') {
    if (sub !== undefined) {
      for (const item of selected) removeKey(item, sub);
    } else if (Array.isArray(current)) {
      const gone = new Set<unknown>(selected);
      container[key] = items.filter((item) => !gone.has(item));
    } else if (selected.length > 0) delete container[key];
    return;
  }
  if (selected.length === 0) {
    // `emails[type eq "work"].value` on a user without a work address: added.
    const added =
      sub !== undefined && !isObject(current)
        ? simpleEquality(filter!)
        : undefined;
    if (!added) {
      throw new ScimNoTargetError(
        `The filter of "${path.attr}" selects no value.`,
      );
    }
    const item: JsonObject = {};
    item[keyToWrite(item, added.attr)] = added.value;
    item[keyToWrite(item, sub!)] = value;
    if (isPrimary(item)) demoteOthers(items, item);
    container[key] = [...items, item];
    return;
  }
  const size = ((jsonOf(value)?.length ?? 0) + (sub?.length ?? 0)) * 8;
  for (const item of selected) {
    // Written into every value selected, name and all: charged each time, or a large one would
    // multiply (`MAX_WORK` lets a PATCH add some 12 million characters so).
    spend(size);
    if (sub !== undefined) {
      item[keyToWrite(item, sub)] = value;
    } else if (isObject(value)) {
      if (op === 'replace') {
        const keys = Object.keys(item);
        spend(keys.length);
        for (const k of keys) delete item[k];
      }
      for (const [inner, v] of Object.entries(value)) {
        item[keyToWrite(item, inner)] = v;
      }
    } else {
      throw new ScimInvalidValueError(
        `The values "${path.attr}[…]" selects are objects: the "value" is one too.`,
      );
    }
  }
  const [only, ...more] = selected;
  if (more.length === 0 && isPrimary(only)) demoteOthers(items, only);
}

const isPrimary = (item: unknown): boolean =>
  isObject(item) && booleanOf(attributeOf(item, 'primary')) === true;

/** At most one value is primary: one made so takes over (RFC 7644, section 3.5.2). */
function demoteOthers(items: unknown[], primary: unknown): void {
  spend(items.length);
  for (const item of items) {
    if (item === primary || !isObject(item) || !isPrimary(item)) continue;
    item[keyToWrite(item, 'primary')] = false;
    seen.delete(items);
  }
}

/**
 * `attr eq "x"` (a string), as a value to add from; else undefined. Not `value eq …`, which names
 * one that is there: a group's member is never added by what a patch says of it.
 */
function simpleEquality(
  filter: Filter,
): { attr: string; value: string } | undefined {
  if (
    filter.kind === 'compare' &&
    filter.op === 'eq' &&
    typeof filter.value === 'string' &&
    filter.path.sub === undefined &&
    filter.path.schema === undefined &&
    filter.path.attr.toLowerCase() !== 'value'
  ) {
    return { attr: filter.path.attr, value: filter.value };
  }
  return undefined;
}

/** The object `object` holds under `name` (an extension's), made when there is none. */
function objectAt(object: JsonObject, name: string): JsonObject {
  const key = keyToWrite(object, name);
  const current = object[key];
  if (current === undefined) return (object[key] = {}) as JsonObject;
  if (!isObject(current)) {
    throw new ScimNoTargetError(`"${name}" holds no attributes.`);
  }
  return current;
}

function removeKey(object: JsonObject, name: string): void {
  const key = keyOf(object, name);
  if (key !== undefined) delete object[key];
}

/** What a value of a multi-valued attribute is known by: its `value`, else itself. */
function identityOf(item: unknown): unknown {
  const value = isObject(item) ? attributeOf(item, 'value') : undefined;
  return value ?? item;
}

/**
 * Whether `name` is read-only and named with the value it has, as directories send a resource's
 * own `id`: nothing to change. 400 `scim-mutability` for another value.
 */
function isReadOnly(
  resource: JsonObject,
  name: string,
  value: unknown,
): boolean {
  if (!READ_ONLY.has(name.toLowerCase())) return false;
  if (
    value !== undefined &&
    isDeepStrictEqual(attributeOf(resource, name), value)
  ) {
    return true;
  }
  throw new ScimMutabilityError(
    `"${name}" is set by the server, not by a patch.`,
  );
}
