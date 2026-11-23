import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  attachment,
  downloadsSetup,
  withAttachments,
} from '../../../../tests/fakes/downloads.js';
import { manifest } from '../../../../tests/fakes/fake-content.js';
import { ForbiddenError } from '../../../base/core/errors.js';

const page = { number: 1, size: 100 };
const publicReader = actorWith(['content.read'], { maxAudience: 'public' });

const content = {
  modules: [
    withAttachments('datasheet', [
      attachment('sheet', 'sheet v1', { description: 'The data' }),
      attachment('declaration', 'declaration v1', {
        name: 'Declaration of conformity',
        fileName: 'conformity.pdf',
        mediaType: 'application/pdf',
      }),
    ]),
    withAttachments('datasheet', [attachment('sheet', 'Blatt v1')], {
      lang: 'de',
    }),
    withAttachments('wiring', [attachment('plan', 'wiring v1')], {
      audience: 'internal',
    }),
    withAttachments('lift-sheet', [attachment('lift', 'lift v1')], {
      products: ['lifts'],
    }),
  ],
  manifests: [
    manifest('operating', ['datasheet']),
    { ...manifest('service', ['wiring']), audience: 'internal' },
  ],
};

describe('ListDownloadsAction', () => {
  it('lists the attachments and done PDFs of each product’s latest release', async () => {
    const t = downloadsSetup(content);
    const old = t.release('1.0');
    t.output(old, 'operating', 'pdf old');
    const latest = t.release('2.0');
    t.output(latest, 'operating', 'pdf 2');
    t.output(latest, 'operating', 'pdf 2 de', { lang: 'de' });
    t.output(latest, 'service', 'service 2', { audience: 'internal' });
    t.output(latest, 'operating', '', {
      variant: 'model=large',
      state: 'rendering',
    });
    const lifts = t.release('7', content, {}, 'lifts');

    const found = await t.list.handle({ actor: READER, filter: {}, page });
    expect(found.items.map((d) => d.id)).toEqual([
      'attachment:lifts:datasheet:sheet:de',
      'attachment:lifts:datasheet:sheet:en',
      'attachment:lifts:datasheet:declaration:en',
      'attachment:lifts:lift-sheet:lift:en',
      'attachment:lifts:wiring:plan:en',
      'attachment:tuggers:datasheet:sheet:de',
      'attachment:tuggers:datasheet:sheet:en',
      'attachment:tuggers:datasheet:declaration:en',
      'attachment:tuggers:wiring:plan:en',
      'manual:tuggers:operating:de:model=small',
      'manual:tuggers:operating:en:model=small',
      'manual:tuggers:service:en:model=small',
    ]);
    expect(found.total).toBe(12);
    const sheet = found.items.find(
      (d) => d.id === 'attachment:tuggers:datasheet:sheet:en',
    );
    expect(sheet).toMatchObject({
      name: 'Name of sheet',
      description: 'The data',
      fileName: 'sheet.zip',
      mediaType: 'application/zip',
      size: 'sheet v1'.length,
      moduleTitle: 'Title of datasheet',
      release: { id: latest.id },
    });
    const pdf = found.items.find(
      (d) => d.id === 'manual:tuggers:operating:en:model=small',
    );
    expect(pdf).toMatchObject({
      name: 'Manual operating',
      fileName: 'operating_model-small_en_2.0.pdf',
      mediaType: 'application/pdf',
      description: null,
      moduleTitle: null,
    });
    expect(found.items.find((d) => d.key.product === 'lifts')?.release.id).toBe(
      lifts.id,
    );
  });

  it('never shows a lower-audience reader a file above it, in the list or the total', async () => {
    const t = downloadsSetup(content);
    const latest = t.release('1.0');
    t.output(latest, 'operating', 'pdf');
    t.output(latest, 'service', 'service', { audience: 'internal' });
    const found = await t.list.handle({
      actor: publicReader,
      filter: { product: 'tuggers' },
      page,
    });
    expect(found.items.map((d) => d.id)).toEqual([
      'attachment:tuggers:datasheet:sheet:de',
      'attachment:tuggers:datasheet:sheet:en',
      'attachment:tuggers:datasheet:declaration:en',
      'manual:tuggers:operating:en:model=small',
    ]);
    expect(found.total).toBe(4);
    // Asked for by name, it is not there either.
    const words = await t.list.handle({
      actor: publicReader,
      filter: { q: 'wiring' },
      page,
    });
    expect(words.total).toBe(0);
  });

  it('filters by language, kind, words and media type before paging', async () => {
    const t = downloadsSetup(content);
    const latest = t.release('1.0');
    t.output(latest, 'operating', 'pdf');
    const ids = async (filter: Parameters<typeof t.list.handle>[0]['filter']) =>
      (
        await t.list.handle({
          actor: READER,
          filter: { product: 'tuggers', ...filter },
          page,
        })
      ).items.map((d) => d.id);
    expect(await ids({ lang: 'de' })).toEqual([
      'attachment:tuggers:datasheet:sheet:de',
    ]);
    expect(await ids({ kind: 'manual' })).toEqual([
      'manual:tuggers:operating:en:model=small',
    ]);
    expect(await ids({ q: 'CONFORMITY' })).toEqual([
      'attachment:tuggers:datasheet:declaration:en',
    ]);
    expect(await ids({ mediaType: 'application/pdf' })).toEqual([
      'attachment:tuggers:datasheet:declaration:en',
      'manual:tuggers:operating:en:model=small',
    ]);
    expect(
      await ids({ mediaType: 'application/*', kind: 'attachment', lang: 'de' }),
    ).toEqual(['attachment:tuggers:datasheet:sheet:de']);
    const second = await t.list.handle({
      actor: READER,
      filter: { product: 'tuggers' },
      page: { number: 2, size: 2 },
    });
    expect(second.items.map((d) => d.id)).toEqual([
      'attachment:tuggers:datasheet:declaration:en',
      'attachment:tuggers:wiring:plan:en',
    ]);
    expect(second.total).toBe(5);
  });

  it('lists only PDFs: another kind of output, one without a manual (#59’s packages), is no manual download', async () => {
    const t = downloadsSetup(content);
    const latest = t.release('1.0');
    t.output(latest, 'operating', 'pdf');
    t.offlinePackage(latest, 'zip');
    t.offlinePackage(latest, 'zip', { lang: 'de' });
    for (const filter of [{ kind: 'manual' as const }, {}]) {
      const found = await t.list.handle({ actor: READER, filter, page });
      expect(
        found.items.filter((d) => d.key.kind === 'manual').map((d) => d.id),
      ).toEqual(['manual:tuggers:operating:en:model=small']);
      expect(found.items.some((d) => d.id.includes('*'))).toBe(false);
    }
  });

  it('takes the latest release that stands, and none for a product without one', async () => {
    const t = downloadsSetup(content);
    const first = t.release('1.0');
    t.release('2.0', content, {
      withdrawal: {
        by: { kind: 'user', id: 'p' },
        at: new Date(),
        reason: 'No',
      },
    });
    const found = await t.list.handle({ actor: READER, filter: {}, page });
    expect(new Set(found.items.map((d) => d.release.id))).toEqual(
      new Set([first.id]),
    );
    expect(
      (
        await t.list.handle({
          actor: READER,
          filter: { product: 'lifts' },
          page,
        })
      ).total,
    ).toBe(0);
  });

  it('needs content.read', async () => {
    const t = downloadsSetup(content);
    await expect(
      t.list.handle({ actor: actorWith([]), filter: {}, page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
