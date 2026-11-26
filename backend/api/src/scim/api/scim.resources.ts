import { z } from 'zod';
import { ScimInvalidValueError } from '../core/scim-errors.js';
import { attrPathOf } from '../core/scim-filter.js';
import type { ScimListed } from '../core/scim-list.js';
import {
  attributeOf,
  isObject,
  type JsonObject,
  keyOf,
  LIST_RESPONSE_SCHEMA,
} from '../core/scim-json.js';
import { spend, withBudget } from '../core/scim-work.js';

/**
 * The SCIM resources as answered (#377): Zod schemas that document the routes in the OpenAPI
 * document and check the answers in the tests. Loose objects: a resource carries what the
 * directory sent, extensions included. All but `schemas` and `id` are optional, as `attributes`
 * and `excludedAttributes` may leave them out (`project`).
 */

const Meta = z.object({
  resourceType: z.string(),
  created: z.string().optional(),
  lastModified: z.string().optional(),
  location: z.string(),
});

export const ScimUserResource = z
  .looseObject({
    schemas: z.array(z.string()),
    id: z.string().describe('The user’s ID, as everywhere in the API.'),
    externalId: z.string().optional(),
    userName: z.string().optional(),
    active: z.boolean().optional(),
    groups: z
      .array(
        z.object({ value: z.string(), display: z.string(), type: z.string() }),
      )
      .optional(),
    meta: Meta.optional(),
  })
  .describe(
    'A provisioned user: what the directory sent (but a password), its `active` from whether it is deactivated, and the SCIM groups it is in.',
  );

export const ScimGroupResource = z
  .looseObject({
    schemas: z.array(z.string()),
    id: z.string().describe('A UUID.'),
    externalId: z.string().optional(),
    displayName: z.string().optional(),
    members: z
      .array(
        z.object({ value: z.string(), display: z.string(), type: z.string() }),
      )
      .optional(),
    meta: Meta.optional(),
  })
  .describe(
    'A provisioned group: its name, which group mappings match, and its members.',
  );

const listResponse = <T extends z.ZodType>(resource: T) =>
  z.object({
    schemas: z.array(z.literal(LIST_RESPONSE_SCHEMA)),
    totalResults: z.number().int(),
    startIndex: z.number().int(),
    itemsPerPage: z.number().int(),
    Resources: z.array(resource),
  });

export const ScimUserList = listResponse(ScimUserResource);
export const ScimGroupList = listResponse(ScimGroupResource);
export const ScimDiscoveryList = listResponse(z.looseObject({}));
export const ScimDiscoveryResource = z.looseObject({
  schemas: z.array(z.string()),
});

/** SCIM's error (RFC 7644, section 3.12), on every SCIM route. */
export const ScimErrorDocument = z
  .object({
    schemas: z.array(z.string()),
    status: z.string(),
    scimType: z.string().optional(),
    detail: z.string(),
  })
  .describe(
    'SCIM’s error: `status` as a string, `scimType` for the 400s and 409s the standard names.',
  );

/** A list response of `listed`, each item as `toResource` answers it. */
export function toListResponse<T>(
  listed: ScimListed<T>,
  toResource: (item: T) => JsonObject,
): z.infer<typeof ScimDiscoveryList> {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: listed.total,
    startIndex: listed.startIndex,
    itemsPerPage: listed.items.length,
    Resources: withBudget(() => listed.items.map(toResource)),
  };
}

/**
 * `resource` with only the attributes `attributes` names (`id` and `schemas` always), or without
 * those `excluded` names (RFC 7644, section 3.4.2.5): each a comma-separated list of attribute
 * paths (`userName`, `name.givenName`, `members`). 400 `scim-invalid-value` for a path that does
 * not parse.
 */
export const project = (
  resource: JsonObject,
  attributes: string | undefined,
  excluded: string | undefined,
): JsonObject => withBudget(() => select(resource, attributes, excluded));

function select(
  resource: JsonObject,
  attributes: string | undefined,
  excluded: string | undefined,
): JsonObject {
  if (attributes !== undefined && attributes.trim() !== '') {
    const kept: JsonObject = {
      schemas: resource['schemas'],
      id: resource['id'],
    };
    for (const path of pathsOf(attributes)) {
      const from = path.schema ? attributeOf(resource, path.schema) : resource;
      if (!isObject(from)) continue;
      const key = keyOf(from, path.attr);
      if (key === undefined) continue;
      const into = path.schema
        ? objectIn(kept, keyOf(resource, path.schema)!)
        : kept;
      if (path.sub === undefined) {
        into[key] = from[key];
      } else {
        into[key] = pick(from[key], path.sub, into[key]);
      }
    }
    return kept;
  }
  if (excluded !== undefined && excluded.trim() !== '') {
    const result = structuredClone(resource);
    for (const path of pathsOf(excluded)) {
      const from = path.schema ? attributeOf(result, path.schema) : result;
      if (!isObject(from)) continue;
      const key = keyOf(from, path.attr);
      if (
        key === undefined ||
        (!path.schema && (key === 'id' || key === 'schemas'))
      ) {
        continue;
      }
      if (path.sub === undefined) {
        delete from[key];
      } else {
        const items = [from[key]].flat();
        spend(items.length);
        for (const item of items) {
          if (isObject(item)) {
            const sub = keyOf(item, path.sub);
            if (sub !== undefined) delete item[sub];
          }
        }
      }
    }
    return result;
  }
  return resource;
}

function pathsOf(list: string) {
  try {
    return list
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map(attrPathOf);
  } catch {
    throw new ScimInvalidValueError(
      `"${list}" is no list of attribute paths.`,
      'attributes',
    );
  }
}

function objectIn(object: JsonObject, key: string): JsonObject {
  const current = object[key];
  if (isObject(current)) return current;
  return (object[key] = {}) as JsonObject;
}

/** The sub-attribute `sub` of `value` (an object, or each of a list), merged into `into`. */
function pick(value: unknown, sub: string, into: unknown): unknown {
  if (Array.isArray(value)) {
    spend(value.length);
    return value.map((item, i) =>
      pick(item, sub, Array.isArray(into) ? into[i] : undefined),
    );
  }
  if (!isObject(value)) return into;
  const key = keyOf(value, sub);
  const base = isObject(into) ? into : {};
  return key === undefined ? base : { ...base, [key]: value[key] };
}
