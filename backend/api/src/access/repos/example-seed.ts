import type { z } from 'zod';
import { PERMISSIONS } from '../core/permissions.js';
import type { Seed } from './seed.js';

/**
 * Example roles and users for local testing and demos: what
 * `pnpm nx run api:db-seed -- --example` writes. Replace it with your own
 * (`pnpm nx run api:db-seed -- <file.json>`, the same shape). The scope
 * values follow the content model's sample configuration; the sample
 * repository `setup-local` makes has no "safety" module type, so there the
 * restricted-type approver matches nothing. A value your configuration does
 * not know simply matches nothing.
 *
 * Every user here is fictional. Never seed these into a database people
 * sign in to: "sample-admin" holds every permission.
 */
export const exampleSeed: z.input<typeof Seed> = {
  roles: [
    {
      id: 'author',
      name: 'Author',
      permissions: ['content.read', 'content.read.draft', 'content.edit'],
      scope: {},
    },
    {
      // An occasional contributor (#137): suggests changes and uploads files
      // into their own change sets, which go through review. Without
      // `content.read.draft`, so they read released content and only their
      // own drafts; they cannot review, approve, sign off, merge or release.
      id: 'contributor',
      name: 'Contributor',
      permissions: ['content.read', 'content.edit'],
      scope: {},
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      permissions: ['content.read', 'content.read.draft', 'content.review'],
      scope: {},
    },
    {
      id: 'restricted-approver',
      name: 'Restricted-type approver',
      permissions: [
        'content.read',
        'content.read.draft',
        'content.review',
        'content.approve',
      ],
      scope: { moduleTypes: ['safety'] },
    },
    {
      id: 'translation-manager',
      name: 'Translation manager',
      permissions: ['content.read', 'content.read.draft', 'translation.manage'],
      scope: { languages: ['de', 'fr'] },
    },
    {
      // A scope covers all of a role's permissions, so reading the source
      // language a translation starts from is a role of its own.
      id: 'source-reader',
      name: 'Source reader',
      permissions: ['content.read', 'content.read.draft'],
      scope: { languages: ['en'] },
    },
    {
      id: 'publisher',
      name: 'Publisher',
      permissions: ['content.read', 'content.read.draft', 'release.publish'],
      scope: {},
    },
    {
      id: 'reader',
      name: 'Reader',
      permissions: ['content.read'],
      scope: { maxAudience: 'public' },
    },
    {
      id: 'admin',
      name: 'Admin',
      // Every permission there is, including ones added later.
      permissions: [...PERMISSIONS],
      scope: {},
    },
  ],
  users: [
    { id: 'sample-author', name: 'Sample Author', roles: ['author'] },
    {
      id: 'sample-contributor',
      name: 'Sample Contributor',
      roles: ['contributor'],
    },
    {
      id: 'sample-reviewer',
      name: 'Sample Reviewer',
      roles: ['author', 'reviewer'],
    },
    {
      id: 'sample-approver',
      name: 'Sample Approver',
      roles: ['reviewer', 'restricted-approver'],
    },
    {
      id: 'sample-translator',
      name: 'Sample Translation Manager',
      roles: ['translation-manager', 'source-reader'],
    },
    { id: 'sample-publisher', name: 'Sample Publisher', roles: ['publisher'] },
    { id: 'sample-reader', name: 'Sample Reader', roles: ['reader'] },
    { id: 'sample-admin', name: 'Sample Admin', roles: ['admin'] },
  ],
};
