import type { Module } from '@openfolia/content-model';
import { PNG_HASH } from '@openfolia/content-repo/testing';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { HiddenContentPageDocument } from '../src/preview/api/hidden-content.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const EDITOR = 'https://editor.example.com';
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    CCMS_EDITOR_ORIGINS: `${EDITOR}, http://localhost:4200`,
  });
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from working_copies`);
  await t.database.db.execute(sql`delete from locks`);
});

const MODULE = '/modules/en/charging/preview';
const MANUAL = '/manuals/operating/variants/model=large/en/html';
const publicReader: Actor = {
  ...actorWith(['content.read'], { maxAudience: 'public' }),
  id: 'public-reader',
};

/** An error answer: JSON:API, whatever the route's success is, and valid. */
function errorOf(res: {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
}) {
  expect(res.headers['content-type']).toBe(JSON_API);
  expect(res.headers['content-security-policy']).toBeUndefined();
  return ErrorDocument.parse(res.body).errors;
}

describe('GET /modules/:lang/:id/preview', () => {
  it('serves a page with the rendered module, its stylesheets and images by relative URLs', async () => {
    const res = await t.get(`${MODULE}?variant=model=large`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = res.text;
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('<title>Charging</title>');
    expect(html).toContain('class="of-content of-module"');
    for (const name of ['theme.css', 'render-html.css', 'page.css']) {
      expect(html).toContain(`href="../../../preview/${name}"`);
    }
    // Light and dark follow the viewer's preference by default.
    expect(html).toMatch(
      /href="\.\.\/\.\.\/\.\.\/preview\/theme-dark\.css" media="\(prefers-color-scheme: dark\)"/,
    );
    expect(html).toContain(`src="../../../assets/${PNG_HASH}"`);
    expect(html).not.toMatch(/<script|\son[a-z]+=/i);
  });

  it('shows a text attribute, which a module on its own has no value for, as a chip with its label', async () => {
    const html = (await t.get(MODULE)).text;
    expect(html).toContain(
      '<span class="of-attribute of-attribute--unset" title="Not set for this preview">Product name</span>',
    );
    expect(html).not.toContain('{product-name}');
  });

  it('is locked down: no script, same-origin styles, nosniff, framing only by the editor', async () => {
    const res = await t.get(MODULE);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src 'unsafe-inline'|'unsafe-eval'|\*/);
    expect(csp).toContain(
      `frame-ancestors 'self' ${EDITOR} http://localhost:4200`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-ccms-commit']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('caches like every content route: no-cache with an ETag, immutable for a commit ID', async () => {
    const res = await t.get(MODULE);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const etag = String(res.headers['etag']);
    expect((await t.get(MODULE).set('If-None-Match', etag)).status).toBe(304);
    const commit = String(res.headers['x-ccms-commit']);
    const pinned = await t.get(`${MODULE}?ref=${commit}`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    // The images are read at the same ref.
    expect(pinned.text).toContain(`assets/${PNG_HASH}?ref=${commit}"`);
  });

  it('follows the requested theme', async () => {
    const dark = (await t.get(`${MODULE}?theme=dark`)).text;
    expect(dark).toContain('<html lang="en" dir="ltr" class="dark">');
    expect(dark).not.toContain('theme-dark.css');
    const light = (await t.get(`${MODULE}?theme=light`)).text;
    expect(light).toContain('<html lang="en" dir="ltr">');
    expect(light).not.toContain('theme-dark.css');
    expect(light).toContain('content="light"');
  });

  it('answers a bad request in JSON:API, with the parameter at fault', async () => {
    for (const [query, parameter] of [
      ['?theme=purple', 'theme'],
      ['?variant=not-a-slug', 'variant'],
      ['?variant=model=large&variant=model=small', 'variant'],
      ['?page[size]=1', 'page[size]'],
    ] as const) {
      const res = await t.get(`${MODULE}${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      expect(errorOf(res)[0]?.source?.parameter).toBe(parameter);
    }
    expect((await t.get('/modules/en/Bad_Id/preview')).status).toBe(400);
  });

  it('refuses a variant the configuration does not know, and a client that does not take HTML', async () => {
    for (const variant of ['colour=red', 'model=huge']) {
      const res = await t.get(`${MODULE}?variant=${variant}`);
      expect(res.status).toBe(422);
      expect(errorOf(res)[0]?.code).toBe('unknown-variant');
    }
    const res = await t.get(MODULE).set('Accept', 'application/json');
    expect(res.status).toBe(406);
    expect(errorOf(res)[0]?.code).toBe('not-acceptable');
    expect(
      (await t.get(MODULE).set('Accept', 'text/html,*/*;q=0.8')).status,
    ).toBe(200);
  });

  it('answers a hidden, a missing and an unknown-ref module alike', async () => {
    t.actAs(publicReader);
    const hidden = await t.get('/modules/en/internals/preview');
    const missing = await t.get('/modules/en/nothing/preview');
    const noLanguage = await t.get('/modules/fr/charging/preview');
    for (const res of [hidden, missing, noLanguage]) {
      expect(res.status).toBe(404);
      expect(errorOf(res)[0]?.code).toBe('not-found');
    }
    expect(errorOf(hidden)[0]?.detail).toBe(
      errorOf(missing)[0]?.detail?.replace('nothing', 'internals'),
    );
    // A reader of every level sees it.
    t.actAs(undefined);
    expect((await t.get('/modules/en/internals/preview')).status).toBe(200);
  });

  it('needs the token and the permission', async () => {
    expect((await t.anonymous().get(MODULE)).status).toBe(401);
    t.actAs(actorWith([]));
    expect((await t.get(MODULE)).status).toBe(403);
  });

  it('reads released content only without content.read.draft', async () => {
    t.actAs(publicReader);
    const res = await t.get('/modules/en/unlabelled/preview?ref=draft');
    expect(res.status).toBe(404);
    t.actAs(actorWith(['content.read', 'content.read.draft']));
    const draft = await t.get('/modules/en/unlabelled/preview?ref=draft');
    expect(draft.status).toBe(200);
    expect(draft.text).toContain('<title>Unlabelled</title>');
  });
});

describe('GET /manuals/:id/variants/:variant/:lang/html', () => {
  it('serves the whole manual with its table of contents and the variant', async () => {
    const res = await t.get(MANUAL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('<title>Operating manual</title>');
    expect(res.text).toContain('class="of-content of-manual"');
    expect(res.text).toContain('of-toc');
    expect(res.text).toContain('Large');
    expect(res.text).toContain(`src="../../../../../assets/${PNG_HASH}"`);
    expect(res.text).toContain('href="../../../../../preview/render-html.css"');
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(
      (await t.get(MANUAL).set('If-None-Match', String(res.headers['etag'])))
        .status,
    ).toBe(304);
  });

  it('answers a manual, variant or language the reader may not have like a missing one', async () => {
    t.actAs(actorWith(['content.read'], { languages: ['de'] }));
    const noEnglish = await t.get(MANUAL);
    const noLanguage = await t.get(MANUAL.replace('/en/', '/es/'));
    const noVariant = await t.get(MANUAL.replace('model=large', 'model=huge'));
    const noManual = await t.get(MANUAL.replace('operating', 'nope'));
    for (const res of [noEnglish, noLanguage, noVariant, noManual]) {
      expect(res.status).toBe(404);
      errorOf(res);
    }
    expect((await t.get(MANUAL.replace('/en/', '/de/'))).status).toBe(200);
  });

  it('fills in the text attributes, in what readers get and in the editor’s view', async () => {
    for (const path of [MANUAL, `${MANUAL}?view=editor`]) {
      const res = await t.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Model A');
      expect(res.text).not.toContain('of-attribute');
    }
  });

  it('takes only ref, theme and view, and the right media type', async () => {
    const res = await t.get(`${MANUAL}?variant=x`);
    expect(res.status).toBe(400);
    expect(errorOf(res)[0]?.code).toBe('unsupported-parameter');
    const view = await t.get(`${MANUAL}?view=print`);
    expect(view.status).toBe(400);
    expect(errorOf(view)[0]?.source).toEqual({ parameter: 'view' });
    expect((await t.get(`${MANUAL}?theme=dark`)).text).toContain(
      'class="dark"',
    );
    expect((await t.get(MANUAL).set('Accept', 'application/pdf')).status).toBe(
      406,
    );
    expect((await t.anonymous().get(MANUAL)).status).toBe(401);
  });
});

describe('an author’s own draft', () => {
  const author: Actor = {
    ...actorWith(['content.read', 'content.edit'], { maxAudience: 'public' }),
    id: 'preview-author',
  };
  const other: Actor = { ...author, id: 'preview-other' };
  const subject = { type: 'module', lang: 'en', moduleId: 'charging' };

  it('previews their change set’s branch by name, and nobody else’s', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Preview me' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    const path = `/change-sets/${id}/modules/en/charging/working-copy`;
    expect(
      (
        await t
          .post(`/change-sets/${id}/locks`)
          .send(
            JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
          )
      ).status,
    ).toBe(201);
    const wc = ModuleWorkingCopyDocument.parse((await t.get(path)).body).data
      .attributes;
    const content: Module = {
      ...(wc.content as Module),
      blocks: [
        {
          type: 'paragraph',
          id: 'typed',
          content: [{ type: 'text', text: 'Fresh from the editor.' }],
        },
      ],
    };
    expect(
      (
        await t.put(path).send(
          JSON.stringify({
            data: { type: 'WorkingCopy', attributes: { content } },
            meta: { version: wc.version, baseCommit: wc.baseCommit },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);

    const ref = encodeURIComponent(attributes.branch);
    const mine = await t.get(`${MODULE}?ref=${ref}`);
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('Fresh from the editor.');
    expect(mine.headers['cache-control']).toBe('private, no-cache');
    // The released module is unchanged.
    expect((await t.get(MODULE)).text).not.toContain('Fresh from the editor.');

    t.actAs(other);
    const theirs = await t.get(`${MODULE}?ref=${ref}`);
    expect(theirs.status).toBe(404);
    const missing = await t.get(`${MODULE}?ref=nope`);
    expect(errorOf(theirs)[0]?.detail).toBe(
      errorOf(missing)[0]?.detail?.replace('nope', attributes.branch),
    );
  });

  it('lists the variant blocks their draft hides, for them only', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Hide me' } },
      }),
    );
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    const path = `/change-sets/${id}/modules/en/charging/working-copy`;
    await t
      .post(`/change-sets/${id}/locks`)
      .send(
        JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
      );
    const wc = ModuleWorkingCopyDocument.parse((await t.get(path)).body).data
      .attributes;
    const content: Module = {
      ...(wc.content as Module),
      blocks: [
        {
          type: 'variant',
          id: 'large-only',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: [
            {
              type: 'paragraph',
              id: 'big',
              content: [{ type: 'text', text: 'Only the <large> one.' }],
            },
          ],
        },
      ],
    };
    expect(
      (
        await t.put(path).send(
          JSON.stringify({
            data: { type: 'WorkingCopy', attributes: { content } },
            meta: { version: wc.version, baseCommit: wc.baseCommit },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);

    const ref = encodeURIComponent(attributes.branch);
    const hidden = `/modules/en/charging/hidden-content?ref=${ref}`;
    const small = HiddenContentPageDocument.parse(
      (await t.get(`${hidden}&variant=model=small`)).body,
    );
    expect(small.data).toEqual([
      {
        type: 'HiddenContent',
        id: 'block:charging#large-only',
        attributes: {
          kind: 'block',
          module: 'charging',
          blockId: 'large-only',
          condition: { op: 'in', attr: 'model', values: ['large'] },
        },
        meta: {
          label: 'Only the <large> one.',
          expression: 'model in (large)',
        },
      },
    ]);
    // The preview leaves it out too.
    expect(
      (await t.get(`${MODULE}?ref=${ref}&variant=model=small`)).text,
    ).not.toContain('Only the');
    const large = HiddenContentPageDocument.parse(
      (await t.get(`${hidden}&variant=model=large`)).body,
    );
    expect(large.data).toEqual([]);
    // None set: the condition does not hold.
    expect(
      HiddenContentPageDocument.parse((await t.get(hidden)).body).meta.page
        .total,
    ).toBe(1);

    t.actAs(other);
    expect((await t.get(hidden)).status).toBe(404);
  });
});

describe('GET …/hidden-content', () => {
  const HIDDEN = '/modules/en/charging/hidden-content';
  const MANUAL_HIDDEN =
    '/manuals/operating/variants/model=large/en/hidden-content';

  it('answers a paged JSON:API list, empty when nothing is hidden', async () => {
    for (const path of [
      HIDDEN,
      `${HIDDEN}?variant=model=large`,
      MANUAL_HIDDEN,
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(res.headers['x-ccms-commit']).toMatch(/^[0-9a-f]{40}$/);
      const document = HiddenContentPageDocument.parse(res.body);
      expect(document.data).toEqual([]);
      expect(document.meta.page).toMatchObject({ currentPage: 1, total: 0 });
      expect(document.links.next).toBeNull();
    }
  });

  it('refuses what the preview refuses', async () => {
    const unsupported = await t.get(`${HIDDEN}?theme=dark`);
    expect(unsupported.status).toBe(400);
    expect(errorOf(unsupported)[0]?.code).toBe('unsupported-parameter');
    expect((await t.get(`${HIDDEN}?variant=not-a-slug`)).status).toBe(400);
    expect((await t.get(`${MANUAL_HIDDEN}?variant=model=large`)).status).toBe(
      400,
    );
    const unknown = await t.get(`${HIDDEN}?variant=model=huge`);
    expect(unknown.status).toBe(422);
    expect(errorOf(unknown)[0]?.code).toBe('unknown-variant');
    t.actAs(publicReader);
    expect((await t.get('/modules/en/internals/hidden-content')).status).toBe(
      404,
    );
    expect(
      (await t.get(MANUAL_HIDDEN.replace('model=large', 'model=huge'))).status,
    ).toBe(404);
    expect((await t.anonymous().get(HIDDEN)).status).toBe(401);
    t.actAs(actorWith([]));
    expect((await t.get(HIDDEN)).status).toBe(403);
  });
});

describe('GET /preview/:name', () => {
  it('serves the theme, its dark values, the renderer’s stylesheet and the fonts', async () => {
    const theme = await t.get('/preview/theme.css');
    expect(theme.status).toBe(200);
    expect(theme.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(theme.text).toContain('--background');
    expect(theme.headers['x-content-type-options']).toBe('nosniff');
    const dark = await t.get('/preview/theme-dark.css');
    expect(dark.text).toMatch(/^:root \{ color-scheme: dark; --background/);
    const css = await t.get('/preview/render-html.css');
    expect(css.text).toContain('.of-content');
    expect((await t.get('/preview/page.css')).status).toBe(200);
    const font = await t
      .get('/preview/fonts/Geist-Variable.woff2')
      .buffer(true);
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect((font.body as Buffer).length).toBeGreaterThan(1000);
    // The theme's own relative font URLs lead here.
    expect(theme.text).toContain("url('./fonts/Geist-Variable.woff2')");
  });

  it('revalidates with an ETag of the bytes', async () => {
    const res = await t.get('/preview/theme.css');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const again = await t
      .get('/preview/theme.css')
      .set('If-None-Match', String(res.headers['etag']));
    expect(again.status).toBe(304);
  });

  it('serves nothing but the files it holds, and only to a caller with the token', async () => {
    for (const path of [
      '/preview/nope.css',
      '/preview/fonts/nope.woff2',
      '/preview/fonts/theme.css',
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      errorOf(res);
    }
    for (const path of [
      '/preview/..%2Fpackage.json',
      '/preview/fonts/..%2F..%2Fpackage.json',
      '/preview/theme.css%00.css',
      '/preview/.env',
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      errorOf(res);
    }
    expect((await t.anonymous().get('/preview/theme.css')).status).toBe(401);
  });
});
