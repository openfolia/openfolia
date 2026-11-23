import { createHash } from 'node:crypto';
import type { Actor } from '../src/access/core/actor.js';
import { ChangeSetAssetDocument } from '../src/assets/api/change-set-asset.resources.js';
import { REQUEST_HEADER } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/** An app whose settings open HTML and SVG attachments (#236). */

let files = 0;
const unique = (data: Buffer) =>
  Buffer.concat([data, Buffer.from(`\n<!-- ${++files} -->`)]);
const HTML = Buffer.from(
  '<!doctype html><script>alert(document.cookie)</script>',
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};

let opened: TestApp;
beforeAll(async () => {
  opened = await createTestApp({
    CCMS_ATTACHMENT_TYPES_OPEN: 'text/html,.svg',
  });
});
afterAll(async () => {
  delete process.env['CCMS_ATTACHMENT_TYPES_OPEN'];
  await opened?.close();
});
afterEach(() => opened?.actAs(undefined));

async function changeSet(app: TestApp): Promise<string> {
  app.actAs(author);
  const res = await app.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Attachments' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

const attach = (app: TestApp, cs: string, data: Buffer, filename: string) =>
  app
    .anonymous()
    .post(`/change-sets/${cs}/assets?kind=attachment`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set(REQUEST_HEADER, '1')
    .attach('file', data, { filename, contentType: 'text/plain' });

describe('attachments, with dangerous types opened', () => {
  it('takes HTML and SVG where the settings open them, and still only ever as downloads', async () => {
    const cs = await changeSet(opened);
    for (const [data, name, type] of [
      [unique(HTML), 'page.html', 'text/html'],
      [unique(SVG), 'logo.svg', 'image/svg+xml'],
    ] as const) {
      const res = await attach(opened, cs, data, name);
      expect(res.status).toBe(201);
      const uploaded = ChangeSetAssetDocument.parse(res.body).data.attributes;
      expect(uploaded.contentType).toBe(type);
      const preview = await opened
        .get(`/change-sets/${cs}/assets/${sha256(data)}`)
        .set('Accept', '*/*')
        .buffer(true);
      expect(preview.headers['content-disposition']).toMatch(
        new RegExp(`^attachment; filename="${name}"`),
      );
      expect(preview.headers['x-content-type-options']).toBe('nosniff');
      expect(preview.headers['content-security-policy']).toContain('sandbox');
    }
    // An executable named as HTML stays refused.
    const exe = await attach(
      opened,
      cs,
      Buffer.from('MZ\x90\x00x', 'latin1'),
      'page.html',
    );
    expect(exe.status).toBe(422);
  });
});
