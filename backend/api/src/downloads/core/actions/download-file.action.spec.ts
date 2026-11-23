import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  attachment,
  downloadsSetup,
  sha256,
  withAttachments,
} from '../../../../tests/fakes/downloads.js';
import { manifest } from '../../../../tests/fakes/fake-content.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import { PROMOTED_PRIORITY } from '../../../releases/core/release-output.js';

const publicReader = actorWith(['content.read'], { maxAudience: 'public' });
const SHEET = 'attachment:tuggers:datasheet:sheet:en';
const PDF = 'manual:tuggers:operating:en:model=small';

const sheet = (bytes: string, extra = {}, audience = 'public') => ({
  modules: [
    withAttachments('datasheet', [attachment('sheet', bytes, extra)], {
      audience,
    }),
  ],
  manifests: [manifest('operating', ['datasheet'])],
});

const read = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

describe('DownloadFileAction', () => {
  it('sends an attachment as the release holds it, under its file name', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0', sheet('v1'));
    const r2 = t.release('2.0', sheet('v2'));
    await t.put('v1');
    await t.put('v2');
    const old = await t.file.handle({
      actor: READER,
      id: SHEET,
      releaseId: r1.id,
    });
    expect(old.kind).toBe('attachment');
    if (old.kind !== 'attachment') return;
    expect(old.hash).toBe(sha256('v1'));
    expect(old.asset).toMatchObject({
      type: 'application/zip',
      size: 2,
      download: { fileName: 'sheet.zip' },
    });
    expect(await read(old.asset.stream)).toBe('v1');
    const now = await t.file.handle({
      actor: READER,
      id: SHEET,
      releaseId: r2.id,
    });
    if (now.kind !== 'attachment') throw new Error('not an attachment');
    expect(await read(now.asset.stream)).toBe('v2');
  });

  it('names a file whose block’s name does not fit what is stored by its hash', async () => {
    const t = downloadsSetup(sheet('v1', { fileName: 'evil.html' }));
    const r = t.release('1.0');
    await t.put('v1');
    const found = await t.file.handle({
      actor: READER,
      id: SHEET,
      releaseId: r.id,
    });
    if (found.kind !== 'attachment') throw new Error('not an attachment');
    expect(found.asset.download).toEqual({});
  });

  it('is 404 for a reader who may not see it there, another product’s release, or a file not stored', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0', sheet('v1', {}, 'internal'));
    const lifts = t.release('1.0', sheet('v1'), {}, 'lifts');
    const r3 = t.release('3.0', sheet('v3'));
    await t.put('v1');
    for (const [actor, releaseId] of [
      [publicReader, r1.id],
      [READER, lifts.id],
      [READER, r3.id],
      [READER, 'not-a-release'],
    ] as const) {
      await expect(
        t.file.handle({ actor, id: SHEET, releaseId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('sends no offline package (#59) as a manual’s file: no download ID names one', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0');
    t.offlinePackage(r1, 'zip');
    await t.put('zip', 'application/zip');
    await expect(
      t.file.handle({
        actor: READER,
        id: 'manual:tuggers:*:en:public',
        releaseId: r1.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sends a manual’s PDF through the release outputs’ route, 409 until it is done', async () => {
    const t = downloadsSetup(sheet('v1'));
    const r1 = t.release('1.0');
    const r2 = t.release('2.0');
    t.output(r1, 'operating', 'pdf a');
    t.output(r2, 'operating', '', { state: 'queued' });
    await t.put('pdf a', 'application/pdf');
    const found = await t.file.handle({
      actor: READER,
      id: PDF,
      releaseId: r1.id,
    });
    if (found.kind !== 'manual') throw new Error('not a manual');
    expect(found.file.fileName).toBe('operating_model-small_en_1.0.pdf');
    expect(await read(found.file.blob.stream)).toBe('pdf a');
    await expect(
      t.file.handle({ actor: READER, id: PDF, releaseId: r2.id }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Asked for, it is moved up the render queue as from the release page (#497), within the
    // reader's own budget.
    const [waiting] = await t.outputs.all(r2.id);
    expect(t.jobs.jobs.find((j) => j.key === waiting!.id)?.priority).toBe(
      PROMOTED_PRIORITY,
    );
    await expect(
      t.file.handle({
        actor: READER,
        id: 'manual:tuggers:operating:en:model=large',
        releaseId: r1.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
