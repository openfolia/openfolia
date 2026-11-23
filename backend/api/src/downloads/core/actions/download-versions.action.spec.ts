import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  attachment,
  downloadsSetup,
  sha256,
  withAttachments,
} from '../../../../tests/fakes/downloads.js';
import { manifest } from '../../../../tests/fakes/fake-content.js';
import { NotFoundError } from '../../../base/core/errors.js';

const page = { number: 1, size: 100 };
const publicReader = actorWith(['content.read'], { maxAudience: 'public' });
const SHEET = 'attachment:tuggers:datasheet:sheet:en';
const PDF = 'manual:tuggers:operating:en:model=small';

const sheet = (
  bytes: string,
  audience = 'public',
  description = 'The data',
) => ({
  modules: [
    withAttachments(
      'datasheet',
      [attachment('sheet', bytes, { description })],
      {
        audience,
      },
    ),
  ],
  manifests: [manifest('operating', ['datasheet'])],
});

describe('DownloadVersionsAction', () => {
  it('lists an attachment replaced between two releases as two versions, the older superseded', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0', sheet('v1', 'public', 'First'));
    const r2 = t.release('1.1', sheet('v1', 'public', 'First'));
    const r3 = t.release('2.0', sheet('v2', 'public', 'Second'), {
      notesByLanguage: { de: 'Neu' },
    });
    const found = await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(
      found.items.map((v) => ({
        release: v.release.id,
        state: v.state,
        sha256: v.sha256,
        notes: v.notes,
        description: v.description,
        at: v.release.publishedAt,
      })),
    ).toEqual([
      {
        release: r3.id,
        state: 'current',
        sha256: sha256('v2'),
        notes: 'Notes of 2.0',
        description: 'Second',
        at: r3.publishedAt,
      },
      {
        release: r1.id,
        state: 'superseded',
        sha256: sha256('v1'),
        notes: 'Notes of 1.0',
        description: 'First',
        at: r1.publishedAt,
      },
    ]);
    expect(found.total).toBe(2);
    expect(found.truncated).toBe(false);
    expect(r2.id).not.toBe(r1.id);
  });

  it('marks a version only a withdrawn release held as withdrawn', async () => {
    const t = downloadsSetup(sheet('v1'));
    t.release('1.0', sheet('v1'));
    t.release('2.0', sheet('v2'), {
      withdrawal: {
        by: { kind: 'user', id: 'p' },
        at: new Date(),
        reason: 'Wrong file',
      },
    });
    const found = await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(found.items.map((v) => [v.release.revision, v.state])).toEqual([
      ['2.0', 'withdrawn'],
      ['1.0', 'current'],
    ]);
  });

  it('never shows a lower-audience reader a version above it, nor a download only above it', async () => {
    const t = downloadsSetup(sheet('v1'));
    t.release('1.0', sheet('v1', 'internal'));
    t.release('2.0', sheet('v2', 'public'));
    t.release('3.0', sheet('v3', 'internal'));
    t.release('4.0', sheet('v4', 'public'));
    const seen = await t.versions.handle({
      actor: publicReader,
      id: SHEET,
      page,
    });
    expect(seen.items.map((v) => [v.release.revision, v.state])).toEqual([
      ['4.0', 'current'],
      ['2.0', 'superseded'],
    ]);
    expect(seen.total).toBe(2);
    // Above them at the latest release (#764): as if there were no such download.
    t.release('5.0', sheet('v5', 'internal'));
    await expect(
      t.versions.handle({ actor: publicReader, id: SHEET, page }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await t.versions.handle({ actor: READER, id: SHEET, page })).total,
    ).toBe(5);
    // Everything of it above them: as if there were no such download.
    const hidden = downloadsSetup(sheet('v1'));
    hidden.release('1.0', sheet('v1', 'internal'));
    await expect(
      hidden.versions.handle({ actor: publicReader, id: SHEET, page }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      hidden.versions.handle({ actor: READER, id: SHEET, page }),
    ).resolves.toMatchObject({ total: 1 });
  });

  it('lists a manual’s PDF by its hash: a reused file is one version', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0');
    const r2 = t.release('1.1');
    const r3 = t.release('2.0');
    t.output(r1, 'operating', 'pdf a');
    t.output(r2, 'operating', 'pdf a');
    t.output(r3, 'operating', 'pdf b');
    const found = await t.versions.handle({ actor: READER, id: PDF, page });
    expect(
      found.items.map((v) => [
        v.release.revision,
        v.state,
        v.sha256,
        v.fileName,
      ]),
    ).toEqual([
      ['2.0', 'current', sha256('pdf b'), 'operating_model-small_en_2.0.pdf'],
      [
        '1.0',
        'superseded',
        sha256('pdf a'),
        'operating_model-small_en_1.0.pdf',
      ],
    ]);
    // A manual the reader may not read whole: none of its PDFs.
    const internal = downloadsSetup({
      ...sheet('v1'),
      manifests: [
        { ...manifest('operating', ['datasheet']), audience: 'internal' },
      ],
    });
    const r = internal.release('1.0');
    internal.output(r, 'operating', 'pdf', { audience: 'internal' });
    await expect(
      internal.versions.handle({ actor: publicReader, id: PDF, page }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('has no versions for an offline package (#59): no download ID names one', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0');
    t.output(r1, 'operating', 'pdf a');
    t.offlinePackage(r1, 'zip');
    const mainLine = vi.spyOn(t.store, 'mainLine');
    const atEach = vi.spyOn(t.history, 'atEach');
    await expect(
      t.versions.handle({
        actor: READER,
        id: 'manual:tuggers:*:en:public',
        page,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Refused by its ID: no release, tag or output is asked for.
    expect(mainLine).not.toHaveBeenCalled();
    expect(atEach).not.toHaveBeenCalled();
    const found = await t.versions.handle({ actor: READER, id: PDF, page });
    expect(found.items.map((v) => v.sha256)).toEqual([sha256('pdf a')]);
  });

  it('keeps what a tag holds: a later read opens only the tags of new releases', async () => {
    const t = downloadsSetup(sheet('v1'));
    t.release('1.0', sheet('v1'));
    t.release('2.0', sheet('v2'));
    const open = vi.spyOn(t.history, 'at');
    await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(open).toHaveBeenCalledTimes(2);
    await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(open).toHaveBeenCalledTimes(2);
    t.release('3.0', sheet('v3'));
    const found = await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(open).toHaveBeenCalledTimes(3);
    expect(found.items.map((v) => v.release.revision)).toEqual([
      '3.0',
      '2.0',
      '1.0',
    ]);
    // Another reading key reads for itself.
    await t.versions.handle({ actor: publicReader, id: SHEET, page });
    expect(open).toHaveBeenCalledTimes(6);
  });

  it('keeps a PDF only once it is done', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0');
    const pending = t.output(r1, 'operating', 'pdf a', { state: 'rendering' });
    await expect(
      t.versions.handle({ actor: READER, id: PDF, page }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const index = t.outputs.rows.indexOf(pending);
    t.outputs.rows[index] = {
      ...pending,
      state: 'done',
      sha256: sha256('pdf a'),
      size: 5,
    };
    const found = await t.versions.handle({ actor: READER, id: PDF, page });
    expect(found.items.map((v) => v.release.revision)).toEqual(['1.0']);
  });

  it('is 404 for a download the latest release does not hold, reading no other tag and keeping nothing (#764)', async () => {
    const t = downloadsSetup(sheet('v1'));
    for (const revision of ['1.0', '1.1', '1.2', '1.3']) {
      t.release(revision, sheet(`v${revision}`));
    }
    // Gone from the latest release: no history to show, as the list shows none.
    const latest = t.release('2.0', { modules: [], manifests: [] });
    const at = vi.spyOn(t.history, 'at');
    const atEach = vi.spyOn(t.history, 'atEach');
    for (const id of [
      SHEET,
      'attachment:tuggers:datasheet:other:en',
      'attachment:tuggers:nothing:sheet:en',
      PDF,
    ]) {
      at.mockClear();
      atEach.mockClear();
      await expect(
        t.versions.handle({ actor: READER, id, page }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // An attachment: the latest release's tag alone, in one call; a PDF not rendered there: none.
      const tags = id === PDF ? [] : [[`refs/tags/${latest.tag}`]];
      expect([id, atEach.mock.calls.map(([refs]) => [...refs])]).toEqual([
        id,
        tags,
      ]);
      expect(at).toHaveBeenCalledTimes(tags.length);
    }
    // Malformed: not even the releases are asked for.
    const mainLine = vi.spyOn(t.store, 'mainLine');
    await expect(
      t.versions.handle({ actor: READER, id: 'attachment:x', page }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mainLine).not.toHaveBeenCalled();
    expect(t.observations.size).toBe(0);
  });

  it('reads every release’s tag in one call, the latest first', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0', sheet('v1'));
    const r2 = t.release('1.1', sheet('v2'));
    const r3 = t.release('2.0', sheet('v2'));
    const atEach = vi.spyOn(t.history, 'atEach');
    const found = await t.versions.handle({ actor: READER, id: SHEET, page });
    expect(found.items.map((v) => v.release.revision)).toEqual(['1.1', '1.0']);
    expect(atEach.mock.calls.map(([refs]) => [...refs])).toEqual([
      [`refs/tags/${r3.tag}`],
      [`refs/tags/${r2.tag}`, `refs/tags/${r1.tag}`],
    ]);
    expect(t.observations.size).toBe(1);
  });

  it('is 404 for an ID that names no download', async () => {
    const t = downloadsSetup(sheet('v1'));
    t.release('1.0');
    for (const id of [
      'nope',
      'attachment:tuggers:datasheet:other:en',
      'attachment:lifts:datasheet:sheet:en',
    ]) {
      await expect(
        t.versions.handle({ actor: READER, id, page }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
