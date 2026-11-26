/**
 * The API's components by role, as folders of `src/`. The lint rule of `eslint.config.mjs` reads
 * them (Node strips the types, so keep this file free of imports and of syntax that is more than
 * types), and so does the baseline migration (`database/baseline.ts`).
 *
 * The documentation domain's components. The platform (`PLATFORM_FOLDERS`) imports none of them:
 * a component registers its own permissions (`src/permissions.ts`), webhook events
 * (`src/webhook-events.ts`), audit actions (`src/audit-actions.ts`), notification kinds
 * (`src/notification-kinds.ts`) and settings (`src/settings.ts`), and the platform reads them
 * there.
 */
export const DOMAIN_COMPONENTS: readonly string[] = [
  'chunks',
  'checks',
  'dita',
  'downloads',
  'iirds',
  'imports',
  'manuals',
  'modules',
  'page-designs',
  'preview',
  'reports',
  'style-review',
  'terms',
  'translations',
  'variants',
];

/** The platform's components, which import no component of `DOMAIN_COMPONENTS`. */
export const PLATFORM_FOLDERS: readonly string[] = [
  'access',
  'audit',
  'config',
  'notifications',
  'outbox',
  'settings',
  'webhooks',
];
