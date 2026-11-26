import { Logger } from '@nestjs/common';
import request from 'supertest';
import { IssuedServiceTokenDocument } from '../src/access/api/service-accounts.resources.js';
import { roles } from '../src/access/repos/access.tables.js';
import { exampleSeed } from '../src/access/repos/example-seed.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import {
  ScimDiscoveryList,
  ScimDiscoveryResource,
  ScimErrorDocument,
  ScimGroupList,
  ScimGroupResource,
  ScimUserList,
  ScimUserResource,
} from '../src/scim/api/scim.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SCIM = 'application/scim+json';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * Provisioning over SCIM 2.0 (#377), in demo mode over the example seed: an admin makes a
 * service account holding `scim.provision` and its token; the directory then provisions with it.
 */
describe('SCIM', () => {
  let t: TestApp;
  let token = '';
  beforeAll(async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      t = await createTestApp({ CCMS_AUTH_MODE: 'demo' });
    } finally {
      warn.mockRestore();
    }
    await seedAccess(t.database, Seed.parse(exampleSeed));
    await t.database.db.insert(roles).values([
      { id: 'directory', name: 'Directory', permissions: ['scim.provision'] },
      { id: 'reading-bot', name: 'Reading bot', permissions: ['content.read'] },
    ]);
  });
  afterAll(() => t?.close());

  const admin = {
    get: (path: string) => t.get(path).set('X-Ccms-User', 'sample-admin'),
    post: (path: string, body: unknown) =>
      t
        .post(path)
        .set('X-Ccms-User', 'sample-admin')
        .send(JSON.stringify(body)),
  };
  const asUser = (id: string) => t.get('/me').set('X-Ccms-User', id);
  /** A service account with `roleIds` and a token of its own. */
  const account = async (id: string, roleIds: string[]) => {
    const made = await admin.post('/service-accounts', {
      data: {
        type: 'ServiceAccount',
        id,
        attributes: { name: id, description: null },
        relationships: {
          roles: { data: roleIds.map((r) => ({ type: 'Role', id: r })) },
        },
      },
    });
    expect(made.status).toBe(201);
    const issued = await admin.post(`/service-accounts/${id}/tokens`, {
      data: { type: 'ServiceToken', attributes: { name: 'SCIM' } },
    });
    expect(issued.status).toBe(201);
    return IssuedServiceTokenDocument.parse(issued.body).meta.token;
  };
  const scim = (secret = token) => {
    const server = t.app.getHttpServer();
    const send = (
      method: 'post' | 'put' | 'patch',
      path: string,
      body: unknown,
    ) =>
      request(server)
        [method](`/scim/v2${path}`)
        .set('Authorization', `Bearer ${secret}`)
        .set('Content-Type', SCIM)
        .send(JSON.stringify(body));
    return {
      get: (path: string) =>
        request(server)
          .get(`/scim/v2${path}`)
          .set('Authorization', `Bearer ${secret}`),
      post: (path: string, body: unknown) => send('post', path, body),
      put: (path: string, body: unknown) => send('put', path, body),
      patch: (path: string, body: unknown) => send('patch', path, body),
      delete: (path: string) =>
        request(server)
          .delete(`/scim/v2${path}`)
          .set('Authorization', `Bearer ${secret}`),
    };
  };
  const error = (body: unknown) => ScimErrorDocument.parse(body);
  const patchOp = (...Operations: unknown[]) => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations,
  });

  const jane = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'jane.doe@example.org',
    externalId: 'E-1',
    name: { givenName: 'Jane', familyName: 'Doe' },
    emails: [{ value: 'jane.doe@example.org', type: 'work', primary: true }],
    active: true,
  };

  it('is off until an admin makes a SCIM token: 401 in SCIM’s shape', async () => {
    const res = await request(t.app.getHttpServer()).get('/scim/v2/Users');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toBe(SCIM);
    expect(error(res.body)).toEqual({
      schemas: [ERROR],
      status: '401',
      detail: 'A valid API token is required.',
    });
    token = await account('directory', ['directory']);
  });

  it('refuses a token without scim.provision, and a person, whatever their roles', async () => {
    const other = await account('reading-bot', ['reading-bot']);
    const refused = await scim(other).get('/Users');
    expect(refused.status).toBe(403);
    expect(error(refused.body).status).toBe('403');
    const person = await request(t.app.getHttpServer())
      .get('/scim/v2/Users')
      .set('Authorization', `Bearer ${'test-token-0123456789abcdef0123456789'}`)
      .set('X-Ccms-User', 'sample-admin');
    expect(person.status).toBe(403);
  });

  it('answers what it supports', async () => {
    const config = await scim().get('/ServiceProviderConfig');
    expect(config.status).toBe(200);
    expect(config.headers['content-type']).toBe(SCIM);
    expect(ScimDiscoveryResource.parse(config.body)).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
    });
    const types = ScimDiscoveryList.parse(
      (await scim().get('/ResourceTypes')).body,
    );
    expect(types.Resources.map((r) => r['id'])).toEqual(['User', 'Group']);
    expect((await scim().get('/ResourceTypes/Group')).status).toBe(200);
    expect((await scim().get('/ResourceTypes/Nope')).status).toBe(404);
    const schemas = ScimDiscoveryList.parse(
      (await scim().get('/Schemas')).body,
    );
    expect(schemas.totalResults).toBe(3);
    const user = await scim().get(
      '/Schemas/urn:ietf:params:scim:schemas:core:2.0:User',
    );
    expect(user.status).toBe(200);
  });

  it('provisions a user, finds it by filter, changes it and lets it go', async () => {
    const created = await scim().post('/Users', jane);
    expect(created.status).toBe(201);
    expect(created.headers['content-type']).toBe(SCIM);
    const user = ScimUserResource.parse(created.body);
    expect(user).toMatchObject({
      id: 'jane.doe',
      userName: 'jane.doe@example.org',
      active: true,
      meta: { resourceType: 'User', location: '/scim/v2/Users/jane.doe' },
    });
    expect(created.headers['location']).toBe('/scim/v2/Users/jane.doe');
    // The same userName again: uniqueness.
    const again = await scim().post('/Users', { ...jane, emails: [] });
    expect([again.status, error(again.body).scimType]).toEqual([
      409,
      'uniqueness',
    ]);
    // A person of the platform now: they act as themselves.
    expect((await asUser('jane.doe')).status).toBe(200);

    const found = ScimUserList.parse(
      (
        await scim().get(
          '/Users?filter=userName%20eq%20%22JANE.DOE@example.org%22',
        )
      ).body,
    );
    expect(found).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    });
    const none = ScimUserList.parse(
      (await scim().get('/Users?filter=externalId%20eq%20%22e-1%22')).body,
    );
    expect(none.totalResults).toBe(0);
    const only = await scim().get('/Users/jane.doe?attributes=userName');
    expect(Object.keys(only.body as object).sort()).toEqual([
      'id',
      'schemas',
      'userName',
    ]);

    const put = await scim().put('/Users/jane.doe', {
      ...jane,
      displayName: 'Jane D.',
    });
    expect(put.status).toBe(200);
    const listed = (await admin.get('/users/jane.doe')).body as {
      data: { attributes: { name: string } };
    };
    expect(listed.data.attributes.name).toBe('Jane D.');

    // Sent again, its attributes in another order: nothing is written.
    const updates = async () =>
      AuditEventPageDocument.parse(
        (await admin.get('/audit-events?page[size]=200')).body,
      ).data.filter((e) => e.attributes.action === 'user.update').length;
    const written = await updates();
    const repeated = await scim().put('/Users/jane.doe', {
      displayName: 'Jane D.',
      ...jane,
      emails: [{ primary: true, type: 'work', value: jane.userName }],
      name: { familyName: 'Doe', givenName: 'Jane' },
    });
    expect(repeated.status).toBe(200);
    expect(await updates()).toBe(written);

    // Deprovisioned, whatever else is sent wrong: the very next request is refused.
    const patched = await scim().patch(
      '/Users/jane.doe',
      patchOp(
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'move', path: 'title' },
      ),
    );
    expect(patched.status).toBe(200);
    expect(ScimUserResource.parse(patched.body).active).toBe(false);
    const refused = await asUser('jane.doe');
    expect(refused.status).toBe(403);
    expect(
      (refused.body as { errors: { code: string }[] }).errors[0]?.code,
    ).toBe('user-deactivated');
    await scim().patch(
      '/Users/jane.doe',
      patchOp({ op: 'replace', value: { active: true } }),
    );
    expect((await asUser('jane.doe')).status).toBe(200);

    const gone = await scim().delete('/Users/jane.doe');
    expect(gone.status).toBe(204);
    expect((await scim().get('/Users/jane.doe')).status).toBe(404);
    expect((await asUser('jane.doe')).status).toBe(403);
    // The user stays, deactivated, with whatever it wrote.
    const kept = (await admin.get('/users/jane.doe')).body as {
      data: { attributes: { deactivatedAt: string | null } };
    };
    expect(kept.data.attributes.deactivatedAt).not.toBeNull();

    const audited = AuditEventPageDocument.parse(
      (await admin.get('/audit-events?page[size]=200')).body,
    ).data.filter(
      (e) =>
        e.attributes.subject.type === 'user' &&
        e.attributes.subject.id === 'jane.doe',
    );
    expect(audited.map((e) => e.attributes.action)).toEqual(
      expect.arrayContaining([
        'user.create',
        'user.update',
        'user.deactivate',
        'user.reactivate',
        'user.identity-unlink',
      ]),
    );

    // Provisioned again: the same user, active again.
    const back = await scim().post('/Users', jane);
    expect(back.status).toBe(201);
    expect(ScimUserResource.parse(back.body)).toMatchObject({
      id: 'jane.doe',
      active: true,
    });
    expect((await asUser('jane.doe')).status).toBe(200);
  });

  it('provisions groups that feed the group mappings', async () => {
    for (const n of ['ann', 'bob']) {
      expect((await scim().post('/Users', { userName: n })).status).toBe(201);
    }
    const mapping = await admin.post('/group-mappings', {
      data: {
        type: 'GroupMapping',
        attributes: { group: 'Writers' },
        relationships: { role: { data: { type: 'Role', id: 'author' } } },
      },
    });
    expect(mapping.status).toBe(201);
    const created = await scim().post('/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Writers',
      members: [{ value: 'ann' }],
    });
    expect(created.status).toBe(201);
    const group = ScimGroupResource.parse(created.body);
    const groupRoles = async (id: string) =>
      (
        (await admin.get(`/users/${id}`)).body as {
          data: { meta: { groupRoleIds: string[] } };
        }
      ).data.meta.groupRoleIds;
    expect(await groupRoles('ann')).toEqual(['author']);

    // A role with a global permission never comes through a SCIM group: the token makes no admin.
    const adminMapping = await admin.post('/group-mappings', {
      data: {
        type: 'GroupMapping',
        attributes: { group: 'Admins' },
        relationships: { role: { data: { type: 'Role', id: 'admin' } } },
      },
    });
    expect(adminMapping.status).toBe(201);
    const admins = await scim().post('/Groups', {
      displayName: 'Admins',
      members: [{ value: 'ann' }],
    });
    expect(admins.status).toBe(201);
    expect(await groupRoles('ann')).toEqual(['author']);
    const adminsId = ScimGroupResource.parse(admins.body).id;
    expect((await scim().delete(`/Groups/${adminsId}`)).status).toBe(204);

    const patched = await scim().patch(
      `/Groups/${group.id}`,
      patchOp(
        { op: 'add', path: 'members', value: [{ value: 'bob' }] },
        { op: 'remove', path: 'members', value: [{ value: 'ann' }] },
      ),
    );
    expect(patched.status).toBe(200);
    expect(await groupRoles('ann')).toEqual([]);
    expect(await groupRoles('bob')).toEqual(['author']);

    // The role gains a global permission: a SCIM group gives it no longer.
    const author = (await admin.get('/roles/author')).body as {
      data: { attributes: { permissions: string[] } };
    };
    const widened = await t
      .patch('/roles/author')
      .set('X-Ccms-User', 'sample-admin')
      .send(
        JSON.stringify({
          data: {
            type: 'Role',
            id: 'author',
            attributes: {
              permissions: [
                ...author.data.attributes.permissions,
                'webhook.manage',
              ],
            },
          },
        }),
      );
    expect(widened.status).toBe(200);
    expect(await groupRoles('bob')).toEqual([]);
    expect(
      (
        await t
          .patch('/roles/author')
          .set('X-Ccms-User', 'sample-admin')
          .send(
            JSON.stringify({
              data: {
                type: 'Role',
                id: 'author',
                attributes: { permissions: author.data.attributes.permissions },
              },
            }),
          )
      ).status,
    ).toBe(200);
    const bob = ScimUserResource.parse((await scim().get('/Users/bob')).body);
    expect(bob.groups).toEqual([
      { value: group.id, display: 'Writers', type: 'direct' },
    ]);

    const listed = ScimGroupList.parse(
      (
        await scim().get(
          '/Groups?filter=displayName%20eq%20%22writers%22&excludedAttributes=members',
        )
      ).body,
    );
    expect(listed.totalResults).toBe(1);
    expect(listed.Resources[0]).not.toHaveProperty('members');

    const unknown = await scim().post('/Groups', {
      displayName: 'Others',
      members: [{ value: 'sample-admin' }],
    });
    expect([unknown.status, error(unknown.body).scimType]).toEqual([
      400,
      'invalidValue',
    ]);

    expect((await scim().delete(`/Groups/${group.id}`)).status).toBe(204);
    expect(await groupRoles('bob')).toEqual([]);
    expect((await scim().get(`/Groups/${group.id}`)).status).toBe(404);
    expect((await scim().get('/Groups/not-a-uuid')).status).toBe(404);
  });

  it('answers errors as SCIM does', async () => {
    const filter = await scim().get('/Users?filter=userName%20eq');
    expect([filter.status, error(filter.body).scimType]).toEqual([
      400,
      'invalidFilter',
    ]);
    const syntax = await scim().patch('/Users/ann', {
      Operations: [{ op: 'move' }],
    });
    expect([syntax.status, error(syntax.body).scimType]).toEqual([
      400,
      'invalidSyntax',
    ]);
    const readOnly = await scim().patch(
      '/Users/ann',
      patchOp({ op: 'replace', path: 'id', value: 'x' }),
    );
    expect([readOnly.status, error(readOnly.body).scimType]).toEqual([
      400,
      'mutability',
    ]);
    const missing = await scim().post('/Users', { displayName: 'No userName' });
    expect([missing.status, error(missing.body).scimType]).toEqual([
      400,
      'invalidValue',
    ]);
    const parameter = await scim().get('/Users?page[size]=2');
    expect([parameter.status, error(parameter.body).status]).toEqual([
      400,
      '400',
    ]);
    const accept = await scim().get('/Users').set('Accept', 'text/html');
    expect(accept.status).toBe(406);
    const body = await request(t.app.getHttpServer())
      .post('/scim/v2/Users')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .send('userName=x');
    expect([body.status, body.headers['content-type']]).toEqual([415, SCIM]);
    // Plain JSON is read too, as some directories send it.
    const json = await request(t.app.getHttpServer())
      .post('/scim/v2/Users')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ userName: 'cid' }));
    expect(json.status).toBe(201);
    const page = ScimUserList.parse(
      (await scim().get('/Users?startIndex=2&count=1')).body,
    );
    expect([page.startIndex, page.itemsPerPage, page.Resources.length]).toEqual(
      [2, 1, 1],
    );
  });

  it('is in the OpenAPI document with its own media type', async () => {
    const doc = (await t.anonymous().get('/openapi.json')).body as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: object }> }>
      >;
    };
    const list = doc.paths['/scim/v2/Users']?.['get'];
    expect(Object.keys(list?.responses['200']?.content ?? {})).toEqual([SCIM]);
    expect(Object.keys(list?.responses['401']?.content ?? {})).toEqual([SCIM]);
  });
});
