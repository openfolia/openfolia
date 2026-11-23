import { createHash } from 'node:crypto';
import type { Manifest, Module } from '@openfolia/content-model';
import { PNG_HASH } from '@openfolia/content-repo/testing';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  ManualWorkingCopyDocument,
  ModuleWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import { HiddenContentPageDocument } from '../src/preview/api/hidden-content.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * The live preview (#237): `?workingCopy=true` reads a change set's working
 * copies in place of their files, for its author only.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from working_copies`);
  await t.database.db.execute(sql`delete from locks`);
});

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'live-author',
};
/** Reads every draft, edits too: still not the author. */
const draftReader: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'live-reviewer',
};
/** Another author, without content.read.draft. */
const other: Actor = { ...author, id: 'live-other' };

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function errorOf(res: { headers: Record<string, unknown>; body: unknown }) {
  expect(res.headers['content-type']).toBe(JSON_API);
  return ErrorDocument.parse(res.body).errors;
}

/** A change set of `author`'s, with the lock on `subjects` taken. */
async function draft(
  ...subjects: (
    | { type: 'module'; lang: string; moduleId: string }
    | { type: 'manual'; manualId: string }
  )[]
): Promise<{ id: string; ref: string }> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Live' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  for (const subject of subjects) {
    const locked = await t
      .post(`/change-sets/${id}/locks`)
      .send(
        JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
      );
    expect(locked.status).toBe(201);
  }
  return { id, ref: encodeURIComponent(attributes.branch) };
}

/** Autosaves `blocks` as the module's working copy (no save point). */
async function type(
  changeSet: string,
  moduleId: string,
  edit: (module: Module) => Module,
): Promise<void> {
  t.actAs(author);
  const path = `/change-sets/${changeSet}/modules/en/${moduleId}/working-copy`;
  const wc = ModuleWorkingCopyDocument.parse((await t.get(path)).body).data
    .attributes;
  const saved = await t.put(path).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: { content: edit(wc.content as Module) },
      },
      meta: { version: wc.version, baseCommit: wc.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
}

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  id: 'typed',
  content: [{ type: 'text' as const, text }],
});

const MODULE = '/modules/en/charging/preview';

describe('GET /modules/:lang/:id/preview?workingCopy=true', () => {
  it('shows what was typed before any save point, uncached, and only with the parameter', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [paragraph('Typed a moment ago.'), ...m.blocks],
    }));
    const live = await t.get(`${MODULE}?ref=${cs.ref}&workingCopy=true`);
    expect(live.status).toBe(200);
    expect(live.text).toContain('Typed a moment ago.');
    expect(live.headers['cache-control']).toBe('private, no-cache');
    expect(live.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
    // A stale If-None-Match never gets a 304: the working copy changes under the same commit.
    const committed = await t.get(`${MODULE}?ref=${cs.ref}`);
    expect(committed.text).not.toContain('Typed a moment ago.');
    const etag = String(committed.headers['etag']);
    const again = await t
      .get(`${MODULE}?ref=${cs.ref}&workingCopy=true`)
      .set('If-None-Match', etag);
    expect(again.status).toBe(200);
    // Any ETag it has is the page's own bytes', never the commit's.
    expect(live.headers['etag']).not.toBe(etag);
    // `false` is the branch as committed.
    const off = await t.get(`${MODULE}?ref=${cs.ref}&workingCopy=false`);
    expect(off.text).not.toContain('Typed a moment ago.');

    // The next autosave shows at once.
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [paragraph('Typed again.'), ...m.blocks.slice(1)],
    }));
    const next = await t
      .get(`${MODULE}?ref=${cs.ref}&workingCopy=true`)
      .set('If-None-Match', String(live.headers['etag']));
    expect(next.status).toBe(200);
    expect(next.text).toContain('Typed again.');
    expect(next.text).not.toContain('Typed a moment ago.');
  });

  it('names a module a cross-reference links to by its title, not its ID (#796)', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    // Only linked, not included: the module is read for its title alone.
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [
        {
          type: 'paragraph',
          id: 'typed',
          content: [
            { type: 'text', text: 'Read ' },
            { type: 'xref', module: 'safety-note' },
            { type: 'text', text: ' first.' },
          ],
        },
      ],
    }));
    const live = await t.get(`${MODULE}?ref=${cs.ref}&workingCopy=true`);
    expect(live.status).toBe(200);
    expect(live.text).toMatch(
      /<span class="of-xref of-xref--unresolved">Safety note<\/span>/,
    );
    expect(live.text).not.toContain('>safety-note<');
  });

  it('never shows the working copy to anyone else: 403 for a reader of drafts, 404 for another author', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [paragraph('Not for your eyes.')],
    }));
    const live = `${MODULE}?ref=${cs.ref}&workingCopy=true`;
    const hidden = `/modules/en/charging/hidden-content?ref=${cs.ref}&workingCopy=true`;
    const manual = `/manuals/operating/variants/model=large/en/html?ref=${cs.ref}&workingCopy=true`;
    const pdf = `/manuals/operating/variants/model=large/en/pdf?ref=${cs.ref}&workingCopy=true`;
    const page = `/manuals/operating/variants/model=large/en/pdf/pages/1.png?ref=${cs.ref}&workingCopy=true`;

    t.actAs(draftReader);
    for (const path of [live, hidden, manual, pdf, page]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 403]);
      expect(errorOf(res)[0]?.code).toBe('forbidden');
      expect(JSON.stringify(res.body)).not.toContain('Not for your eyes.');
    }
    // Without the parameter, they read what is committed, as before.
    const committed = await t.get(`${MODULE}?ref=${cs.ref}`);
    expect(committed.status).toBe(200);
    expect(committed.text).not.toContain('Not for your eyes.');

    t.actAs(other);
    for (const path of [live, hidden, manual, pdf, page]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      const [error] = errorOf(res);
      expect(error?.code).toBe('not-found');
      // Exactly as a change set that does not exist.
      expect(error?.detail).toBe(`No change set "${cs.id}".`);
    }
    // Their reading the working copy itself answers the same.
    const read = await t.get(
      `/change-sets/${cs.id}/modules/en/charging/working-copy`,
    );
    expect(read.status).toBe(404);
  });

  it('needs the change set’s branch as ref', async () => {
    await draft();
    t.actAs(author);
    for (const query of ['workingCopy=true', 'ref=main&workingCopy=true']) {
      const res = await t.get(`${MODULE}?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      const [error] = errorOf(res);
      expect(error?.code).toBe('invalid-parameter');
      expect(error?.source?.parameter).toBe('workingCopy');
    }
    const cs = await draft();
    for (const value of ['yes', '1']) {
      const res = await t.get(`${MODULE}?ref=${cs.ref}&workingCopy=${value}`);
      expect(res.status).toBe(400);
      expect(errorOf(res)[0]?.source?.parameter).toBe('workingCopy');
    }
  });

  it('resolves module references to their own working copies, else the branch', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'safety-note',
    });
    await type(cs.id, 'safety-note', (m) => ({
      ...m,
      blocks: [paragraph('A safety note, rewritten.')],
    }));
    const live = await t.get(
      `${MODULE}?ref=${cs.ref}&workingCopy=true&variant=model=large`,
    );
    expect(live.status).toBe(200);
    expect(live.text).toContain('A safety note, rewritten.');
    expect(live.text).not.toContain('Let it cool down.');
    // The module itself has no working copy: its committed text.
    expect(live.text).toContain('The charger');
  });

  it('applies the variant and lists what it hides, from the working copy', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [
        {
          type: 'variant',
          id: 'large-only',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: [paragraph('Only the large one, unsaved.')],
        },
      ],
    }));
    const page = (variant: string) =>
      t.get(`${MODULE}?ref=${cs.ref}&workingCopy=true&variant=${variant}`);
    expect((await page('model=large')).text).toContain(
      'Only the large one, unsaved.',
    );
    expect((await page('model=small')).text).not.toContain('Only the large');
    const hidden = await t.get(
      `/modules/en/charging/hidden-content?ref=${cs.ref}&workingCopy=true&variant=model=small`,
    );
    expect(hidden.status).toBe(200);
    expect(hidden.headers['cache-control']).toBe('private, no-cache');
    const listed = HiddenContentPageDocument.parse(hidden.body);
    expect(listed.data.map((d) => d.id)).toEqual(['block:charging#large-only']);
    expect(listed.data[0]?.meta.label).toBe('Only the large one, unsaved.');
  });

  it('links an image uploaded into the change set to its author’s upload route, others to the branch', async () => {
    const cs = await draft({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    const bytes = Buffer.concat([PNG_BYTES, Buffer.from('#live-preview')]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const uploaded = await t
      .anonymous()
      .post(`/change-sets/${cs.id}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .attach('file', bytes, { filename: 'new.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(201);
    await type(cs.id, 'charging', (m) => ({
      ...m,
      blocks: [
        ...m.blocks,
        { type: 'image', id: 'fresh', asset: `sha256:${hash}`, alt: 'New' },
      ],
    }));
    const live = await t.get(`${MODULE}?ref=${cs.ref}&workingCopy=true`);
    expect(live.text).toContain(
      `src="../../../change-sets/${cs.id}/assets/${hash}"`,
    );
    expect(live.text).toContain(
      `src="../../../assets/${PNG_HASH}?ref=${cs.ref}"`,
    );
    const image = await t.get(`/change-sets/${cs.id}/assets/${hash}`);
    expect(image.status).toBe(200);
  });
});

describe('a manual’s working copy', () => {
  it('previews its draft manifest as HTML, for its author', async () => {
    const cs = await draft({ type: 'manual', manualId: 'operating' });
    t.actAs(author);
    const path = `/change-sets/${cs.id}/manuals/operating/working-copy`;
    const wc = ManualWorkingCopyDocument.parse((await t.get(path)).body).data
      .attributes;
    const manifest = wc.content as Manifest;
    const saved = await t.put(path).send(
      JSON.stringify({
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              ...manifest,
              title: 'Operating manual, retitled',
              entries: [{ module: 'safety-note' }],
            },
          },
        },
        meta: { version: wc.version, baseCommit: wc.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    const html = `/manuals/operating/variants/model=large/en/html?ref=${cs.ref}`;
    const live = await t.get(`${html}&workingCopy=true`);
    expect(live.status).toBe(200);
    expect(live.text).toContain('Operating manual, retitled');
    expect(live.text).not.toContain('The charger');
    const committed = await t.get(html);
    expect(committed.text).not.toContain('retitled');
    const hidden = await t.get(
      `/manuals/operating/variants/model=large/en/hidden-content?ref=${cs.ref}&workingCopy=true`,
    );
    expect(hidden.status).toBe(200);
    const pdf = await t
      .get(
        `/manuals/operating/variants/model=large/en/pdf?ref=${cs.ref}&workingCopy=true`,
      )
      .buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('private, no-cache');
    // The thumbnails show the unsaved title too: the cover differs from the committed one.
    const cover = `/manuals/operating/variants/model=large/en/pdf/pages/1.png?ref=${cs.ref}`;
    const liveCover = await t.get(`${cover}&workingCopy=true`).buffer(true);
    expect(liveCover.status).toBe(200);
    expect(liveCover.headers['content-type']).toBe('image/png');
    expect(liveCover.headers['cache-control']).toBe('private, no-cache');
    const committedCover = await t.get(cover).buffer(true);
    expect(committedCover.status).toBe(200);
    expect(liveCover.body).not.toEqual(committedCover.body);
  });
});
