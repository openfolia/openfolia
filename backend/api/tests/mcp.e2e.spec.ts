import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { createContext, HttpContentApi, startHttpServer } from '@openfolia/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintServiceToken } from '../src/access/core/service-token.js';
import { roles } from '../src/access/repos/access.tables.js';
import { auditEvents } from '../src/audit/repos/audit.tables.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * The MCP server (#53, `@openfolia/mcp`) against the real API over the sample
 * repository, through its Streamable HTTP transport and the SDK's own
 * client: callers bringing their own service account tokens (#861) to one
 * server, two holding `content.read` alone, one in every scope, one limited
 * to the public audience. The sample: `charging`
 * (public, keyword battery, includes the caution `safety-note`),
 * `internals` (internal, "Internal only."), the public operating manual and
 * the internal service manual.
 */
let t: TestApp;
let apiUrl: string;
const servers: Server[] = [];
let mcpUrl: URL;
/** The deprecated shared token (`CCMS_MCP_HTTP_TOKEN`). */
const HTTP_TOKEN = 'mcp-caller-token-0123456789abcdef0123';

/** A service account with a role of `permissions`, and a token of it: `{ id, token }`. */
async function serviceToken(
  account: string,
  maxAudience?: string,
  permissions = ['content.read'],
) {
  await t.database.db.insert(roles).values({
    id: `${account}-reader`,
    name: `${account} reader`,
    permissions,
    ...(maxAudience && { maxAudience }),
  });
  await t.database.db
    .insert(serviceAccounts)
    .values({ id: account, name: account });
  await t.database.db
    .insert(serviceAccountRoles)
    .values({ serviceAccountId: account, roleId: `${account}-reader` });
  const minted = mintServiceToken();
  await t.database.db.insert(serviceTokens).values({
    id: minted.id,
    serviceAccountId: account,
    name: 'MCP',
    secretHash: minted.secretHash,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { id: minted.id, token: minted.token };
}

/** An MCP server whose callers bring their own tokens, and optionally the deprecated shared one. */
async function startMcp(shared?: string) {
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    callerContext: (token) => createContext(new HttpContentApi(apiUrl, token)),
    ...(shared && {
      shared: {
        token: HTTP_TOKEN,
        context: createContext(new HttpContentApi(apiUrl, shared)),
      },
    }),
    allowedOrigins: [],
  });
  servers.push(server);
  return new URL(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  );
}

/** A client of the MCP server (`url`, default the one every caller shares) sending `callerToken`. */
async function connect(callerToken: string, url = mcpUrl) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${callerToken}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      structured: result.structuredContent as Record<string, any>,
      text: (result.content as { text: string }[])[0]?.text ?? '',
    };
  };
  return { client, call };
}

let wide: Awaited<ReturnType<typeof connect>>;
let narrow: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  mcpUrl = await startMcp();
  wide = await connect((await serviceToken('agent')).token);
  narrow = await connect((await serviceToken('public-agent', 'public')).token);
});
afterAll(async () => {
  await wide?.client.close();
  await narrow?.client.close();
  await Promise.all(
    servers.map((s) => new Promise((resolve) => s.close(resolve))),
  );
  await t?.close();
});

describe('the MCP server against the API', () => {
  it('finds the battery module by search, and reads it as Markdown with its safety signal word', async () => {
    const found = await wide.call('search', { query: 'battery' });
    expect(found.isError).toBe(false);
    const results = found.structured['results'] as {
      resourceType: string;
      id: string;
      lang: string;
    }[];
    expect(results).toContainEqual(
      expect.objectContaining({
        resourceType: 'Module',
        id: 'charging',
        lang: 'en',
      }),
    );
    const read = await wide.call('read_module', { id: 'charging', lang: 'en' });
    expect(read.isError).toBe(false);
    expect(read.text).toMatch(/^# Charging/);
    expect(read.text).toContain('**CAUTION:**');
    expect(read.structured).toMatchObject({
      moduleId: 'charging',
      ref: 'main',
      manuals: ['operating', 'service'],
    });
  });

  it('reads a manual for a variant and language as Markdown, lists manuals, variants and chunks, and the manuals as resources', async () => {
    const manuals = await wide.call('list_manuals');
    expect(manuals.structured).toMatchObject({
      languages: ['en', 'de', 'fr'],
      total: 2,
    });
    const manual = await wide.call('read_manual', {
      id: 'operating',
      variant: 'model=large',
      lang: 'en',
    });
    expect(manual.isError).toBe(false);
    expect(manual.text).toContain('# Operating manual');
    expect(manual.text).toContain('*Module* `charging`');
    expect(manual.text).toContain('**CAUTION:**');
    const variants = await wide.call('list_variants');
    expect(variants.structured['attributes']).toEqual([
      expect.objectContaining({ id: 'model', kind: 'enum' }),
    ]);
    const chunks = await wide.call('get_chunks', { lang: 'en' });
    expect(chunks.structured['total']).toBe(3);
    const resources = await wide.client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(
      'openfolia://manuals/operating/model%3Dlarge/en',
    );
    const read = await wide.client.readResource({
      uri: 'openfolia://manuals/operating/model%3Dsmall/en',
    });
    expect((read.contents[0] as { text: string }).text).toContain(
      '# Operating manual',
    );
  });

  it('gives a service account limited to the public audience nothing above it, in no tool, and counts nothing of it', async () => {
    const search = await narrow.call('search', { query: 'maintenance' });
    const ids = (search.structured['results'] as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toContain('charging');
    expect(ids).not.toContain('internals');
    expect(search.structured['total']).toBe(ids.length);
    const internals = await narrow.call('read_module', {
      id: 'internals',
      lang: 'en',
    });
    expect(internals.isError).toBe(true);
    expect(internals.structured['error']).toMatchObject({ code: 'not-found' });
    const chunks = await narrow.call('get_chunks', {});
    expect(chunks.structured['total']).toBe(3);
    expect(JSON.stringify(chunks.structured)).not.toContain('Internal only.');
    const manuals = await narrow.call('list_manuals');
    expect(
      (manuals.structured['manuals'] as { id: string }[]).map((m) => m.id),
    ).toEqual(['operating']);
    expect(manuals.structured['total']).toBe(1);
    const service = await narrow.call('read_manual', {
      id: 'service',
      variant: 'model=large',
      lang: 'en',
    });
    expect(service.structured['error']).toMatchObject({ code: 'not-found' });
    const operating = await narrow.call('read_manual', {
      id: 'operating',
      variant: 'model=large',
      lang: 'en',
    });
    expect(operating.text).not.toContain('Internal only.');
    expect(operating.text).not.toContain('`internals`');
    const resources = await narrow.client.listResources();
    expect(
      resources.resources.every((r) =>
        r.uri.startsWith('openfolia://manuals/operating/'),
      ),
    ).toBe(true);
    // The wide reader on the same commit still sees it: nothing narrow was kept for it.
    expect(
      (await wide.call('read_module', { id: 'internals', lang: 'en' })).isError,
    ).toBe(false);
  });

  it('reads at a release tag, and refuses a draft branch and a change set’s branch', async () => {
    const tagged = await wide.call('read_module', {
      id: 'charging',
      lang: 'en',
      ref: 'v1',
    });
    expect(tagged.structured).toMatchObject({ ref: 'v1' });
    for (const ref of [
      'draft',
      'maintenance/north/1.0',
      'change-sets/0190a1b2c3d4e5f6',
    ]) {
      const refused = await wide.call('get_chunks', { ref });
      expect(refused.structured['error'], ref).toMatchObject({
        code: 'ref-not-released',
      });
    }
  });

  it('serves a release’s tag until it is withdrawn, then refuses it, and lists it as withdrawn', async () => {
    t.actAs({
      ...actorWith(['content.read', 'release.publish']),
      id: 'sample-publisher',
    });
    const cut = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '2.0' },
        },
      }),
    );
    t.actAs(undefined);
    expect(cut.status).toBe(201);
    const { id, attributes } = cut.body.data as {
      id: string;
      attributes: { tag: string };
    };
    const before = await connect((await serviceToken('release-agent')).token);
    const read = await before.call('read_module', {
      id: 'charging',
      lang: 'en',
      ref: attributes.tag,
    });
    expect(read.isError).toBe(false);
    expect(read.structured).toMatchObject({ ref: attributes.tag });
    t.actAs({
      ...actorWith(['content.read', 'release.publish']),
      id: 'sample-publisher',
    });
    const withdrawn = await t
      .post(`/releases/${id}/withdraw`)
      .send(JSON.stringify({ meta: { reason: 'Wrong values.' } }));
    t.actAs(undefined);
    expect(withdrawn.status).toBe(200);
    // Another caller (its own lists; the first's are kept for a minute) is refused it.
    const after = await connect((await serviceToken('later-agent')).token);
    const refused = await after.call('read_module', {
      id: 'charging',
      lang: 'en',
      ref: attributes.tag,
    });
    expect(refused.structured['error']).toMatchObject({
      code: 'release-withdrawn',
    });
    const releases = await after.call('list_releases');
    expect(releases.structured['releases']).toEqual([
      expect.objectContaining({
        tag: attributes.tag,
        withdrawn: expect.objectContaining({ reason: 'Wrong values.' }),
      }),
    ]);
    // A module's newest release is never a withdrawn one.
    const current = await after.call('read_module', {
      id: 'charging',
      lang: 'en',
    });
    expect(current.structured['release']?.tag).not.toBe(attributes.tag);
    await before.client.close();
    await after.client.close();
  });

  it('refuses a caller whose token may also read drafts, with 403 token-not-read-only', async () => {
    const drafts = await serviceToken('draft-agent', undefined, [
      'content.read',
      'content.read.draft',
    ]);
    await expect(connect(drafts.token)).rejects.toThrow();
    const answer = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${drafts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(answer.status).toBe(403);
    const body = await answer.text();
    expect(body).toContain('token-not-read-only');
    expect(body).not.toContain(drafts.token);
    // The API's shared token is no service account's: refused before the API is asked.
    await expect(connect(TOKEN)).rejects.toThrow();
  });

  it('refuses callers without a token the API takes', async () => {
    await expect(
      connect('wrong-token-0123456789abcdef0123456789'),
    ).rejects.toThrow();
    const unknown = (await serviceToken('unknown-agent')).token.replace(
      /.{8}$/,
      '00000000',
    );
    await expect(connect(unknown)).rejects.toThrow();
    const answer = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${unknown}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain('unauthorized');
  });

  it('reads as each caller’s own account, and a revoked token stops alone, at its next read', async () => {
    const own = await serviceToken('revoked-agent');
    const caller = await connect(own.token);
    expect((await caller.call('list_manuals')).isError).toBe(false);
    // The API saw the caller's own token: its last use is recorded.
    const [used] = await t.database.db
      .select({ lastUsedAt: serviceTokens.lastUsedAt })
      .from(serviceTokens)
      .where(eq(serviceTokens.id, own.id));
    expect(used?.lastUsedAt).not.toBeNull();
    await t.database.db
      .update(serviceTokens)
      .set({ revokedAt: new Date() })
      .where(eq(serviceTokens.id, own.id));
    const refused = await caller.call('list_manuals');
    expect(refused.isError).toBe(true);
    expect(refused.structured['error']).toMatchObject({
      code: 'token-revoked',
    });
    // Every other caller reads on.
    expect((await wide.call('list_manuals')).isError).toBe(false);
    await caller.client.close();
  });

  // #877: every API read of a caller's token is a read event naming its account, the token and
  // the tool that read; another caller's reads name their own account.
  it('records each read of a caller as a read event naming its service account and the tool', async () => {
    const own = await serviceToken('audited-agent');
    const caller = await connect(own.token);
    expect(
      (await caller.call('read_module', { id: 'charging', lang: 'en' }))
        .isError,
    ).toBe(false);
    const readsOf = async (account: string) =>
      (
        await t.database.db
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.kind, 'read'), eq(auditEvents.actorId, account)),
          )
      ).map((e) => ({
        action: e.action,
        actorKind: e.actorKind,
        path: e.subjectId,
        data: e.data,
      }));
    await vi.waitFor(async () =>
      expect(
        (await readsOf('audited-agent')).some(
          (e) => e.data['client'] === 'mcp/read_module',
        ),
      ).toBe(true),
    );
    const reads = await readsOf('audited-agent');
    expect(reads).toContainEqual({
      action: 'api.read',
      actorKind: 'service',
      // `read_module` reads the module's chunks.
      path: '/chunks',
      data: expect.objectContaining({
        tokenId: own.id,
        client: 'mcp/read_module',
        status: 200,
        ref: 'main',
      }),
    });
    // The token check is the server's own lookup, named `mcp`.
    expect(reads).toContainEqual(
      expect.objectContaining({
        path: '/me',
        data: expect.objectContaining({ client: 'mcp' }),
      }),
    );
    expect(JSON.stringify(reads)).not.toContain(own.token);
    await caller.client.close();
  });

  it('still serves the deprecated shared token, reading as the server’s own account', async () => {
    const url = await startMcp((await serviceToken('shared-agent')).token);
    const shared = await connect(HTTP_TOKEN, url);
    expect((await shared.call('list_manuals')).isError).toBe(false);
    await shared.client.close();
    await expect(connect(HTTP_TOKEN)).rejects.toThrow();
  });
});
