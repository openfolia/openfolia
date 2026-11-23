import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import { StableAddressPageDocument } from '../src/addresses/api/stable-address.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders a release's PDFs, and the checks render the manual's.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

/**
 * The operator's cap on `delivery.access` (`CCMS_DELIVERY_MAX_ACCESS`, #553) and the checks
 * of the addresses: an app of its own, since the cap is the deployment's setting.
 */
const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};
const reviewer = actorWith(['content.read', 'content.read.draft']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp({
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
    CCMS_DELIVERY_MAX_ACCESS: 'signed-in',
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const original = { config: '' };
/** The configuration on main with `delivery` set to `yaml` (indented lines). */
const delivery = async (yaml: string) => {
  if (original.config === '')
    original.config = git('show', 'main:openfolia.yaml');
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content: `${original.config.trimEnd()}\ndelivery:\n${yaml}\n`,
      },
    ],
    message: 'Delivery settings',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
};

const checkCodes = async (manual: string) => {
  t.actAs(reviewer);
  const res = await t.get(`/manuals/${manual}/checks?page[size]=200`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body).data.map((c) => c.attributes);
};

describe('stable addresses capped by the operator (#553)', () => {
  it('keeps a public project for signed-in readers, and its checks say why', async () => {
    await delivery('  access: public\n  pdfQrCode: back-cover');
    t.actAs(publisher);
    const cut = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.0' },
        },
      }),
    );
    expect(cut.status).toBe(201);
    t.actAs(undefined);
    await t.runJobs();

    const path = '/d/north/operating/model=large/en';
    const anonymous = await t.anonymous().get(path).set('Accept', '*/*');
    expect(anonymous.status).toBe(401);
    t.actAs(READER);
    expect((await t.get(path).set('Accept', '*/*')).status).toBe(200);
    const listed = StableAddressPageDocument.parse(
      (await t.get('/stable-addresses')).body,
    );
    expect(listed.meta.access).toBe('signed-in');

    const capped = (await checkCodes('operating')).filter(
      (c) => c.code === 'delivery-access-capped',
    );
    expect(capped).toEqual([
      expect.objectContaining({
        severity: 'warning',
        params: { access: 'public', maxAccess: 'signed-in' },
      }),
    ]);
  });

  it('reports a former address that is another manual’s ID', async () => {
    await delivery('  manuals:\n    operating: { formerly: [service] }');
    const taken = (await checkCodes('operating')).filter(
      (c) => c.code === 'address-taken',
    );
    expect(taken).toEqual([
      expect.objectContaining({
        severity: 'blocking',
        params: { address: 'service', manual: 'service', as: 'formerly' },
      }),
    ]);
    expect(
      (await checkCodes('service')).filter((c) => c.code === 'address-taken'),
    ).toEqual([
      expect.objectContaining({
        params: { address: 'service', manual: 'operating', as: 'formerly' },
      }),
    ]);
  });
});
