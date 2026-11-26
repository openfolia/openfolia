import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Module } from '@openfolia/content-model';
import {
  ActorDocument,
  UserPageDocument,
} from '../src/access/api/access.resources.js';
import { exampleSeed } from '../src/access/repos/example-seed.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { LockDocument } from '../src/change-sets/api/lock.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CommentDocument } from '../src/comments/api/comment.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { fillValid, openApiPath, send as sendRoute } from './routes.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Contributors (#137): the example seed's `contributor` role
 * (`content.read` and `content.edit`, no `content.read.draft`), in demo
 * mode, so every request resolves the seeded user as the app does. A
 * contributor suggests a change with an image and an attachment in a change
 * set of their own, comments on it and submits it; a reviewer approves it
 * and a publisher merges it. Every step past their own change set is
 * refused: 403 for what they may not do, 404 for what they may not see.
 */

const CONTRIBUTOR = 'sample-contributor';
const AUTHOR = 'sample-author';
const REVIEWER = 'sample-reviewer';
const PUBLISHER = 'sample-publisher';
const ADMIN = 'sample-admin';

/** A real 1×1 PNG, with bytes after its end so no other test (or the sample) holds it. */
const PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
  Buffer.from('#contributor'),
]);
const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(32),
  Buffer.from('#contributor'),
]);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const subject = (moduleId: string) =>
  ({ type: 'module', lang: 'en', moduleId }) as const;
const charging = subject('charging');

let t: TestApp;
beforeAll(async () => {
  // Demo mode warns loudly at start-up: not this test's concern.
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  try {
    t = await createTestApp({ CCMS_AUTH_MODE: 'demo' });
  } finally {
    warn.mockRestore();
  }
  await seedAccess(t.database, Seed.parse(exampleSeed));
});
afterAll(() => t?.close());

const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const send = (body: unknown) =>
  body === undefined ? undefined : JSON.stringify(body);

/** Requests as the seeded user `user`, resolved by the app (`X-Ccms-User`). */
const as = (user: string) => ({
  get: (path: string) => t.get(path).set('X-Ccms-User', user),
  post: (path: string, body?: unknown) =>
    t.post(path).set('X-Ccms-User', user).send(send(body)),
  put: (path: string, body: unknown) =>
    t.put(path).set('X-Ccms-User', user).send(send(body)),
  patch: (path: string, body: unknown) =>
    t.patch(path).set('X-Ccms-User', user).send(send(body)),
  delete: (path: string, body?: unknown) =>
    t.delete(path).set('X-Ccms-User', user).send(send(body)),
  /** A multipart upload into a change set, as a browser sends it. */
  upload: (cs: string, kind: string, data: Buffer, filename: string) =>
    t
      .anonymous()
      .post(`/change-sets/${cs}/assets?kind=${kind}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Ccms-User', user)
      .set(REQUEST_HEADER, '1')
      .attach('file', data, { filename, contentType: 'application/json' }),
});
type As = ReturnType<typeof as>;
const contributor = as(CONTRIBUTOR);

const copyPath = (cs: string, moduleId = 'charging') =>
  `/change-sets/${cs}/modules/en/${moduleId}/working-copy`;

async function start(who: As, title: string) {
  const res = await who.post('/change-sets', {
    data: { type: 'ChangeSet', attributes: { title } },
  });
  expect(res.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(res.body).data;
  return { id, branch: attributes.branch };
}

async function lock(who: As, cs: string, moduleId = 'charging') {
  const res = await who.post(`/change-sets/${cs}/locks`, {
    data: { type: 'Lock', attributes: { subject: subject(moduleId) } },
  });
  expect(res.status).toBe(201);
  return LockDocument.parse(res.body).data.id;
}

/** Saves `blocks` after the module's own into its working copy (an autosave). */
async function autosave(
  who: As,
  cs: string,
  blocks: unknown[],
  moduleId = 'charging',
) {
  const read = await who.get(copyPath(cs, moduleId));
  expect(read.status).toBe(200);
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const content = at.content as Module;
  const res = await who.put(copyPath(cs, moduleId), {
    data: {
      type: 'WorkingCopy',
      attributes: { content: { ...content, blocks } },
    },
    meta: { version: at.version, baseCommit: at.baseCommit },
  });
  expect(res.status).toBe(200);
}

const paragraph = (id: string, text: string) => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

/**
 * A change set of `who`'s with one save point on the module `moduleId`, its
 * lock given back.
 */
async function suggested(who: As, title: string, moduleId: string) {
  const cs = await start(who, title);
  const lockId = await lock(who, cs.id, moduleId);
  await autosave(
    who,
    cs.id,
    [paragraph('suggested', 'Plug in first.')],
    moduleId,
  );
  expect((await who.post(`/change-sets/${cs.id}/commits`)).status).toBe(201);
  expect((await who.delete(`/locks/${lockId}`)).status).toBe(204);
  return cs;
}

describe('a seeded contributor', () => {
  it('holds content.read and content.edit only, listed with those permissions', async () => {
    const res = await as(ADMIN).get('/users?page[size]=200');
    expect(res.status).toBe(200);
    const user = UserPageDocument.parse(res.body).data.find(
      (u) => u.id === CONTRIBUTOR,
    );
    expect(user?.relationships.roles.data).toEqual([
      { type: 'Role', id: 'contributor' },
    ]);
    expect(user?.meta.permissions).toEqual(['content.read', 'content.edit']);
    const me = await contributor.get('/me');
    expect(me.status).toBe(200);
    expect(
      ActorDocument.parse(me.body).data.meta.permissions.map(
        (p) => p.permission,
      ),
    ).toEqual(['content.read', 'content.edit']);
  });

  it('suggests a text change with an image and an attachment; a reviewer approves it and a publisher merges it', async () => {
    // Start a change set, lock the module, autosave the text.
    const cs = await start(contributor, 'Charging');
    const lockId = await lock(contributor, cs.id);
    await autosave(contributor, cs.id, [
      paragraph('suggested', 'Plug the charger in before switching on.'),
    ]);

    // Upload an image and an attachment into it, and place both.
    const image = await contributor.upload(cs.id, 'image', PNG, 'photo.png');
    expect(image.status).toBe(201);
    const imageRef = ChangeSetAssetDocument.parse(image.body).data.attributes;
    const file = await contributor.upload(
      cs.id,
      'attachment',
      ZIP,
      'wiring.zip',
    );
    expect(file.status).toBe(201);
    const fileRef = ChangeSetAssetDocument.parse(file.body).data.attributes;
    expect(fileRef.reference).toBe(`sha256:${sha256(ZIP)}`);
    // Their own uploads preview for them before any save point.
    const preview = await contributor
      .get(`/change-sets/${cs.id}/assets/${sha256(PNG)}`)
      .set('Accept', 'image/*');
    expect(preview.status).toBe(200);
    await autosave(contributor, cs.id, [
      paragraph('suggested', 'Plug the charger in before switching on.'),
      {
        type: 'image',
        id: 'photo',
        asset: imageRef.reference,
        alt: 'The charger plugged in',
      },
      {
        type: 'attachment',
        id: 'wiring',
        asset: fileRef.reference,
        name: 'Wiring diagram',
        fileName: fileRef.fileName ?? 'wiring.zip',
        mediaType: fileRef.contentType,
        size: fileRef.size,
      },
    ]);

    // A save point, read back on their own branch.
    expect(
      (await contributor.post(`/change-sets/${cs.id}/commits`)).status,
    ).toBe(201);
    const onBranch = await contributor.get(
      `/modules/en/charging?ref=${encodeURIComponent(cs.branch)}`,
    );
    expect(onBranch.status).toBe(200);
    expect(
      ModuleDocument.parse(onBranch.body).data.attributes.blocks.map(
        (b) => b.id,
      ),
    ).toEqual(['suggested', 'photo', 'wiring']);

    // A comment on their own change set.
    const comment = await contributor.post(`/change-sets/${cs.id}/comments`, {
      data: {
        type: 'Comment',
        attributes: {
          body: 'The photo shows the new charger.',
          subject: charging,
          blockId: 'photo',
        },
      },
    });
    expect(comment.status).toBe(201);
    CommentDocument.parse(comment.body);

    // Their lock is theirs to give back; then submit, with the note.
    expect((await contributor.delete(`/locks/${lockId}`)).status).toBe(204);
    const submitted = await contributor.post(`/change-sets/${cs.id}/submit`, {
      meta: { comment: 'Added a photo and the wiring diagram.' },
    });
    expect(submitted.status).toBe(200);
    expect(ChangeSetDocument.parse(submitted.body).data.attributes.state).toBe(
      'in-review',
    );

    // A reviewer approves it, a publisher merges it.
    const approved = await as(REVIEWER).post(`/change-sets/${cs.id}/approve`, {
      meta: { comment: 'Thanks, reads well.' },
    });
    expect(approved.status).toBe(200);
    expect(
      ChangeSetDocument.parse(
        (await as(REVIEWER).get(`/change-sets/${cs.id}`)).body,
      ).data.attributes.state,
    ).toBe('approved');
    const merged = await as(PUBLISHER).post(`/change-sets/${cs.id}/merge`, {
      meta: { comment: 'In.' },
    });
    expect(merged.status).toBe(200);

    // Released: everyone reads it, the image and the attachment on main.
    const released = await contributor.get('/modules/en/charging');
    expect(released.status).toBe(200);
    expect(
      ModuleDocument.parse(released.body).data.attributes.blocks.map(
        (b) => b.id,
      ),
    ).toEqual(['suggested', 'photo', 'wiring']);
    const asset = await contributor.get(`/assets/${sha256(PNG)}`);
    expect(asset.status).toBe(200);
  });
});

describe('what a contributor may not do: 403', () => {
  /** A contributor's change set in review, with a lock another holds on it. */
  let inReview: { id: string; branch: string };
  let lockId: string;
  beforeAll(async () => {
    inReview = await suggested(contributor, 'In review', 'safety-note');
    expect(
      (await contributor.post(`/change-sets/${inReview.id}/submit`)).status,
    ).toBe(200);
    const authors = await start(as(AUTHOR), 'Someone else’s');
    lockId = await lock(as(AUTHOR), authors.id);
  });

  const refused = (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  };

  it('approve', async () => {
    refused(await contributor.post(`/change-sets/${inReview.id}/approve`));
  });

  it('sign-off', async () => {
    refused(await contributor.post(`/change-sets/${inReview.id}/sign-off`));
  });

  it('return', async () => {
    refused(
      await contributor.post(`/change-sets/${inReview.id}/return`, {
        meta: { comment: 'Back to me.' },
      }),
    );
  });

  it('merge', async () => {
    refused(await contributor.post(`/change-sets/${inReview.id}/merge`));
  });

  it('release', async () => {
    refused(
      await contributor.post('/releases', {
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '9.9' },
        },
      }),
    );
  });

  it('break a lock', async () => {
    refused(
      await contributor.post(`/locks/${lockId}/break`, {
        meta: { comment: 'Mine now.' },
      }),
    );
  });

  it('break locks in bulk', async () => {
    refused(
      await contributor.post('/locks/break', {
        meta: { comment: 'Mine now.', changeSet: inReview.id },
      }),
    );
  });

  // Unused files include other people's abandoned draft uploads: not for a contributor.
  it('list unused files', async () => {
    refused(await contributor.get('/assets?filter[unused]=true'));
  });

  it('delete an unused file', async () => {
    refused(await contributor.delete(`/assets/${'a'.repeat(64)}`));
  });

  /**
   * Every route needing `admin.roles` but the lock breaks above, as the app
   * routes it; requested with well-formed parameters and bodies
   * (`routes.ts`), so only the permission can refuse it.
   */
  const ADMIN_ROUTES = [
    'GET /audit-events',
    'GET /audit-events/export',
    'GET /importers',
    'POST /imports',
    'GET /imports/:importId',
    'POST /imports/:importId/apply',
    'GET /roles',
    'POST /roles',
    'GET /roles/:roleId',
    'PATCH /roles/:roleId',
    'DELETE /roles/:roleId',
    'GET /group-mappings',
    'POST /group-mappings',
    'GET /group-mappings/:mappingId',
    'DELETE /group-mappings/:mappingId',
    'GET /users',
    'POST /users',
    'GET /users/:userId',
    'PATCH /users/:userId',
    'POST /users/:userId/relationships/roles',
    'DELETE /users/:userId/relationships/roles',
    'POST /users/:userId/deactivate',
    'POST /users/:userId/reactivate',
    'POST /users/:userId/invite',
    'DELETE /users/:userId/invite',
    'POST /users/:userId/password-reset',
    'DELETE /users/:userId/second-factor',
    'GET /service-accounts',
    'POST /service-accounts',
    'GET /service-accounts/:serviceAccountId',
    'PATCH /service-accounts/:serviceAccountId',
    'POST /service-accounts/:serviceAccountId/relationships/roles',
    'DELETE /service-accounts/:serviceAccountId/relationships/roles',
    'POST /service-accounts/:serviceAccountId/deactivate',
    'POST /service-accounts/:serviceAccountId/reactivate',
    'GET /service-accounts/:serviceAccountId/tokens',
    'POST /service-accounts/:serviceAccountId/tokens',
    'POST /service-accounts/:serviceAccountId/tokens/:tokenId/revoke',
    'GET /storage-usage',
    'GET /storage-usage/files',
    'GET /secret-key',
    'GET /mail',
    'POST /mail/test',
    'GET /jobs/status',
    'GET /outbox/status',
    'GET /settings',
    'PATCH /settings',
  ];

  it('covers every admin route of the OpenAPI document', async () => {
    const doc = (await t.get('/openapi.json')).body as {
      paths: Record<
        string,
        Record<string, { 'x-required-permission'?: string }>
      >;
    };
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => op['x-required-permission'] === 'admin.roles')
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    const breaks = ['POST /locks/break', 'POST /locks/{lockId}/break'];
    expect(
      [
        ...breaks,
        ...ADMIN_ROUTES.map((route) => {
          const [method, path = ''] = route.split(' ');
          return `${method} ${openApiPath(path)}`;
        }),
      ].sort(),
    ).toEqual(documented.sort());
  });

  it.each(ADMIN_ROUTES)('admin: %s', async (route) => {
    const path = fillValid(route.split(' ')[1] ?? '');
    refused(
      await sendRoute(t.anonymous(), route, path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-Ccms-User', CONTRIBUTOR),
    );
  });
});

describe('a contributor never sees another person’s draft: 404', () => {
  let theirs: { id: string; branch: string };
  let imageHash: string;
  beforeAll(async () => {
    theirs = await suggested(as(AUTHOR), 'Not yours', 'internals');
    const png = Buffer.concat([PNG, Buffer.from('#theirs')]);
    imageHash = sha256(png);
    expect(
      (await as(AUTHOR).upload(theirs.id, 'image', png, 'theirs.png')).status,
    ).toBe(201);
  });

  const notFound = async (res: Promise<{ status: number }>) =>
    expect((await res).status).toBe(404);

  it('the change set', () =>
    notFound(contributor.get(`/change-sets/${theirs.id}`)));
  it('its branch', () =>
    notFound(
      contributor.get(`/modules?ref=${encodeURIComponent(theirs.branch)}`),
    ));
  it('a module on its branch', () =>
    notFound(
      contributor.get(
        `/modules/en/charging?ref=${encodeURIComponent(theirs.branch)}`,
      ),
    ));
  it('its working copy', () => notFound(contributor.get(copyPath(theirs.id))));
  it('its changes', () =>
    notFound(contributor.get(`/change-sets/${theirs.id}/changes`)));
  it('its comments', () =>
    notFound(contributor.get(`/change-sets/${theirs.id}/comments`)));
  it('its checks', () =>
    notFound(contributor.get(`/change-sets/${theirs.id}/checks`)));
  it('an image uploaded into it', () =>
    notFound(
      contributor
        .get(`/change-sets/${theirs.id}/assets/${imageHash}`)
        .set('Accept', 'image/*'),
    ));
  it('a comment on it', () =>
    notFound(
      contributor.post(`/change-sets/${theirs.id}/comments`, {
        data: {
          type: 'Comment',
          attributes: {
            body: 'x',
            subject: subject('internals'),
            blockId: 'suggested',
          },
        },
      }),
    ));
  it('an upload into it', () =>
    notFound(contributor.upload(theirs.id, 'image', PNG, 'mine.png')));
  it('a save point on it', () =>
    notFound(contributor.post(`/change-sets/${theirs.id}/commits`)));
  it('submitting it', () =>
    notFound(contributor.post(`/change-sets/${theirs.id}/submit`)));
  it('in the list of change sets', async () => {
    const res = await contributor.get(`/change-sets?filter[author]=${AUTHOR}`);
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });
});
