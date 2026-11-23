import { ConfigKey, LanguageTag } from '@openfolia/content-model';
import { z } from 'zod';
import { Permission } from './permissions.js';

/** A role's ID: a lowercase key, like the configuration's (e.g. "author"). */
export const RoleId = ConfigKey;
export type RoleId = z.infer<typeof RoleId>;

/** A user's ID: lowercase letters, digits, ".", "_" and "-" (e.g. "sample-author"). */
export const UserId = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'lowercase letters, digits, ".", "_" and "-", e.g. "sample-author"',
  );
export type UserId = z.infer<typeof UserId>;

/** A person's name as shown: 1 to 200 characters, trimmed. */
export const UserName = z.string().trim().min(1).max(200);

/**
 * A user's email address: at most 254 characters, one "@" and no spaces
 * (the database checks the same, loosely). Unique ignoring case.
 */
export const UserEmail = z.email().max(254);

/** A list a scope restricts to: at least one value, each once. */
const values = <T extends z.ZodType<string>>(value: T) =>
  z
    .array(value)
    .min(1)
    .refine((items) => new Set(items).size === items.length, 'duplicate value');

/**
 * Where a role's permissions apply. Every dimension is optional: missing
 * means all of it. The values are the content configuration's IDs
 * (`openfolia.yaml`): languages, module types, audience levels and facets (e.g.
 * product lines or regions, whatever the configuration classifies by).
 * A value the configuration does not know matches nothing.
 */
export const Scope = z.strictObject({
  /** Languages (BCP 47, canonical case), e.g. ["de", "fr"]. */
  languages: values(LanguageTag).optional(),
  /** Module types, e.g. ["safety"]. */
  moduleTypes: values(ConfigKey).optional(),
  /** The most restricted audience level covered; every level before it is covered too. */
  maxAudience: ConfigKey.optional(),
  /** Per facet, the values covered, e.g. { "product-line": ["tuggers"] }. */
  facets: z
    // A "__proto__" key would otherwise be dropped silently, widening the scope.
    .custom<Record<string, string[]>>(
      (v) =>
        typeof v !== 'object' || v === null || !Object.hasOwn(v, '__proto__'),
      '"__proto__" is not a facet',
    )
    .pipe(z.record(ConfigKey, values(ConfigKey)))
    .refine(
      (facets) => Object.keys(facets).length > 0,
      'at least one facet (leave it out for all)',
    )
    .optional(),
});
export type Scope = z.infer<typeof Scope>;

/** A named set of permissions with the scope they apply in. */
export const Role = z.strictObject({
  id: RoleId,
  name: z.string().trim().min(1).max(200),
  permissions: values(Permission),
  scope: Scope,
});
export type Role = z.infer<typeof Role>;

/**
 * Who is acting: a person or a service, with its roles. Each role's
 * permissions apply only within that role's own scope; roles never combine
 * into a wider grant.
 */
export interface Actor {
  readonly kind: 'user' | 'service';
  readonly id: string;
  readonly roles: readonly Role[];
}
