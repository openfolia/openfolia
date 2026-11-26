import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixtureRepo,
  FIXTURE_PRODUCTS,
  NEWEST_REVISION,
  OLDER_REVISIONS,
} from './fixture-repo.ts';

const API = join(import.meta.dirname, '..', '..', '..', 'backend', 'api');

/** The service tokens the fixture issues, one per way a portal token can be set up. */
export interface FixtureTokens {
  /** `content.read` up to `public`: what a public build takes. */
  readonly public: string;
  /** `content.read` up to `internal`. */
  readonly internal: string;
  /** `content.read` at every level (no `maxAudience`). */
  readonly everything: string;
  /** `content.read` and `content.read.draft`, up to `public`. */
  readonly drafts: string;
}

/** A branding the fixture sets (`PATCH /branding`): images as PNG bytes, colours `#rrggbb`. */
export interface FixtureBranding {
  readonly productName?: string;
  readonly logoLight?: Uint8Array;
  readonly logoDark?: Uint8Array;
  readonly favicon?: Uint8Array;
  readonly primary?: string;
}

export interface FixtureApi {
  readonly url: URL;
  readonly tokens: FixtureTokens;
  /** The release IDs, newest first: alpha's older ones (#896) last. */
  readonly releases: readonly string[];
  /** Sets the platform's branding (#784), as an administrator would; null: back to none. */
  brand(branding: FixtureBranding | null): Promise<void>;
}

const ADMIN = 'portal-admin';
/** The shared token, through which demo mode acts as the user `X-Ccms-User` names. */
const SHARED_TOKEN = 'portal-fixture-0123456789abcdef0123456789abcdef';

/**
 * Runs `use` against the built API (`api:build`), booted in this process over the fixture
 * repository (`fixture-repo.ts`) and an in-memory database, listening on a loopback port the
 * system picks: alpha's older releases and a newest release per product (#896), cut by an admin from
 * older and newer content, and the service accounts and tokens of
 * `FixtureTokens`. No job runs (no PDF is rendered). Everything is removed afterwards.
 */
export async function withFixtureApi<T>(
  use: (api: FixtureApi) => Promise<T>,
): Promise<T> {
  const { withInProcessApi, importBuilt } = (await import(
    pathToFileURL(join(API, 'scripts', 'in-process-api.mjs')).href
  )) as {
    withInProcessApi: <R>(
      use: (app: NestApp) => Promise<R>,
      options: {
        contentDir: string;
        env: Record<string, string>;
        serve: boolean;
      },
    ) => Promise<R>;
    importBuilt: (path: string) => Promise<Record<string, unknown>>;
  };
  const repo = createFixtureRepo();
  try {
    return await withInProcessApi(
      async (app) => {
        const { Database } = await importBuilt('database/database.js');
        const { seedAccess } = await importBuilt('access/repos/seed.js');
        const reader = (
          id: string,
          permissions: string[],
          maxAudience?: string,
        ) => ({
          id,
          name: id,
          permissions,
          scope: maxAudience === undefined ? {} : { maxAudience },
        });
        await (seedAccess as (db: unknown, seed: unknown) => Promise<void>)(
          app.get(Database),
          {
            roles: [
              {
                id: 'admin',
                name: 'Admin',
                permissions: [
                  'content.read',
                  'content.read.draft',
                  'release.publish',
                  'admin.roles',
                  'admin.branding',
                ],
                scope: {},
              },
              reader('read-public', ['content.read'], 'public'),
              reader('read-internal', ['content.read'], 'internal'),
              reader('read-everything', ['content.read']),
              reader(
                'read-drafts',
                ['content.read', 'content.read.draft'],
                'public',
              ),
            ],
            users: [{ id: ADMIN, name: 'Portal admin', roles: ['admin'] }],
          },
        );
        await app.listen(0, '127.0.0.1');
        const { port } = app.getHttpServer().address() as AddressInfo;
        const url = new URL(`http://127.0.0.1:${port}/`);
        const post = async (path: string, body: unknown) => {
          const response = await fetch(new URL(path.slice(1), url), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/vnd.api+json',
              Accept: 'application/vnd.api+json',
              Authorization: `Bearer ${SHARED_TOKEN}`,
              'X-Ccms-User': ADMIN,
            },
            body: JSON.stringify(body),
          });
          const json = (await response.json()) as Record<string, unknown>;
          if (!response.ok)
            throw new Error(
              `${path}: ${response.status} ${JSON.stringify(json)}`,
            );
          return json as { data: { id: string }; meta: { token: string } };
        };
        const token = async (role: string) => {
          await post('/service-accounts', {
            data: {
              type: 'ServiceAccount',
              id: `portal-${role}`,
              attributes: { name: `Portal ${role}` },
              relationships: { roles: { data: [{ type: 'Role', id: role }] } },
            },
          });
          return (
            await post(`/service-accounts/portal-${role}/tokens`, {
              data: {
                type: 'ServiceToken',
                attributes: { name: 'portal build' },
              },
            })
          ).meta.token;
        };
        const asAdmin = {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${SHARED_TOKEN}`,
          'X-Ccms-User': ADMIN,
          'X-Ccms-Request': '1',
        };
        const upload = async (bytes: Uint8Array) => {
          const form = new FormData();
          form.append(
            'file',
            new Blob([bytes as BlobPart], { type: 'image/png' }),
            'image.png',
          );
          const response = await fetch(new URL('branding/images', url), {
            method: 'POST',
            headers: asAdmin,
            body: form,
          });
          if (!response.ok)
            throw new Error(`/branding/images: ${response.status}`);
          const json = (await response.json()) as {
            data: { attributes: { reference: string } };
          };
          return json.data.attributes.reference;
        };
        const brand = async (branding: FixtureBranding | null) => {
          const b = branding ?? {};
          const image = async (bytes: Uint8Array | undefined) =>
            bytes === undefined ? null : await upload(bytes);
          const response = await fetch(new URL('branding', url), {
            method: 'PATCH',
            headers: {
              ...asAdmin,
              'Content-Type': 'application/vnd.api+json',
            },
            body: JSON.stringify({
              data: {
                type: 'Branding',
                id: 'branding',
                attributes: {
                  productName: b.productName ?? null,
                  logoLight: await image(b.logoLight),
                  logoDark: await image(b.logoDark),
                  favicon: await image(b.favicon),
                  primary: b.primary ?? null,
                },
              },
            }),
          });
          if (!response.ok)
            throw new Error(
              `/branding: ${response.status} ${await response.text()}`,
            );
        };
        const releases: string[] = [];
        const cut = async (product: string, revision: string, notes: string) =>
          releases.unshift(
            (
              await post('/releases', {
                data: {
                  type: 'Release',
                  attributes: { product, revision, notes },
                },
              })
            ).data.id,
          );
        for (const revision of OLDER_REVISIONS)
          await cut('alpha', revision, `Release ${revision} of alpha.`);
        repo.advance();
        for (const product of FIXTURE_PRODUCTS)
          await cut(
            product,
            NEWEST_REVISION,
            `Release ${NEWEST_REVISION} of ${product}.`,
          );
        repo.edit();
        return await use({
          url,
          releases,
          brand,
          tokens: {
            public: await token('read-public'),
            internal: await token('read-internal'),
            everything: await token('read-everything'),
            drafts: await token('read-drafts'),
          },
        });
      },
      {
        contentDir: repo.dir,
        serve: true,
        env: {
          CCMS_AUTH_MODE: 'demo',
          CCMS_API_TOKEN: SHARED_TOKEN,
          CCMS_JOBS_POLL_MS: '0',
          CCMS_DEFAULT_REF: 'main',
        },
      },
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

interface NestApp {
  get(token: unknown): unknown;
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): { address(): unknown };
}
