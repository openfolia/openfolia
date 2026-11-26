import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

interface Operation {
  operationId: string;
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  responses: Record<string, unknown>;
}
interface Document {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

describe('OpenAPI document', () => {
  let doc: Document;
  beforeAll(async () => {
    const res = await t.anonymous().get('/openapi.json');
    expect(res.status).toBe(200);
    doc = res.body as Document;
  });

  it('documents every route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/about',
      '/assets',
      '/assets/{hash}',
      '/audit-events',
      '/audit-events/export',
      '/auth/email-code/link',
      '/auth/email-code/request',
      '/auth/email-code/sign-in',
      '/auth/options',
      '/auth/password/forgot',
      '/auth/password/link',
      '/auth/password/set',
      '/auth/password/sign-in',
      '/auth/providers',
      '/auth/second-factor',
      '/auth/second-factor/confirm',
      '/auth/second-factor/set-up',
      '/auth/second-factor/verify',
      '/auth/sign-out',
      '/auth/{provider}/callback',
      '/auth/{provider}/metadata',
      '/auth/{provider}/sign-in',
      '/backup-keys',
      '/backup-requests',
      '/backup-requests/{requestId}',
      '/backup-runs',
      '/backup-settings',
      '/backup-status',
      '/branding',
      '/branding/images',
      '/branding/images/{hash}',
      '/change-sets',
      '/change-sets/{changeSetId}',
      '/change-sets/{changeSetId}/abandon',
      '/change-sets/{changeSetId}/approve',
      '/change-sets/{changeSetId}/assets',
      '/change-sets/{changeSetId}/assets/{hash}',
      '/change-sets/{changeSetId}/carry-forward',
      '/change-sets/{changeSetId}/changes',
      '/change-sets/{changeSetId}/checks',
      '/change-sets/{changeSetId}/comments',
      '/change-sets/{changeSetId}/comments/{commentId}',
      '/change-sets/{changeSetId}/comments/{commentId}/reopen',
      '/change-sets/{changeSetId}/comments/{commentId}/resolve',
      '/change-sets/{changeSetId}/commits',
      '/change-sets/{changeSetId}/config/working-copy',
      '/change-sets/{changeSetId}/locks',
      '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
      '/change-sets/{changeSetId}/merge',
      '/change-sets/{changeSetId}/module-references/{moduleId}',
      '/change-sets/{changeSetId}/module-renames',
      '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/style-review',
      '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
      '/change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy',
      '/change-sets/{changeSetId}/page-designs/{designId}/working-copy',
      '/change-sets/{changeSetId}/rebase',
      '/change-sets/{changeSetId}/refresh',
      '/change-sets/{changeSetId}/refresh-conflicts',
      '/change-sets/{changeSetId}/return',
      '/change-sets/{changeSetId}/reverts',
      '/change-sets/{changeSetId}/review',
      '/change-sets/{changeSetId}/sign-off',
      '/change-sets/{changeSetId}/submit',
      '/change-sets/{changeSetId}/terms/{termId}/working-copy',
      '/changelog',
      '/changes',
      '/chunks',
      '/config',
      '/config/usages',
      '/d/-/fonts/{name}',
      '/d/-/{name}',
      '/d/{product}/{manual}/{variant}/{lang}',
      '/d/{product}/{manual}/{variant}/{lang}/assets/{hash}',
      '/d/{product}/{manual}/{variant}/{lang}/pdf',
      '/d/{product}/{manual}/{variant}/{lang}/pdf/qr.png',
      '/d/{product}/{manual}/{variant}/{lang}/pdf/qr.svg',
      '/d/{product}/{manual}/{variant}/{lang}/qr.png',
      '/d/{product}/{manual}/{variant}/{lang}/qr.svg',
      '/d/{product}/{manual}/{variant}/{lang}/symbols/{id}',
      '/demo/users',
      '/downloads',
      '/downloads/{id}/versions',
      '/downloads/{id}/versions/{releaseId}/file',
      '/group-mappings',
      '/group-mappings/{mappingId}',
      '/health',
      '/health/ready',
      '/importers',
      '/imports',
      '/imports/{importId}',
      '/imports/{importId}/apply',
      '/jobs/status',
      '/locks',
      '/locks/break',
      '/locks/{lockId}',
      '/locks/{lockId}/break',
      '/mail',
      '/mail/test',
      '/maintenance-lines',
      '/maintenance-lines/{maintenanceLineId}',
      '/maintenance-lines/{maintenanceLineId}/close',
      '/maintenance-lines/{maintenanceLineId}/releases',
      '/manuals',
      '/manuals/{id}',
      '/manuals/{id}/checks',
      '/manuals/{id}/compare',
      '/manuals/{id}/history',
      '/manuals/{id}/update-guide/{lang}',
      '/manuals/{id}/update-guide/{lang}/steps',
      '/manuals/{id}/variants/{variant}/{lang}',
      '/manuals/{id}/variants/{variant}/{lang}/hidden-content',
      '/manuals/{id}/variants/{variant}/{lang}/html',
      '/manuals/{id}/variants/{variant}/{lang}/pdf',
      '/manuals/{id}/variants/{variant}/{lang}/pdf/layout-warnings',
      '/manuals/{id}/variants/{variant}/{lang}/pdf/pages/{page}.png',
      '/me',
      '/me/notifications',
      '/me/notifications/read',
      '/me/notifications/unread-count',
      '/me/notifications/{notificationId}',
      '/me/password',
      '/me/preferences',
      '/me/second-factor',
      '/me/second-factor/confirm',
      '/me/second-factor/recovery-codes',
      '/me/second-factor/set-up',
      '/me/second-factor/turn-off',
      '/module-summaries',
      '/modules',
      '/modules/{lang}/{id}',
      '/modules/{lang}/{id}/compare',
      '/modules/{lang}/{id}/hidden-content',
      '/modules/{lang}/{id}/history',
      '/modules/{lang}/{id}/preview',
      '/notifications/unsubscribe/{token}',
      '/outbox/status',
      '/page-design-template-example/files',
      '/page-design-templates',
      '/page-design-templates/{templateId}/file',
      '/page-design-templates/{templateId}/files',
      '/page-design-templates/{templateId}/preview/pages/{page}.png',
      '/page-designs',
      '/page-designs/{designId}',
      '/preview/fonts/{name}',
      '/preview/{name}',
      '/refs',
      '/releases',
      '/releases/{releaseId}',
      '/releases/{releaseId}/changes',
      '/releases/{releaseId}/dita-packages',
      '/releases/{releaseId}/dita-packages/{packageId}',
      '/releases/{releaseId}/dita-packages/{packageId}/file',
      '/releases/{releaseId}/iirds-packages',
      '/releases/{releaseId}/iirds-packages/{packageId}',
      '/releases/{releaseId}/iirds-packages/{packageId}/file',
      '/releases/{releaseId}/outputs',
      '/releases/{releaseId}/outputs/archive',
      '/releases/{releaseId}/outputs/plan',
      '/releases/{releaseId}/outputs/{outputId}/file',
      '/releases/{releaseId}/outputs/{outputId}/retry',
      '/releases/{releaseId}/withdraw',
      '/reports/module-usage',
      '/reports/module-usage/csv',
      '/reports/translations',
      '/reports/translations/csv',
      '/roles',
      '/roles/{roleId}',
      '/sandbox',
      '/scim/v2/Groups',
      '/scim/v2/Groups/{groupId}',
      '/scim/v2/ResourceTypes',
      '/scim/v2/ResourceTypes/{resourceTypeId}',
      '/scim/v2/Schemas',
      '/scim/v2/Schemas/{schemaId}',
      '/scim/v2/ServiceProviderConfig',
      '/scim/v2/Users',
      '/scim/v2/Users/{userId}',
      '/search',
      '/secret-key',
      '/service-accounts',
      '/service-accounts/{serviceAccountId}',
      '/service-accounts/{serviceAccountId}/deactivate',
      '/service-accounts/{serviceAccountId}/reactivate',
      '/service-accounts/{serviceAccountId}/relationships/roles',
      '/service-accounts/{serviceAccountId}/tokens',
      '/service-accounts/{serviceAccountId}/tokens/{tokenId}/revoke',
      '/settings',
      '/stable-addresses',
      '/storage-usage',
      '/storage-usage/files',
      '/style-review',
      '/symbols/{id}',
      '/terms',
      '/terms/export',
      '/terms/{termId}',
      '/translations/exports',
      '/translations/exports/{jobId}',
      '/translations/exports/{jobId}/cancel',
      '/translations/exports/{jobId}/file',
      '/translations/exports/{jobId}/package',
      '/translations/imports',
      '/translations/imports/{importId}',
      '/translations/imports/{importId}/apply',
      '/translations/mark-current',
      '/translations/status',
      '/translations/status/{lang}/config/project',
      '/translations/status/{lang}/designs/{designId}',
      '/translations/status/{lang}/manuals/{manualId}',
      '/translations/status/{lang}/{moduleId}',
      '/users',
      '/users/{userId}',
      '/users/{userId}/deactivate',
      '/users/{userId}/invite',
      '/users/{userId}/password-reset',
      '/users/{userId}/reactivate',
      '/users/{userId}/relationships/roles',
      '/users/{userId}/second-factor',
      '/variants',
      '/variants/matches',
      '/variants/{attributeId}/usages',
      '/webhooks',
      '/webhooks/{webhookId}',
      '/webhooks/{webhookId}/deliveries',
      '/webhooks/{webhookId}/deliveries/{deliveryId}/retry',
      '/webhooks/{webhookId}/secret',
      '/webhooks/{webhookId}/test',
    ]);
    expect(doc.openapi).toMatch(/^3\./);
  });

  it('names the content model schemas instead of inlining them', () => {
    for (const name of [
      'Block',
      'Inline',
      'Condition',
      'ManifestEntry',
      'ProjectConfig',
      'ResolvedEntry',
      'ModuleResource',
      'ManualResource',
      'ResolvedManualResource',
      'PageMeta',
      'AuditEventResource',
      'ChangeSetResource',
      'CreateChangeSetDocument',
      'LockResource',
      'LockSubject',
      'AcquireLockDocument',
      'BreakLockDocument',
      'ErrorDocument',
      'ActorResource',
      'UserResource',
      'Role',
      'Scope',
    ]) {
      expect(doc.components.schemas).toHaveProperty(name);
    }
    expect(JSON.stringify(doc)).not.toContain('__schema');
  });

  it('marks the health check and /about public and every other route token-protected', () => {
    // The branding and its images: the shell shows them before sign-in (#169).
    const PUBLIC_OPERATIONS = [
      'get /branding',
      'get /branding/images/{hash}',
      // Signing in and out (#37): nobody is acting yet, or the session cookie decides.
      'get /auth/providers',
      'get /auth/{provider}/sign-in',
      'get /auth/{provider}/callback',
      // SAML (#376): the identity provider's posted answer, and this server's metadata.
      'post /auth/{provider}/callback',
      'get /auth/{provider}/metadata',
      'post /auth/sign-out',
      // Password sign-in (#610): before anyone acts.
      'get /auth/options',
      'post /auth/password/sign-in',
      'post /auth/password/forgot',
      'post /auth/password/link',
      'post /auth/password/set',
      // Sign-in by a code by email (#634): before anyone acts.
      'post /auth/email-code/request',
      'post /auth/email-code/sign-in',
      'post /auth/email-code/link',
      // The second step of a sign-in (#611): no session yet, only its cookie.
      'get /auth/second-factor',
      'post /auth/second-factor/verify',
      'post /auth/second-factor/set-up',
      'post /auth/second-factor/confirm',
      // The one-click unsubscribe (#884): the sealed token in the path is the authority.
      'post /notifications/unsubscribe/{token}',
    ];
    for (const [path, methods] of Object.entries(doc.paths)) {
      expect(Object.keys(methods).length).toBeGreaterThan(0);
      for (const [method, op] of Object.entries(methods)) {
        if (
          path === '/about' ||
          path === '/health' ||
          path === '/health/ready' ||
          PUBLIC_OPERATIONS.includes(`${method} ${path}`)
        ) {
          expect(op?.security).toEqual([]);
          // A wrong password is 401 `invalid-credentials` (#610), not a missing token.
          if (
            ![
              'post /auth/password/sign-in',
              'post /auth/email-code/sign-in',
            ].includes(`${method} ${path}`)
          ) {
            expect(op?.responses).not.toHaveProperty('401');
          }
        } else {
          expect(op?.security).toBeUndefined();
          expect(op?.responses).toHaveProperty('401');
          expect(op?.responses).toHaveProperty('400');
          expect(op?.responses).toHaveProperty('403');
          expect(op?.parameters).toContainEqual(
            expect.objectContaining({ name: 'X-Ccms-User', in: 'header' }),
          );
        }
      }
    }
  });

  it('uses readable, unique operation IDs', () => {
    const ids = Object.values(doc.paths).flatMap((m) =>
      Object.values(m).map((op) => op.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ManualPdf_pdf');
  });

  it('documents JSON:API media types: JSON:API routes and every error', () => {
    const contentTypes = (path: string, status: string) =>
      Object.keys(
        (
          doc.paths[path]?.['get']?.responses[status] as {
            content?: object;
          }
        ).content ?? {},
      );
    expect(contentTypes('/modules', '200')).toEqual([
      'application/vnd.api+json',
    ]);
    expect(contentTypes('/modules', '406')).toEqual([
      'application/vnd.api+json',
    ]);
    expect(contentTypes('/assets/{hash}', '404')).toEqual([
      'application/vnd.api+json',
    ]);
    const pdf = '/manuals/{id}/variants/{variant}/{lang}/pdf';
    expect(contentTypes(pdf, '200')).toEqual(['application/pdf']);
    for (const status of ['400', '503']) {
      expect(contentTypes(pdf, status)).toEqual(['application/vnd.api+json']);
    }
    const page = '/manuals/{id}/variants/{variant}/{lang}/pdf/pages/{page}.png';
    expect(contentTypes(page, '200')).toEqual(['image/png']);
    for (const status of ['400', '404', '503']) {
      expect(contentTypes(page, status)).toEqual(['application/vnd.api+json']);
    }
    expect(contentTypes('/health', '200')).toEqual(['application/json']);
    const body = doc.paths['/change-sets']?.['post'] as unknown as {
      requestBody: { content: object };
    };
    expect(Object.keys(body.requestBody.content)).toEqual([
      'application/vnd.api+json',
    ]);
    expect(JSON.stringify(doc)).not.toContain('x-ccms-');
    expect(JSON.stringify(doc)).not.toContain('x-openfolia-');
  });

  it('documents every error response, on every route, as JSON:API (SCIM’s as SCIM’s)', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const [status, response] of Object.entries(op.responses)) {
          if (!/^[45]/.test(status)) continue;
          const { content } = response as { content?: object };
          expect([path, Object.keys(content ?? {})]).toEqual([
            path,
            [
              path.startsWith('/scim/')
                ? 'application/scim+json'
                : 'application/vnd.api+json',
            ],
          ]);
        }
      }
    }
  });

  it('documents paging on every list', () => {
    for (const path of [
      '/modules',
      '/modules/{lang}/{id}/history',
      '/manuals',
      '/refs',
      '/audit-events',
      '/users',
      '/service-accounts',
      '/service-accounts/{serviceAccountId}/tokens',
      '/storage-usage/files',
      '/demo/users',
      '/change-sets',
      '/locks',
    ]) {
      const names = (
        (doc.paths[path]?.['get'] as { parameters?: { name: string }[] })
          .parameters ?? []
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(['page[number]', 'page[size]']),
      );
    }
  });

  it('also serves YAML and an interactive reference', async () => {
    const yaml = await t.anonymous().get('/openapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('openapi:');
    const docs = await t.anonymous().get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger');
  });
});
