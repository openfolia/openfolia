import type { INestApplication } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import type request from 'supertest';
import { JSON_API, REQUEST_HEADER } from '../src/base/api/json-api.js';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route the app serves, as `METHOD /path` with `:params` left in, sorted. */
export function routesOf(app: INestApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router: { stack: Layer[] };
  };
  return express.router.stack
    .flatMap(({ route }) =>
      route
        ? Object.keys(route.methods)
            .filter((m) => m !== '_all')
            .map((m) => `${m.toUpperCase()} ${route.path}`)
        : [],
    )
    .sort();
}

/**
 * Routes reachable without the token. Every other route must resolve an
 * actor (`access.e2e.spec.ts`, `demo.e2e.spec.ts`); a new public route is
 * added here.
 */
export const PUBLIC_ROUTES = [
  // The licence and where the source is (#370).
  'GET /about',
  // The branding and the images it uses: the shell shows them before sign-in (#169).
  'GET /branding',
  'GET /branding/images/:hash',
  'GET /health',
  'GET /health/ready',
  // Signing in (#37): nobody is acting yet; signing out ends the session the cookie names.
  'GET /auth/providers',
  'GET /auth/:provider/sign-in',
  'GET /auth/:provider/callback',
  'POST /auth/sign-out',
  // Password sign-in (#610): before anyone acts.
  'GET /auth/options',
  'POST /auth/password/sign-in',
  'POST /auth/password/forgot',
  'POST /auth/password/link',
  'POST /auth/password/set',
  // Sign-in by a code by email (#634): before anyone acts.
  'POST /auth/email-code/request',
  'POST /auth/email-code/sign-in',
  'POST /auth/email-code/link',
  // The API reference (Swagger UI and the document).
  'GET /docs',
  'GET /docs/',
  'GET /docs/LICENSE',
  'GET /docs/docs/swagger-ui-init.js',
  'GET /docs/index.html',
  'GET /docs/swagger-ui-init.js',
  'GET /openapi.json',
  'GET /openapi.yaml',
  // The delivery API's reference and document (#174), made the same way.
  'GET /docs/delivery',
  'GET /docs/delivery/',
  'GET /docs/delivery/LICENSE',
  'GET /docs/delivery/delivery/swagger-ui-init.js',
  'GET /docs/delivery/index.html',
  'GET /docs/delivery/swagger-ui-init.js',
  'GET /openapi/delivery.json',
  'GET /openapi/delivery.yaml',
];

/**
 * Guarded routes whose action needs no permission, only an actor
 * (`any-actor`). Every other guarded route refuses an actor without the
 * permission it documents (`x-required-permission`; `access.e2e.spec.ts`); a
 * new route open to any actor is added here.
 */
export const ANY_ACTOR_ROUTES = [
  'GET /me',
  'POST /me/password',
  'GET /demo/users',
  // Authors always see their own change sets and locks (#126); what an
  // actor without `content.read.draft` gets is only their own.
  'GET /change-sets',
  'GET /change-sets/:changeSetId',
  'GET /locks',
  'GET /locks/:lockId',
  // Everyone's own inbox (#252): only their own notifications.
  'GET /me/notifications',
  'GET /me/notifications/unread-count',
  'GET /me/notifications/:notificationId',
  'POST /me/notifications/read',
  // Everyone's own preferences (#222): only their own.
  'GET /me/preferences',
  'PATCH /me/preferences',
  // The preview pages' stylesheets and fonts: the same bytes for everyone, no content.
  'GET /preview/:name',
  'GET /preview/fonts/:name',
  // The same for the stable address pages (#450), for whoever may open an address.
  'GET /d/-/:name',
  'GET /d/-/fonts/:name',
];

/**
 * Guarded routes whose documented permission comes on top of reading
 * content (`content.read`, which opening a ref needs): a holder of only
 * the documented permission cannot read, so the walk in
 * `access.e2e.spec.ts` gives a holder of both. A new route of that kind is
 * added here.
 */
export const ON_TOP_OF_READING = [
  // Cutting a release reads `openfolia.yaml` at `main`; withdrawing one reads
  // it at the release's commit.
  'POST /releases',
  'POST /releases/:releaseId/withdraw',
  // Retrying an output reads `openfolia.yaml` at the release's commit.
  'POST /releases/:releaseId/outputs/:outputId/retry',
  'POST /releases/:releaseId/outputs/plan',
  // Starting or closing a maintenance line reads `openfolia.yaml` at the
  // release's tag, for the publish scope over its product (#60).
  'POST /maintenance-lines',
  'POST /maintenance-lines/:maintenanceLineId/close',
  'GET /translations/status',
  'GET /translations/status/:lang/:moduleId',
  'GET /translations/status/:lang/config/project',
  'GET /translations/status/:lang/designs/:designId',
  'GET /translations/status/:lang/manuals/:manualId',
  // The reports read the content at their ref (#56).
  'GET /reports/translations',
  'GET /reports/translations/csv',
  'GET /reports/module-usage',
  'GET /reports/module-usage/csv',
  // An export reads the modules at its ref; a job's file at its commit.
  'POST /translations/exports',
  'GET /translations/exports/:jobId/file',
  'GET /translations/exports/:jobId/package',
  // Reads the module as its working copy is read.
  'POST /change-sets/:changeSetId/modules/:lang/:moduleId/style-review',
];

/**
 * Guarded routes whose documented permission also needs `content.read.draft`
 * (the action checks it): the walk in `access.e2e.spec.ts` gives a holder of
 * both. Deleting an unused file decides about other people's draft uploads
 * too (#137).
 */
export const ON_TOP_OF_DRAFT_READING = ['DELETE /assets/:hash'];

/**
 * Guarded routes whose documented permission (`admin.roles`) comes on top
 * of editing content (`content.edit`, and `content.read` to read the
 * target): an import is written as its uploader's edit (#256). The walk
 * in `access.e2e.spec.ts` gives a holder of all three.
 */
export const ON_TOP_OF_EDITING = [
  'POST /imports',
  'POST /imports/:importId/apply',
  // Marking a translation current commits into a change set (#51).
  'POST /translations/mark-current',
];

/**
 * Any-actor routes that exist only in demo mode (`CCMS_AUTH_MODE=demo`):
 * 404 `not-found` in the default token mode these tests run in.
 */
export const DEMO_ONLY_ROUTES = ['GET /demo/users'];

/**
 * Answers besides 200, 201 and 404 that say a route's action ran for the
 * holder of its permission: no backup service runs in these tests, so a
 * request for one is refused by the action (409), past the permission.
 */
export const ACTION_ANSWERS: Record<string, readonly number[]> = {
  'POST /backup-requests': [409],
  // The route walk names no role there is.
  'POST /group-mappings': [422],
  // Password sign-in is off in the test app (#610).
  'POST /me/password': [409],
  'POST /users/:userId/invite': [409],
  'POST /users/:userId/password-reset': [409],
};

/** The OpenAPI path of an Express route: `/a/:b` is `/a/{b}`. */
export const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

/** A request path for a route, with a placeholder for each parameter. */
export const fill = (path: string) => path.replace(/:\w+/g, 'x');

/** Well-formed values for each route parameter, naming nothing in particular. */
const VALID_PARAMETERS: Record<string, string> = {
  lang: 'en',
  id: 'nope',
  variant: 'model=large',
  hash: '0'.repeat(64),
  changeSetId: '00000000-0000-7000-8000-000000000000',
  lockId: '00000000-0000-7000-8000-000000000000',
  commentId: '00000000-0000-7000-8000-000000000000',
  notificationId: '1',
  releaseId: '00000000-0000-7000-8000-000000000000',
  outputId: '00000000-0000-7000-8000-000000000000',
  packageId: '00000000-0000-7000-8000-000000000000',
  maintenanceLineId: '00000000-0000-7000-8000-000000000000',
  importId: '00000000-0000-7000-8000-000000000000',
  jobId: '00000000-0000-7000-8000-000000000000',
  moduleId: 'nope',
  manualId: 'nope',
  termId: 'nope',
  designId: 'nope',
  templateId: 'nope',
  roleId: 'nope',
  mappingId: '00000000-0000-4000-8000-000000000000',
  userId: 'nope',
  serviceAccountId: 'nope',
  attributeId: 'model',
  tokenId: '0000000000000000',
  webhookId: '00000000-0000-7000-8000-000000000000',
  deliveryId: '00000000-0000-7000-8000-000000000000',
  requestId: '00000000-0000-4000-8000-000000000000',
  page: '1',
  product: 'north',
  manual: 'nope',
  name: 'nope',
};

/**
 * A request path for a route whose parameters pass validation, so the
 * request reaches the action. A new parameter is added above.
 */
export const fillValid = (path: string) =>
  path.replace(/:(\w+)/g, (_, name: string) => {
    const value = VALID_PARAMETERS[name];
    if (value === undefined) throw new Error(`no valid value for :${name}`);
    return value;
  });

/** Query strings that pass validation, for each route that requires one. */
export const VALID_QUERIES: Record<string, string> = {
  'GET /search': 'filter[q]=route',
  'GET /variants/matches': 'when=model%20in%20(large)',
  'GET /modules/:lang/:id/compare': 'base=main&head=main',
  'GET /manuals/:id/compare': 'base=main&head=main',
  'GET /terms/export': 'format=csv',
  'GET /audit-events/export': 'format=csv',
  'GET /page-design-templates/:templateId/file': 'path=manual.typ',
  'GET /change-sets/:changeSetId/page-design-templates/:templateId/files/working-copy':
    'path=manual.typ',
  'PUT /change-sets/:changeSetId/page-design-templates/:templateId/files/working-copy':
    'path=manual.typ',
  'DELETE /change-sets/:changeSetId/page-design-templates/:templateId/files/working-copy':
    'path=manual.typ',
};

/**
 * Request bodies that pass validation, for each route that takes one, so a
 * request reaches the action. A new route with a body is added here.
 */
export const VALID_BODIES: Record<string, unknown> = {
  'PATCH /backup-settings': {
    data: {
      type: 'BackupSettings',
      id: 'instance',
      attributes: { retention: { daily: 7, weekly: 4, monthly: 12 } },
    },
  },
  'POST /backup-requests': {
    data: { type: 'BackupRequest', attributes: { kind: 'test-location' } },
  },
  'PATCH /branding': {
    data: { type: 'Branding', attributes: { productName: 'Route walk' } },
  },
  'POST /mail/test': { data: { type: 'MailTest' } },
  // The rule as it is by default: the route walk changes nothing other tests see.
  'PATCH /settings': {
    data: {
      type: 'InstallationSettings',
      attributes: { selfApproval: 'never' },
    },
  },
  'POST /change-sets': {
    data: { type: 'ChangeSet', attributes: { title: 'Route walk' } },
  },
  'POST /change-sets/:changeSetId/locks': {
    data: {
      type: 'Lock',
      attributes: { subject: { type: 'manual', manualId: 'route-walk' } },
    },
  },
  'POST /change-sets/:changeSetId/comments': {
    data: {
      type: 'Comment',
      attributes: {
        body: 'Route walk.',
        subject: { type: 'module', lang: 'en', moduleId: 'nope' },
        blockId: 'nope',
      },
    },
  },
  'PATCH /change-sets/:changeSetId/comments/:commentId': {
    data: {
      type: 'Comment',
      id: '00000000-0000-7000-8000-000000000000',
      attributes: { body: 'Route walk.' },
    },
  },
  'POST /locks/break': {
    meta: {
      comment: 'Route walk.',
      changeSet: '00000000-0000-7000-8000-000000000000',
    },
  },
  'POST /locks/:lockId/break': { meta: { comment: 'Route walk.' } },
  'POST /me/notifications/read': { meta: { all: true } },
  // Changes nothing: the route walk's actors need no stored preferences.
  'PATCH /me/preferences': { data: { type: 'Preferences', attributes: {} } },
  'POST /me/password': {
    data: {
      type: 'PasswordChange',
      attributes: {
        currentPassword: 'route walk current',
        newPassword: 'route walk new password',
      },
    },
  },
  'POST /releases': {
    data: {
      type: 'Release',
      attributes: { product: 'north', revision: 'route-walk' },
    },
  },
  'POST /releases/:releaseId/withdraw': { meta: { reason: 'Route walk.' } },
  'POST /maintenance-lines': {
    data: {
      type: 'MaintenanceLine',
      relationships: {
        baseRelease: {
          data: { type: 'Release', id: '00000000-0000-7000-8000-000000000000' },
        },
      },
    },
  },
  'POST /translations/exports': {
    data: {
      type: 'TranslationJob',
      attributes: {
        languages: ['de'],
        subject: { type: 'manual', manualId: 'operating' },
      },
    },
    meta: { dryRun: true },
  },
  'POST /roles': {
    data: {
      type: 'Role',
      id: 'route-walk',
      attributes: { name: 'Route walk', permissions: ['content.read'] },
    },
  },
  'POST /group-mappings': {
    data: {
      type: 'GroupMapping',
      attributes: { group: 'route-walk' },
      relationships: { role: { data: { type: 'Role', id: 'nope' } } },
    },
  },
  'PATCH /roles/:roleId': {
    data: { type: 'Role', id: 'nope', attributes: { name: 'Route walk' } },
  },
  'POST /users': {
    data: {
      type: 'User',
      id: 'route-walk',
      attributes: { name: 'Route walk', email: 'route-walk@example.org' },
    },
  },
  'PATCH /users/:userId': {
    data: { type: 'User', id: 'nope', attributes: { name: 'Route walk' } },
  },
  'POST /users/:userId/relationships/roles': {
    data: [{ type: 'Role', id: 'route-walk' }],
  },
  'DELETE /users/:userId/relationships/roles': {
    data: [{ type: 'Role', id: 'route-walk' }],
  },
  'POST /service-accounts': {
    data: {
      type: 'ServiceAccount',
      id: 'route-walk',
      attributes: { name: 'Route walk' },
    },
  },
  'PATCH /service-accounts/:serviceAccountId': {
    data: {
      type: 'ServiceAccount',
      id: 'nope',
      attributes: { name: 'Route walk' },
    },
  },
  'POST /service-accounts/:serviceAccountId/relationships/roles': {
    data: [{ type: 'Role', id: 'route-walk' }],
  },
  'DELETE /service-accounts/:serviceAccountId/relationships/roles': {
    data: [{ type: 'Role', id: 'route-walk' }],
  },
  'POST /service-accounts/:serviceAccountId/tokens': {
    data: { type: 'ServiceToken', attributes: { name: 'Route walk' } },
  },
  'POST /webhooks': {
    data: {
      type: 'Webhook',
      attributes: {
        url: 'https://receiver.example/route-walk',
        events: ['manual.released'],
      },
    },
  },
  'PATCH /webhooks/:webhookId': {
    data: {
      type: 'Webhook',
      id: '00000000-0000-7000-8000-000000000000',
      attributes: { description: 'Route walk' },
    },
  },
  'PATCH /change-sets/:changeSetId': {
    data: {
      type: 'ChangeSet',
      id: '00000000-0000-7000-8000-000000000000',
      attributes: { title: 'Route walk' },
    },
  },
  'POST /change-sets/:changeSetId/reverts': {
    data: {
      type: 'Revert',
      attributes: { subjects: [{ type: 'manual', manualId: 'route-walk' }] },
    },
  },
  'POST /change-sets/:changeSetId/module-renames': {
    data: {
      type: 'ModuleRename',
      attributes: { from: 'route-walk', to: 'route-walked' },
    },
  },
  'POST /translations/mark-current': {
    data: {
      type: 'TranslationMarkCurrent',
      attributes: { changeSetId: 'nope', moduleId: 'route-walk', lang: 'de' },
    },
  },
  'POST /change-sets/:changeSetId/commits': {
    data: { type: 'Commit', attributes: { message: 'Route walk.' } },
  },
  'PUT /change-sets/:changeSetId/modules/:lang/:moduleId/working-copy': {
    data: {
      type: 'WorkingCopy',
      attributes: {
        content: {
          schemaVersion: 1,
          id: 'nope',
          meta: { title: 'Route walk', type: 'concept', lang: 'en' },
          blocks: [],
        },
      },
    },
    meta: { version: 0, baseCommit: '0'.repeat(40) },
  },
  'PUT /change-sets/:changeSetId/manuals/:manualId/working-copy': {
    data: {
      type: 'WorkingCopy',
      attributes: {
        content: {
          schemaVersion: 1,
          id: 'nope',
          title: 'Route walk',
          variants: [{}],
          entries: [],
        },
      },
    },
    meta: { version: 0, baseCommit: '0'.repeat(40) },
  },
  'PUT /change-sets/:changeSetId/config/working-copy': {
    data: {
      type: 'WorkingCopy',
      attributes: {
        content: {
          languages: { source: 'en', targets: [] },
          moduleTypes: [{ id: 'concept', label: 'Concept' }],
          audiences: [{ id: 'public', label: 'Public' }],
        },
      },
    },
    meta: { version: 0, baseCommit: '0'.repeat(40) },
  },
  'PUT /change-sets/:changeSetId/terms/:termId/working-copy': {
    data: {
      type: 'WorkingCopy',
      attributes: {
        content: {
          schemaVersion: 1,
          id: 'nope',
          languages: { en: { preferred: 'route walk' } },
        },
      },
    },
    meta: { version: 0, baseCommit: '0'.repeat(40) },
  },
  'PUT /change-sets/:changeSetId/page-designs/:designId/working-copy': {
    data: {
      type: 'WorkingCopy',
      attributes: {
        content: {
          schemaVersion: 1,
          id: 'nope',
          name: 'Route walk',
          preset: 'minimal',
          colours: { primary: '#111111', accent: '#222222', text: '#333333' },
        },
      },
    },
    meta: { version: 0, baseCommit: '0'.repeat(40) },
  },
  'PUT /change-sets/:changeSetId/page-design-templates/:templateId/files/working-copy':
    {
      data: {
        type: 'WorkingCopy',
        attributes: { content: { schemaVersion: 1, text: '// route walk\n' } },
      },
      meta: { version: 0, baseCommit: '0'.repeat(40) },
    },
};

/** The smallest import bundle: no modules, as a ZIP. */
export const EMPTY_BUNDLE = Buffer.from(
  zipSync({
    'import.json': strToU8(JSON.stringify({ formatVersion: 1, modules: [] })),
  }),
);

/** An XLIFF document of a translation job there is none of: read, then not found. */
export const ROUTE_WALK_XLIFF = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" xmlns:ccms="urn:ccms:xliff:1.0" version="2.0" srcLang="en" trgLang="de" ccms:job="0190e3c0-0000-7000-8000-000000000000">' +
    '<file id="route-walk"><unit id="b1"><segment><source>A</source><target>B</target></segment></unit></file></xliff>',
  'utf8',
);

/** A 1 × 1 PNG: the smallest image an upload takes. */
export const ROUTE_WALK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Routes that take a `multipart/form-data` body, with the fields of a
 * valid one (and the file `bundle.zip`), so a request reaches the action.
 */
export const MULTIPART_BODIES: Record<
  string,
  { fields: Record<string, string>; file: Buffer }
> = {
  'POST /imports': { fields: { dryRun: 'true' }, file: EMPTY_BUNDLE },
  'POST /branding/images': { fields: {}, file: ROUTE_WALK_PNG },
  'POST /translations/imports': {
    fields: { dryRun: 'true' },
    file: ROUTE_WALK_XLIFF,
  },
};

/**
 * A request for `route` (`METHOD /path`) to `path` on `agent`, with the
 * route's valid body (as JSON:API, or a form for `MULTIPART_BODIES`) when
 * it takes one. A state-changing request without one still says JSON:API
 * (`CrossSiteRequestGuard`).
 */
export function send(
  agent: ReturnType<typeof request>,
  route: string,
  path: string,
): request.Test {
  const method = (route.split(' ')[0] ?? '').toLowerCase() as 'get';
  const query = VALID_QUERIES[route];
  const req = agent[method](query === undefined ? path : `${path}?${query}`);
  const form = MULTIPART_BODIES[route];
  if (form !== undefined) {
    let multipart = req.set(REQUEST_HEADER, 'route-walk');
    for (const [name, value] of Object.entries(form.fields)) {
      multipart = multipart.field(name, value);
    }
    return multipart.attach('file', form.file, 'bundle.zip');
  }
  const body = VALID_BODIES[route];
  if (body !== undefined) {
    return req.set('Content-Type', JSON_API).send(JSON.stringify(body));
  }
  return method === 'get' ? req : req.set('Content-Type', JSON_API);
}
