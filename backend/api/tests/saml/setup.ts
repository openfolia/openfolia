import { createServer, type AddressInfo } from 'node:net';
import { Seed, seedAccess } from '../../src/access/repos/seed.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  type MockSamlIdp,
  type MockSamlOptions,
  startMockSamlIdp,
} from './mock-idp.js';

/** One app with SAML sign-in on (#376), behind its mock identity provider, listening on a port. */
export interface SamlSetup {
  readonly t: TestApp;
  readonly mock: MockSamlIdp;
  /** The app's address, also its editor's (`CCMS_EDITOR_URL`). */
  readonly base: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the mock identity provider and the app with SAML on (and `env`, or what it answers for
 * the app's address), with the roles
 * `admin`, `author` and `reviewer`, the first admin `first-admin` (root@example.org), and the
 * groups `writers` → author, `reviewers` → reviewer.
 */
export async function setUpSaml(
  env:
    | Record<string, string>
    | ((base: string) => Promise<Record<string, string>>) = {},
  idp: Pick<MockSamlOptions, 'secondCertificate'> = {},
): Promise<SamlSetup> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const settings = typeof env === 'function' ? await env(base) : env;
  const mock = await startMockSamlIdp({
    ...idp,
    // The addresses the API derives from CCMS_EDITOR_URL (under the editor's /api).
    audience:
      settings['CCMS_SAML_SP_ENTITY_ID'] ?? `${base}/api/auth/saml/metadata`,
    acsUrl: `${base}/api/auth/saml/callback`,
    accounts: {
      pat: {
        name: 'Pat Example',
        email: 'pat@example.org',
        groups: ['writers'],
      },
      root: { name: 'Root', email: 'root@example.org', groups: ['admins'] },
    },
  });
  const t = await createTestApp({
    CCMS_SAML_IDP_METADATA_URL: mock.metadataUrl,
    CCMS_EDITOR_URL: `${base}/`,
    CCMS_SAML_NAME: 'Test SAML',
    ...settings,
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [
        {
          id: 'admin',
          name: 'Admin',
          permissions: ['admin.roles', 'content.read'],
          scope: {},
        },
        {
          id: 'author',
          name: 'Author',
          permissions: ['content.read', 'content.edit'],
          scope: {},
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          permissions: ['content.read'],
          scope: {},
        },
      ],
      users: [
        {
          id: 'first-admin',
          name: 'First admin',
          email: 'root@example.org',
          roles: ['admin'],
        },
      ],
      groupMappings: [
        { group: 'writers', role: 'author' },
        { group: 'reviewers', role: 'reviewer' },
      ],
    }),
  );
  await t.app.listen(port, '127.0.0.1');
  return {
    t,
    mock,
    base,
    close: async () => {
      await t.close();
      await mock.close();
    },
  };
}

/** The `name=value` of a `Set-Cookie` line, for a `Cookie` header. */
export const cookiePair = (line: string): string => line.split(';', 1)[0]!;

/** The `Set-Cookie` lines of a response. */
export const setCookies = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[] | undefined) ?? [];
