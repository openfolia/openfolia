import { type DeliveryAccess, ProjectConfig } from '@openfolia/content-model';
import { actorWith, NOBODY, READER } from '../../../tests/fakes/actors.js';
import { addressSettings } from '../../../tests/fakes/fake-address-settings.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import {
  config as baseConfig,
  manifest,
  module,
} from '../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../tests/fakes/fake-history.js';
import { FakeReleaseOutputStore } from '../../../tests/fakes/fake-release-output-store.js';
import { FakeReleaseStore } from '../../../tests/fakes/fake-release-store.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/core/errors.js';
import { newReleaseId, type Release } from '../../releases/core/release.js';
import { releaseQrCode } from '../../releases/core/actions/plan-release-outputs.action.js';
import { newOutputId } from '../../releases/core/release-output.js';
import { ListStableAddressesAction } from './actions/list-stable-addresses.action.js';
import {
  type FoundAddress,
  OpenStableAddressAction,
  StableAddressAccessAction,
  StableAddressPdfAction,
} from './actions/open-stable-address.action.js';
import {
  absoluteUrl,
  addressPath,
  deliveryAccess,
  ignoredParameter,
  parseAddress,
  publicReader,
  type StableAddress,
  withoutIgnored,
} from './stable-address.js';

const config = (delivery: Record<string, unknown> = {}) =>
  ProjectConfig.parse({
    ...baseConfig,
    languages: { source: 'en', targets: ['de', 'fr'] },
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'internal', label: 'Internal' },
    ],
    facets: [
      {
        id: 'region',
        label: 'Region',
        product: true,
        values: [
          { id: 'north', label: 'North' },
          { id: 'south', label: 'South' },
        ],
      },
    ],
    delivery,
  });

const content = (delivery: Record<string, unknown> = {}, text = 'Hello.') => ({
  config: config(delivery),
  modules: ['a'].flatMap((id) => [
    module(id, 'en', text),
    module(id, 'de', text),
  ]),
  manifests: [
    manifest('guide', ['a']),
    { ...manifest('staff', ['a']), audience: 'internal' },
  ],
});

function setup() {
  const history = new FakeHistory(content());
  const releases = new FakeReleaseStore();
  const outputs = new FakeReleaseOutputStore();
  const blobs = new FakeBlobStore();
  const unit = new FakeUnitOfWork();
  // Mutable, so a test can set the operator's cap.
  const settings = {
    ...addressSettings(),
    maxAccess: 'public' as DeliveryAccess,
  };
  const access = new StableAddressAccessAction(history.openSnapshot, settings);
  const open = new OpenStableAddressAction(releases, history.openSnapshot);
  let at = Date.parse('2026-03-01T10:00:00Z');
  const release = async (
    product: string,
    revision: string,
    text = 'Hello.',
  ): Promise<Release> => {
    const commit = history.onMain(content({}, text)).commit;
    const tag = `release/${product}/${revision}`;
    history.tag(tag, commit);
    at += 1000;
    const r: Release = {
      id: newReleaseId(at),
      product,
      productFacet: 'region',
      revision,
      tag,
      tagObject: 'e'.repeat(40),
      commit,
      notes: null,
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: new Date(at),
      withdrawal: null,
    };
    releases.rows.push(r);
    // Every manual, variant and language, done.
    const rows = ['guide', 'staff'].flatMap((manualId) =>
      ['model=large', 'model=small'].flatMap((variant) =>
        ['de', 'en', 'fr'].map((lang) => {
          const id = newOutputId();
          return {
            id,
            releaseId: r.id,
            manualId,
            variant,
            lang,
            kind: 'pdf' as const,
            audience: manualId === 'staff' ? 'internal' : 'public',
            state: 'queued' as const,
            sha256: null,
            size: null,
            reusedFrom: null,
            reuseGroup: id,
            qrCode: null,
          };
        }),
      ),
    );
    await unit.run((tx) => outputs.insertMissing(tx, rows));
    return r;
  };
  /** Sets main's delivery configuration (where access and slugs are read). */
  const deliver = (delivery: Record<string, unknown>) =>
    history.onMain(content(delivery));
  return {
    history,
    releases,
    outputs,
    blobs,
    settings,
    access,
    open,
    release,
    deliver,
    pdf: new StableAddressPdfAction(outputs, blobs),
    list: new ListStableAddressesAction(
      releases,
      outputs,
      history.openSnapshot,
      access,
      settings,
    ),
    openAs: async (
      actor: typeof READER,
      path: Omit<StableAddress, 'product'> & { product?: string },
    ) =>
      open.handle({
        actor,
        address: { product: 'north', ...path },
        config: await access.mainConfig(),
      }),
  };
}

const at = (
  slug: string,
  variant: string,
  lang: string,
  revision?: string,
) => ({
  slug,
  variant,
  lang,
  ...(revision !== undefined && { revision }),
});

describe('stable address paths', () => {
  it('writes and reads an address, pinned or not, and refuses what no address can be', () => {
    const pinned = {
      product: 'north',
      slug: 'guide',
      variant: 'model=large,software=2.3',
      lang: 'en',
      revision: '2.1',
    };
    expect(addressPath(pinned)).toBe(
      '/d/north/guide/model=large,software=2.3/en@2.1',
    );
    expect(addressPath({ ...pinned, revision: undefined }, 'pdf')).toBe(
      '/d/north/guide/model=large,software=2.3/en/pdf',
    );
    expect(
      parseAddress({
        product: 'north',
        manual: 'guide',
        variant: 'model=large',
        lang: 'en@2.1',
      }),
    ).toEqual({
      product: 'north',
      slug: 'guide',
      variant: 'model=large',
      lang: 'en',
      revision: '2.1',
    });
    for (const bad of [
      { product: 'North!', manual: 'guide', variant: 'v', lang: 'en' },
      { product: 'north', manual: '../x', variant: 'v', lang: 'en' },
      { product: 'north', manual: 'guide', variant: '', lang: 'en' },
      { product: 'north', manual: 'guide', variant: 'v', lang: 'e n' },
      { product: 'north', manual: 'guide', variant: 'v', lang: 'en@..' },
    ]) {
      expect(parseAddress(bad)).toBeUndefined();
    }
    expect(
      absoluteUrl({ publicUrl: 'https://docs.example.com/m/' }, '/d/north/x'),
    ).toBe('https://docs.example.com/m/d/north/x');
    expect(absoluteUrl({ publicUrl: undefined }, '/d/north/x')).toBeUndefined();
  });

  it('reads public content as the public audience only, with nothing but content.read', () => {
    const reader = publicReader(config({ publicAudience: 'public' }));
    expect(reader.roles).toEqual([
      expect.objectContaining({
        permissions: ['content.read'],
        scope: { maxAudience: 'public' },
      }),
    ]);
    // By default the first audience, the least restricted.
    expect(publicReader(config()).roles[0]?.scope).toEqual({
      maxAudience: 'public',
    });
  });
});

describe('the operator’s cap and ignored parameters (#553)', () => {
  it('serves delivery.access at most at the cap', () => {
    const cases: [DeliveryAccess, DeliveryAccess, DeliveryAccess][] = [
      ['public', 'public', 'public'],
      ['public', 'signed-in', 'signed-in'],
      ['public', 'off', 'off'],
      ['signed-in', 'public', 'signed-in'],
      ['signed-in', 'signed-in', 'signed-in'],
      ['signed-in', 'off', 'off'],
      ['off', 'public', 'off'],
      ['off', 'signed-in', 'off'],
    ];
    for (const [asked, cap, served] of cases) {
      expect(
        deliveryAccess(config({ access: asked }), { maxAccess: cap }),
      ).toBe(served);
    }
  });

  it('never prints a public QR code for a capped project', () => {
    const output = { manualId: 'guide', variant: 'model=large', lang: 'en' };
    const asked = config({ access: 'public', pdfQrCode: 'back-cover' });
    const publicUrl = 'https://docs.example.com/';
    expect(
      releaseQrCode(
        addressSettings({ publicUrl }),
        { product: 'north' },
        output,
        asked,
      ),
    ).toEqual({
      url: 'https://docs.example.com/d/north/guide/model=large/en',
      placement: 'back-cover',
    });
    expect(
      releaseQrCode(
        addressSettings({ publicUrl, maxAccess: 'signed-in' }),
        { product: 'north' },
        output,
        asked,
      ),
    ).toBeNull();
  });

  it('matches a parameter by name or by prefix, case and all', () => {
    const patterns = ['utm_*', 'click_ref'];
    expect(ignoredParameter('utm_source', patterns)).toBe(true);
    expect(ignoredParameter('utm_', patterns)).toBe(true);
    expect(ignoredParameter('click_ref', patterns)).toBe(true);
    expect(ignoredParameter('click_refs', patterns)).toBe(false);
    expect(ignoredParameter('UTM_source', patterns)).toBe(false);
    expect(ignoredParameter('theme', patterns)).toBe(false);
    expect(ignoredParameter('utm_source', [])).toBe(false);
  });

  it('drops only the ignored parameters, keeps the route’s own and the rest as sent', () => {
    const patterns = ['utm_*', 'click_ref', 't*'];
    const keep = new Set(['theme']);
    expect(withoutIgnored('utm_source=x&click_ref=y', patterns, keep)).toBe('');
    expect(
      withoutIgnored(
        'utm_source=x&theme=dark&page%5Bx%5D=1&a=%E2%82%AC',
        patterns,
        keep,
      ),
    ).toBe('theme=dark&page%5Bx%5D=1&a=%E2%82%AC');
    // Encoded names are matched decoded; one that cannot be decoded stays (and is refused later).
    expect(withoutIgnored('utm%5Fsource=x&bad%E0=1', patterns, keep)).toBe(
      'bad%E0=1',
    );
    expect(withoutIgnored('trace=1', patterns, keep)).toBe('');
    expect(withoutIgnored('utm_source=x', [], keep)).toBe('utm_source=x');
    // Nothing ignored: exactly as sent, empty parts too.
    expect(withoutIgnored('a=1&&b', patterns, keep)).toBe('a=1&&b');
    expect(withoutIgnored('utm_source', patterns, keep)).toBe('');
    expect(withoutIgnored('', patterns, keep)).toBe('');
  });
});

describe('StableAddressAccessAction', () => {
  it('is never more open than the operator’s cap', async () => {
    const t = setup();
    t.deliver({ access: 'public' });
    t.settings.maxAccess = 'signed-in';
    const capped = await t.access.handle({ actor: undefined });
    expect(capped.access).toBe('signed-in');
    expect(capped.reader).toBeUndefined();
    // A reader with a token still reads.
    expect((await t.access.handle({ actor: READER })).reader).toBe(READER);
    await t.release('north', '1.0');
    t.deliver({ access: 'public' });
    const listed = await t.list.handle({
      actor: READER,
      filter: {},
      page: { number: 1, size: 1 },
    });
    expect(listed.access).toBe('signed-in');
    t.settings.maxAccess = 'off';
    await expect(t.access.handle({ actor: READER })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('needs a token by default, reads as the public reader when public, and is off for everyone', async () => {
    const t = setup();
    expect(
      (await t.access.handle({ actor: undefined })).reader,
    ).toBeUndefined();
    expect((await t.access.handle({ actor: READER })).reader).toBe(READER);
    t.deliver({ access: 'public' });
    const { reader } = await t.access.handle({ actor: undefined });
    expect(reader?.id).toBe('service:public-reader');
    t.deliver({ access: 'off' });
    await expect(t.access.handle({ actor: READER })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('reads a public address as the public reader whoever asks, and says it answers everyone (#608)', async () => {
    const t = setup();
    expect(await t.access.answersEveryone()).toBe(false);
    t.deliver({ access: 'public' });
    expect(await t.access.answersEveryone()).toBe(true);
    const { reader } = await t.access.handle({ actor: READER });
    expect(reader?.id).toBe('service:public-reader');
    // Capped below public by the operator: no longer everyone's.
    t.settings.maxAccess = 'signed-in';
    expect(await t.access.answersEveryone()).toBe(false);
    expect((await t.access.handle({ actor: READER })).reader).toBe(READER);
    t.deliver({ access: 'off' });
    expect(await t.access.answersEveryone()).toBe(false);
    await expect(t.access.handle({ actor: READER })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('OpenStableAddressAction', () => {
  it('opens the latest release, or the pinned one, at its tag', async () => {
    const t = setup();
    await expect(
      t.openAs(READER, at('guide', 'model=large', 'en')),
    ).rejects.toThrow(NotFoundError);
    const one = await t.release('north', '1.0', 'One.');
    const two = await t.release('north', '2.0', 'Two.');
    await t.release('south', '9.0');
    const latest = (await t.openAs(
      READER,
      at('guide', 'model=large', 'en'),
    )) as FoundAddress;
    expect(latest).toMatchObject({
      kind: 'found',
      release: { id: two.id },
      manualId: 'guide',
      pinned: { revision: '2.0' },
    });
    expect(latest.content.commit).toBe(two.commit);
    expect(
      await t.openAs(READER, at('guide', 'model=large', 'en', '1.0')),
    ).toMatchObject({ kind: 'found', release: { id: one.id } });
    // A revision of another product, a variant the manifest has not: not found.
    await expect(
      t.openAs(READER, at('guide', 'model=large', 'en', '9.0')),
    ).rejects.toThrow(NotFoundError);
    await expect(
      t.openAs(READER, at('guide', 'model=huge', 'en')),
    ).rejects.toThrow(NotFoundError);
    // Without content.read: refused before anything is read.
    await expect(
      t.openAs(NOBODY, at('guide', 'model=large', 'en')),
    ).rejects.toThrow(ForbiddenError);
  });

  it('finds what the reader may not see nowhere: no page, no move, no picker', async () => {
    const t = setup();
    await t.release('north', '1.0');
    const outside = actorWith(['content.read'], { maxAudience: 'public' });
    t.deliver({ manuals: { staff: { slug: 'team' } } });
    for (const address of [
      at('staff', 'model=large', 'en'),
      at('team', 'model=large', 'en'),
      at('team', 'model=large', 'EN'),
      at('team', 'model=large', 'es'),
    ]) {
      await expect(t.openAs(outside, address)).rejects.toThrow(NotFoundError);
    }
    // The reader who may: moved, by its slug.
    expect(await t.openAs(READER, at('staff', 'model=large', 'en'))).toEqual({
      kind: 'moved',
      to: {
        product: 'north',
        slug: 'team',
        variant: 'model=large',
        lang: 'en',
      },
    });
    // A language only for some: the picker lists what the reader may read.
    const german = actorWith(['content.read'], { languages: ['de'] });
    expect(
      await t.openAs(german, at('guide', 'model=large', 'es')),
    ).toMatchObject({
      kind: 'picker',
      languages: [expect.objectContaining({ lang: 'de' })],
    });
  });

  it('shows a withdrawn pinned release as such, the latest one before it', async () => {
    const t = setup();
    await t.release('north', '1.0');
    const two = await t.release('north', '2.0');
    const unit = new FakeUnitOfWork();
    await unit.run((tx) =>
      t.releases.withdraw(tx, two.id, {
        by: { kind: 'user', id: 'sample-publisher' },
        at: new Date(),
        reason: 'Wrong.',
      }),
    );
    expect(
      await t.openAs(READER, at('guide', 'model=large', 'de', '2.0')),
    ).toMatchObject({
      kind: 'withdrawn',
      latest: { slug: 'guide', lang: 'de' },
    });
    const withdrawn = await t.openAs(
      READER,
      at('guide', 'model=large', 'de', '2.0'),
    );
    expect(
      withdrawn.kind === 'withdrawn' && withdrawn.latest,
    ).not.toHaveProperty('revision');
    expect(
      await t.openAs(READER, at('guide', 'model=large', 'de')),
    ).toMatchObject({ kind: 'found', pinned: { revision: '1.0' } });
  });
});

describe('StableAddressPdfAction', () => {
  it('serves the release’s file once done, to a reader of all of the manual', async () => {
    const t = setup();
    await t.release('north', '1.0');
    const found = (await t.openAs(
      READER,
      at('guide', 'model=large', 'en'),
    )) as FoundAddress;
    await expect(t.pdf.handle({ actor: READER, found })).rejects.toThrow(
      ConflictError,
    );
    const output = await t.outputs.findOf(found.release.id, {
      manualId: 'guide',
      variant: 'model=large',
      lang: 'en',
      kind: 'pdf',
    });
    if (!output) throw new Error('no output');
    const { sha256 } = await t.blobs.put(
      (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
      { contentType: 'application/pdf', maxBytes: 10 },
    );
    await t.outputs.finish(output.id, { sha256, size: 3 });
    const file = await t.pdf.handle({ actor: READER, found });
    expect(file.output.id).toBe(output.id);
    // A reader whose scope leaves module types out may not have it.
    const partial = actorWith(['content.read'], { moduleTypes: ['concept'] });
    const theirs = (await t.openAs(
      partial,
      at('guide', 'model=large', 'en'),
    )) as FoundAddress;
    await expect(
      t.pdf.handle({ actor: partial, found: theirs }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('ListStableAddressesAction', () => {
  it('lists each product’s latest release’s addresses the reader may read, paged across them', async () => {
    const t = setup();
    await t.release('north', '1.0');
    const north = await t.release('north', '2.0');
    const south = await t.release('south', '1.0');
    const outside = actorWith(['content.read'], { maxAudience: 'public' });
    const all = await t.list.handle({
      actor: outside,
      filter: {},
      page: { number: 1, size: 100 },
    });
    // guide only (staff is internal): 2 variants × 3 languages, per product.
    expect(all.total).toBe(12);
    expect(all.items.map((i) => i.release.id)).toEqual([
      ...Array<string>(6).fill(north.id),
      ...Array<string>(6).fill(south.id),
    ]);
    expect(all.items.every((i) => i.output.manualId === 'guide')).toBe(true);
    expect(all.items.every((i) => i.latest)).toBe(true);
    // A page that spans both releases holds exactly the rows a full list has there.
    for (const size of [1, 4, 5, 7]) {
      for (let number = 1; number <= Math.ceil(12 / size); number++) {
        const page = await t.list.handle({
          actor: outside,
          filter: {},
          page: { number, size },
        });
        expect(page.items.map((i) => i.output.id)).toEqual(
          all.items
            .slice((number - 1) * size, number * size)
            .map((i) => i.output.id),
        );
      }
    }
    const one = await t.list.handle({
      actor: READER,
      filter: {
        release: (await t.releases.findByRevision('north', '1.0'))?.id ?? '',
        lang: 'de',
      },
      page: { number: 1, size: 100 },
    });
    expect(one.total).toBe(4);
    expect(one.items.every((i) => !i.latest)).toBe(true);
    expect(one.items[0]?.pinned.revision).toBe('1.0');
    await expect(
      t.list.handle({
        actor: READER,
        filter: { release: newReleaseId() },
        page: { number: 1, size: 10 },
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
