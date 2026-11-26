import { isDeepStrictEqual } from 'node:util';
import { UserEmail, UserName } from '../../access/core/actor.js';
import { GroupName } from '../../access/core/group-mappings.js';
import {
  ScimInvalidSyntaxError,
  ScimInvalidValueError,
} from './scim-errors.js';
import {
  attributeOf,
  booleanOf,
  checkJson,
  ENTERPRISE_USER_SCHEMA,
  GROUP_SCHEMA,
  isObject,
  type JsonObject,
  MAX_KEYS,
  USER_SCHEMA,
} from './scim-json.js';
import {
  checkSpellings,
  isCoreUrn,
  resolveNames,
  withoutPasswords,
} from './scim-names.js';
import { withBudget } from './scim-work.js';

/** The longest `userName`, `externalId` or group name kept. */
export const MAX_NAME_LENGTH = 256;
/** The most bytes of a user's other attributes kept (their JSON). */
export const MAX_ATTRIBUTES_BYTES = 16 * 1024;
/** The most members one group may have. */
export const MAX_MEMBERS = 20_000;

/** A user as a directory sends it, checked (#377). */
export interface ScimUserInput {
  readonly userName: string;
  readonly externalId: string | null;
  /** Undefined when the request leaves it out (or null): as active as they are. */
  readonly active: boolean | undefined;
  /** Every other attribute it sent, kept as sent (`displayName`, `name`, `emails`, extensions …). */
  readonly attributes: JsonObject;
  /** The address they give (null for none); undefined when the request does not change it. */
  readonly email: string | null | undefined;
}

/** A group as a directory sends it, checked (#377). */
export interface ScimGroupInput {
  readonly displayName: string;
  readonly externalId: string | null;
  /** Its members' IDs (users' IDs), each once. */
  readonly memberIds: readonly string[];
}

/** Attributes the server sets, never kept from a request (and never a password). */
const NOT_KEPT = new Set([
  'id',
  'meta',
  'schemas',
  'password',
  'groups',
  'username',
  'externalid',
  'active',
]);

/**
 * Reads a User resource from a request (POST, PUT, or a patched resource): `userName` (required,
 * 1 to 256 characters), `externalId`, `active` (`"True"` and `"False"` as some directories send
 * them are read as the booleans), and every other attribute as sent, under its canonical name,
 * however it is spelled (`resolveNames`). A password is dropped, wherever it is: people sign in
 * with their own way in, never one a directory sets. 400 `scim-invalid-syntax` for no object, `scim-invalid-value` for a value out of
 * range.
 */
export function userInputOf(sent: unknown): ScimUserInput {
  return withBudget(() => {
    checkJson(sent);
    if (!isObject(sent)) {
      throw new ScimInvalidSyntaxError('The body is no User object.');
    }
    checkSpellings(sent);
    const body = resolveNames(sent);
    return inputFrom(body, () => emailOf(body));
  });
}

/**
 * Reads the User resource `patched`, made of the user's own `before` and what a PATCH changed
 * (`applyPatch`): what it left as it was is not judged again, so when it chooses no other address
 * that is no change (`email` undefined), whatever is stored.
 */
export function patchedUserInput(
  patched: JsonObject,
  before: JsonObject,
): ScimUserInput {
  return withBudget(() => {
    for (const [key, value] of Object.entries(patched)) {
      if (!isDeepStrictEqual(value, before[key])) checkJson(value);
    }
    const input = inputFrom(patched, () => {
      const same = (read: (resource: JsonObject) => unknown) =>
        isDeepStrictEqual(read(patched), read(before));
      return same((r) => attributeOf(r, 'emails')) ||
        (isObjects(attributeOf(patched, 'emails')) &&
          same(chosenAddress) &&
          same(primaryAddresses))
        ? undefined
        : emailOf(patched);
    });
    if (Object.keys(input.attributes).length > MAX_KEYS) {
      throw new ScimInvalidValueError(
        `A user has at most ${MAX_KEYS} attributes.`,
      );
    }
    return input;
  });
}

function inputFrom(
  resource: JsonObject,
  email: () => string | null | undefined,
): ScimUserInput {
  const body = withoutPasswords(resource) as JsonObject;
  const userName = attributeOf(body, 'userName');
  if (
    typeof userName !== 'string' ||
    userName.trim() === '' ||
    userName.length > MAX_NAME_LENGTH
  ) {
    throw new ScimInvalidValueError(
      `"userName" is required: a string of 1 to ${MAX_NAME_LENGTH} characters.`,
    );
  }
  const attributes: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (NOT_KEPT.has(key.toLowerCase()) || value === null) continue;
    attributes[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(attributes)) > MAX_ATTRIBUTES_BYTES) {
    throw new ScimInvalidValueError(
      `A user's attributes take at most ${MAX_ATTRIBUTES_BYTES} bytes.`,
    );
  }
  return {
    userName,
    externalId: externalIdOf(body),
    active: activeOf(attributeOf(body, 'active')),
    attributes,
    email: email(),
  };
}

function externalIdOf(body: JsonObject): string | null {
  const externalId = attributeOf(body, 'externalId');
  if (externalId === undefined || externalId === null) return null;
  if (
    typeof externalId !== 'string' ||
    externalId === '' ||
    externalId.length > MAX_NAME_LENGTH
  ) {
    throw new ScimInvalidValueError(
      `"externalId" is a string of 1 to ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return externalId;
}

function activeOf(active: unknown): boolean | undefined {
  if (active === undefined || active === null) return undefined;
  const value = booleanOf(active);
  if (value !== undefined) return value;
  throw new ScimInvalidValueError('"active" is true or false.');
}

/**
 * The name a user is shown by: `displayName`, else `name.formatted`, else its given and family
 * names, else `userName`; 1 to 200 characters (`UserName`), cut there.
 */
export function nameOf(input: ScimUserInput): string | undefined {
  const name = attributeOf(input.attributes, 'name');
  const parts = isObject(name)
    ? [attributeOf(name, 'givenName'), attributeOf(name, 'familyName')]
        .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
        .join(' ')
    : '';
  for (const candidate of [
    attributeOf(input.attributes, 'displayName'),
    isObject(name) ? attributeOf(name, 'formatted') : undefined,
    parts,
    input.userName,
  ]) {
    if (typeof candidate !== 'string') continue;
    const parsed = UserName.safeParse(candidate.slice(0, 200));
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * The email address `resource` gives a user: of `emails`, the primary one, else the first of type
 * `work`, else the first; null for none. An entry without a value is none. 400
 * `scim-invalid-value` for one that is no address, and for two primary ones that differ (RFC
 * 7643, section 2.4: at most one).
 */
function emailOf(resource: JsonObject): string | null {
  const emails = attributeOf(resource, 'emails') ?? [];
  if (!isObjects(emails)) {
    throw new ScimInvalidValueError('"emails" is a list of objects.');
  }
  if (primaryAddresses(resource).size > 1) {
    throw new ScimInvalidValueError('Two addresses in "emails" are primary.');
  }
  const address = chosenAddress(resource);
  if (address === undefined) return null;
  const parsed = UserEmail.safeParse(
    typeof address === 'string' ? address.trim() : address,
  );
  if (!parsed.success) {
    throw new ScimInvalidValueError(
      'An email address in "emails" is no address.',
    );
  }
  return parsed.data;
}

/** The address `resource` gives (`emailOf`), as it is kept: not checked; undefined for none. */
export function chosenAddress(resource: JsonObject): unknown {
  const given = addressesOf(resource);
  const chosen =
    given.find(isPrimary) ??
    given.find((e) => {
      const type = attributeOf(e, 'type');
      return typeof type === 'string' && type.toLowerCase() === 'work';
    }) ??
    given[0];
  return chosen && addressAt(chosen);
}

const addressAt = (email: JsonObject): unknown => {
  const value = attributeOf(email, 'value');
  return typeof value === 'string' && value.trim() === ''
    ? undefined
    : (value ?? undefined);
};

const isObjects = (value: unknown): value is JsonObject[] =>
  Array.isArray(value) && value.every(isObject);

function addressesOf(resource: JsonObject): JsonObject[] {
  const emails = attributeOf(resource, 'emails');
  return (Array.isArray(emails) ? emails : []).filter(
    (e): e is JsonObject => isObject(e) && addressAt(e) !== undefined,
  );
}

const primaryAddresses = (resource: JsonObject): Set<unknown> =>
  new Set(addressesOf(resource).filter(isPrimary).map(addressAt));

const isPrimary = (email: JsonObject): boolean =>
  booleanOf(attributeOf(email, 'primary')) === true;

/**
 * Reads a Group resource from a request: `displayName` (a group's name as the mappings match it,
 * `GroupName`), `externalId` and `members` (users by `value`, their ID; at most `MAX_MEMBERS`).
 * A group as a member is refused: groups do not nest here. 400 as for a user.
 */
export function groupInputOf(sent: unknown): ScimGroupInput {
  return withBudget(() => readGroup(sent));
}

function readGroup(sent: unknown): ScimGroupInput {
  checkJson(sent);
  if (!isObject(sent))
    throw new ScimInvalidSyntaxError('The body is no Group object.');
  checkSpellings(sent);
  const body = resolveNames(sent);
  const displayName = GroupName.safeParse(attributeOf(body, 'displayName'));
  if (!displayName.success) {
    throw new ScimInvalidValueError(
      `"displayName" is required: 1 to ${MAX_NAME_LENGTH} characters, no spaces at either end.`,
    );
  }
  const members = attributeOf(body, 'members') ?? [];
  if (!Array.isArray(members)) {
    throw new ScimInvalidValueError('"members" is a list.');
  }
  const ids = new Set<string>();
  for (const member of members) {
    const value = isObject(member) ? attributeOf(member, 'value') : undefined;
    if (typeof value !== 'string' || value === '') {
      throw new ScimInvalidValueError('Each member names its user by "value".');
    }
    const type = attributeOf(member as JsonObject, 'type');
    if (typeof type === 'string' && type.toLowerCase() === 'group') {
      throw new ScimInvalidValueError(
        'A group cannot be a member: groups do not nest.',
      );
    }
    ids.add(value);
  }
  if (ids.size > MAX_MEMBERS) {
    throw new ScimInvalidValueError(
      `A group has at most ${MAX_MEMBERS} members.`,
    );
  }
  return {
    displayName: displayName.data,
    externalId: externalIdOf(body),
    memberIds: [...ids],
  };
}

/** A provisioned user as kept, with what the access tables say about them. */
export interface ScimUser {
  readonly userId: string;
  readonly userName: string;
  readonly externalId: string | null;
  readonly attributes: JsonObject;
  /** When the user was deactivated (here or by an admin); null while active. */
  readonly deactivatedAt: Date | null;
  /** Made by the directory, or an existing user it linked by email (false). */
  readonly createdByScim: boolean;
  /** When the directory deactivated it; null when it did not (`ScimDirectory.markDeactivated`). */
  readonly scimDeactivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The SCIM groups it is in, by name. */
  readonly groups: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
}

/** A provisioned group as kept. */
export interface ScimGroup {
  readonly id: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Its members, by user ID, with the name each is shown by. */
  readonly members: readonly {
    readonly userId: string;
    readonly name: string;
  }[];
}

/**
 * A user as SCIM answers it, without `meta.location` (the API adds it). Attributes an earlier
 * version kept under a core schema's name, or with a password, are not answered (#938).
 */
export function userResource(user: ScimUser): JsonObject {
  const attributes = withoutPasswords(
    Object.fromEntries(
      Object.entries(user.attributes).filter(([key]) => !isCoreUrn(key)),
    ),
  ) as JsonObject;
  const extension = Object.keys(attributes).some(
    (key) => key.toLowerCase() === ENTERPRISE_USER_SCHEMA.toLowerCase(),
  );
  return {
    schemas: [USER_SCHEMA, ...(extension ? [ENTERPRISE_USER_SCHEMA] : [])],
    id: user.userId,
    ...(user.externalId !== null && { externalId: user.externalId }),
    userName: user.userName,
    ...attributes,
    active: user.deactivatedAt === null,
    groups: user.groups.map((g) => ({
      value: g.id,
      display: g.displayName,
      type: 'direct',
    })),
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
    },
  };
}

/** A group as SCIM answers it, without `meta.location`. */
export function groupResource(group: ScimGroup): JsonObject {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId !== null && { externalId: group.externalId }),
    displayName: group.displayName,
    members: group.members.map((m) => ({
      value: m.userId,
      display: m.name,
      type: 'User',
    })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
    },
  };
}
