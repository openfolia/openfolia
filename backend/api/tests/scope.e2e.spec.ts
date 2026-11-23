import { PNG_HASH } from '@openfolia/content-repo/testing';
import type { z } from 'zod';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ManualDocument,
  ManualPageDocument,
  ResolvedManualDocument,
} from '../src/manuals/api/manual.resources.js';
import { ModulePageDocument } from '../src/modules/api/module.resources.js';
import { RefPageDocument } from '../src/project/api/project.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * What a reader sees, per scope dimension and audience level, over the
 * sample repository: on `main`, `en/charging` (procedure, public, with an
 * image and a reference to the safety note), `de/charging`,
 * `en/safety-note` (concept, public, region north) and `en/internals`
 * (concept, internal); manual `operating` (audience public) lists charging
 * and internals. Branch `draft` adds a broken module and `en/unlabelled`,
 * which has no audience, and lists both and `safety-note` in the manual
 * (`unlabelled` in a group `Service`, under a condition on an attribute not
 * configured).
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const READ: Permission[] = ['content.read'];
const DRAFT: Permission[] = ['content.read', 'content.read.draft'];
const reader = (scope: Scope, permissions = READ): Actor => ({
  ...actorWith(permissions, scope),
  id: `reader-${JSON.stringify(scope)}-${permissions.length}`,
});

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

/** The module IDs a reader is listed, and the total. */
async function modules(actor: Actor, query = '') {
  t.actAs(actor);
  const res = await t.get(`/modules?page[size]=200${query}`);
  expect(res.status).toBe(200);
  const page = ModulePageDocument.parse(res.body);
  return { ids: page.data.map((m) => m.id), total: page.meta.page.total };
}

async function resolved(actor: Actor, lang = 'en', ref = 'main') {
  t.actAs(actor);
  const res = await t.get(
    `/manuals/operating/variants/model=large/${lang}?ref=${ref}`,
  );
  expect(res.status).toBe(200);
  const { data } = ResolvedManualDocument.parse(res.body);
  return {
    text: JSON.stringify(data.attributes),
    issues: data.meta.issues.map((i) => `${i.code} ${i.module ?? ''}`),
  };
}

/** A 404 exactly like the one for something that does not exist. */
async function likeMissing(path: string, missingPath: string) {
  const outside = await t.get(path);
  const missing = await t.get(missingPath);
  expect([path, outside.status]).toEqual([path, 404]);
  expect(missing.status).toBe(404);
  const detail = (r: typeof outside) => error(r.body)?.detail;
  return { outside: detail(outside), missing: detail(missing) };
}

describe('audience levels', () => {
  it('shows a public reader only public modules, counted before paging', async () => {
    const publicReader = reader({ maxAudience: 'public' });
    expect(await modules(publicReader)).toEqual({
      ids: ['de/charging', 'en/charging', 'en/safety-note'],
      total: 3,
    });
    t.actAs(publicReader);
    const page = ModulePageDocument.parse(
      (await t.get('/modules?page[size]=1')).body,
    );
    expect(page.meta.page).toMatchObject({ total: 3, lastPage: 3 });
    const { outside, missing } = await likeMissing(
      '/modules/en/internals',
      '/modules/en/nope',
    );
    expect(outside).toBe(missing?.replace('nope', 'internals'));
  });

  it('shows an internal reader every level', async () => {
    expect((await modules(reader({ maxAudience: 'internal' }))).total).toBe(4);
  });

  it('hides a module without an audience from anyone limited below internal', async () => {
    const below = reader({ maxAudience: 'public' }, DRAFT);
    expect((await modules(below, '&ref=draft')).ids).not.toContain(
      'en/unlabelled',
    );
    t.actAs(below);
    const { outside, missing } = await likeMissing(
      '/modules/en/unlabelled?ref=draft',
      '/modules/en/nope?ref=draft',
    );
    expect(outside).toBe(missing?.replace('nope', 'unlabelled'));
    const internal = reader({ maxAudience: 'internal' }, DRAFT);
    expect((await modules(internal, '&ref=draft')).ids).toContain(
      'en/unlabelled',
    );
  });
});

describe('languages', () => {
  it('lists and resolves only the reader’s languages', async () => {
    const german = reader({ languages: ['de'] });
    expect(await modules(german)).toEqual({ ids: ['de/charging'], total: 1 });
    // German charging, without the English safety note it would fall back to.
    const { text } = await resolved(german, 'de');
    expect(text).toContain('lädt sich selbst');
    expect(text).not.toContain('Let it cool down.');
    // Not in English: answered like a language that is not configured.
    t.actAs(german);
    const { outside, missing } = await likeMissing(
      '/manuals/operating/variants/model=large/en',
      '/manuals/operating/variants/model=large/es',
    );
    expect(outside).toBe(missing?.replace('es', 'en'));
  });
});

describe('module types', () => {
  it('lists only the reader’s types and leaves the others out of manuals', async () => {
    const concepts = reader({ moduleTypes: ['concept'] });
    expect((await modules(concepts)).ids).toEqual([
      'en/internals',
      'en/safety-note',
    ]);
    const { text } = await resolved(concepts);
    expect(text).not.toContain('charges');
  });
});

describe('facets', () => {
  it('shows a module classified by region only to readers of that region', async () => {
    const north = reader({ facets: { region: ['north'] } });
    const south = reader({ facets: { region: ['south'] } });
    expect((await modules(north)).ids).toContain('en/safety-note');
    expect((await modules(south)).ids).not.toContain('en/safety-note');
    // Modules naming no region apply to all.
    expect((await modules(south)).ids).toContain('en/charging');
    expect((await resolved(north)).text).toContain('Let it cool down.');
    expect((await resolved(south)).text).not.toContain('Let it cool down.');
  });
});

describe('what was left out', () => {
  it('is noted only for readers with content.read.draft', async () => {
    const scope = { facets: { region: ['south'] } };
    expect((await resolved(reader(scope, DRAFT))).issues).toContain(
      'outside-scope safety-note',
    );
    expect((await resolved(reader(scope))).issues).not.toContainEqual(
      expect.stringContaining('safety-note'),
    );
  });

  it('reports a broken module of a draft only to a reader of all its language', async () => {
    const all = await resolved(reader({}, DRAFT), 'en', 'draft');
    expect(all.issues).toContain('invalid-module broken');
    const scoped = await resolved(
      reader({ maxAudience: 'internal' }, DRAFT),
      'en',
      'draft',
    );
    expect(scoped.issues).not.toContain('invalid-module broken');
    expect(scoped.issues).toContain('outside-scope broken');
  });
});

describe('draft refs', () => {
  it('opens released refs with content.read: main, tags and their commits', async () => {
    t.actAs(reader({}));
    for (const ref of ['main', 'v1', t.commits.v1, t.commits.main]) {
      expect([ref, (await t.get(`/config?ref=${ref}`)).status]).toEqual([
        ref,
        200,
      ]);
    }
  });

  it('does not find any other ref without content.read.draft', async () => {
    t.actAs(reader({}));
    for (const ref of ['draft', t.commits.draft]) {
      const { outside, missing } = await likeMissing(
        `/config?ref=${ref}`,
        '/config?ref=nope',
      );
      expect(outside).toBe(missing?.replace('nope', ref));
    }
    t.actAs(reader({}, DRAFT));
    expect((await t.get('/config?ref=draft')).status).toBe(200);
  });

  it('lists only the refs the reader may open', async () => {
    const refs = async (actor: Actor) => {
      t.actAs(actor);
      const page = RefPageDocument.parse((await t.get('/refs')).body);
      return { ids: page.data.map((r) => r.id), total: page.meta.page.total };
    };
    expect(await refs(reader({}))).toEqual({
      ids: ['heads/main', 'tags/v1'],
      total: 2,
    });
    expect((await refs(reader({}, DRAFT))).ids).toContain('heads/draft');
  });
});

describe('manuals', () => {
  it('lists the manual to every reader whose audience covers it', async () => {
    for (const [maxAudience, ids] of [
      ['public', ['operating']],
      ['internal', ['operating', 'service']],
    ] as const) {
      t.actAs(reader({ maxAudience }));
      const page = ManualPageDocument.parse((await t.get('/manuals')).body);
      // The internal service manual only for a reader of internal content.
      expect(page.data.map((m) => m.id)).toEqual(ids);
      expect(page.meta.page.total).toBe(ids.length);
    }
  });
});

describe('what a manifest names', () => {
  type Entries = z.infer<
    typeof ManualDocument
  >['data']['attributes']['entries'];
  /** Every module an entry list names, groups as `title[…]`. */
  const named = (entries: Entries): string[] =>
    entries.map((e) =>
      'module' in e ? e.module : `${e.title}[${named(e.entries).join(',')}]`,
    );
  /** The manual as read and as listed (the same), as names and issues. */
  async function manual(actor: Actor, ref = 'main') {
    t.actAs(actor);
    const read = await t.get(`/manuals/operating?ref=${ref}`);
    expect(read.status).toBe(200);
    const { data } = ManualDocument.parse(read.body);
    const list = ManualPageDocument.parse(
      (await t.get(`/manuals?ref=${ref}`)).body,
    );
    expect(list.data.filter((m) => m.id === 'operating')).toEqual([data]);
    return {
      entries: named(data.attributes.entries),
      issues: data.meta.issues.map((i) => `${i.code} ${i.at ?? ''}`),
    };
  }

  it('is unchanged for a reader of everything', async () => {
    expect(await manual(reader({}, DRAFT), 'draft')).toEqual({
      entries: [
        'charging',
        'broken',
        'safety-note',
        'Service[unlabelled]',
        'internals',
      ],
      issues: ['unknown-variant-attribute unlabelled'],
    });
  });

  it('leaves out modules above the reader’s audience', async () => {
    expect((await manual(reader({ maxAudience: 'public' }))).entries).toEqual([
      'charging',
    ]);
    expect((await manual(reader({ maxAudience: 'internal' }))).entries).toEqual(
      ['charging', 'internals'],
    );
  });

  it('leaves out modules outside the reader’s languages', async () => {
    // `charging` has a German version, `internals` is English only.
    expect((await manual(reader({ languages: ['de'] }))).entries).toEqual([
      'charging',
    ]);
  });

  it('leaves out modules outside the reader’s types and facets', async () => {
    expect(
      (await manual(reader({ moduleTypes: ['concept'] }))).entries,
    ).toEqual(['internals']);
    // `internals` names no region, so it applies to all; with a public
    // audience nothing is left.
    expect(
      (
        await manual(
          reader({ moduleTypes: ['concept'], maxAudience: 'public' }),
        )
      ).entries,
    ).toEqual([]);
    // `safety-note` (region north) is listed on the draft.
    const region = async (value: string) =>
      (
        await manual(
          reader({ maxAudience: 'public', facets: { region: [value] } }, DRAFT),
          'draft',
        )
      ).entries;
    expect(await region('north')).toEqual(['charging', 'safety-note']);
    expect(await region('south')).toEqual(['charging']);
  });

  it('gives no 304 for a manual read in another scope', async () => {
    t.actAs(reader({ maxAudience: 'internal' }));
    const etag = (await t.get('/manuals/operating')).headers['etag'] ?? '';
    expect(etag).not.toBe('');
    expect(
      (await t.get('/manuals/operating').set('If-None-Match', etag)).status,
    ).toBe(304);
    t.actAs(reader({ maxAudience: 'public' }));
    const other = await t.get('/manuals/operating').set('If-None-Match', etag);
    expect(other.status).toBe(200);
    expect(other.headers['etag']).not.toBe(etag);
    const { data } = ManualDocument.parse(other.body);
    expect(data.attributes.entries).toEqual([{ module: 'charging' }]);
  });

  it('names none of them in the issues; draft readers get a note instead', async () => {
    const scoped = await manual(
      reader({ maxAudience: 'public' }, DRAFT),
      'draft',
    );
    // `broken` cannot be read, so it is left out for anyone limited.
    expect(scoped.entries).toEqual(['charging', 'safety-note']);
    expect(scoped.issues).toEqual([
      'outside-scope broken',
      'outside-scope unlabelled',
      'outside-scope internals',
    ]);
    const resolvedDraft = await resolved(
      reader({ maxAudience: 'public' }, DRAFT),
      'en',
      'draft',
    );
    expect(resolvedDraft.issues).not.toContainEqual(
      expect.stringMatching(/^(?!outside-scope).* unlabelled$/),
    );
    expect(resolvedDraft.issues).toContain('outside-scope unlabelled');
  });

  it('resolves only the entries the reader may see, not their conditions', async () => {
    // `unlabelled`'s condition uses an attribute the variant does not set.
    const all = await resolved(reader({}, DRAFT), 'en', 'draft');
    expect(all.issues).toContain('missing-variant-attribute ');
    const below = reader({ maxAudience: 'public' }, DRAFT);
    const scoped = await resolved(below, 'en', 'draft');
    expect(scoped.issues).not.toContainEqual(
      expect.stringMatching(/^missing-variant-attribute/),
    );
    // The PDF counts the same issues.
    t.actAs(below);
    const pdf = await t
      .get('/manuals/operating/variants/model=large/en/pdf?ref=draft')
      .buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['x-ccms-issues']).toBe(String(scoped.issues.length));
  }, 60_000);
});

describe('assets', () => {
  it('serves an image only to readers of a module that shows it', async () => {
    const path = `/assets/${PNG_HASH}`;
    t.actAs(reader({ languages: ['de'] }));
    expect((await t.get(path).set('Accept', 'image/*')).status).toBe(200);
    t.actAs(reader({ moduleTypes: ['concept'] }));
    const { outside, missing } = await likeMissing(
      path,
      `/assets/${'0'.repeat(64)}`,
    );
    expect(outside).toBe(missing?.replace('0'.repeat(64), PNG_HASH));
  });
});

describe('caching', () => {
  it('never gives a reader a 304 for a response made for another scope', async () => {
    const north = reader({ facets: { region: ['north'] } });
    const south = reader({ facets: { region: ['south'] } });
    t.actAs(north);
    const first = await t.get('/modules');
    const etag = first.headers['etag'] ?? '';
    expect(first.headers['vary']).toMatch(/Authorization/);
    expect(first.headers['vary']).toMatch(/X-Ccms-User/);
    expect((await t.get('/modules').set('If-None-Match', etag)).status).toBe(
      304,
    );
    t.actAs(south);
    const other = await t.get('/modules').set('If-None-Match', etag);
    expect(other.status).toBe(200);
    expect(other.headers['etag']).not.toBe(etag);
    expect(
      ModulePageDocument.parse(other.body).data.map((m) => m.id),
    ).not.toContain('en/safety-note');
  });

  it('never shares a cached PDF between readers of different scopes', async () => {
    const pdf = async (actor: Actor) => {
      t.actAs(actor);
      const res = await t
        .get('/manuals/operating/variants/model=large/en/pdf')
        .buffer(true);
      expect(res.status).toBe(200);
      return res.body as Buffer;
    };
    const south = await pdf(reader({ facets: { region: ['south'] } }));
    const north = await pdf(reader({ facets: { region: ['north'] } }));
    // The north reader's has the safety note, the south reader's does not.
    expect(north.equals(south)).toBe(false);
    expect(north.length).toBeGreaterThan(south.length);
    expect(
      (await pdf(reader({ facets: { region: ['south'] } }))).equals(south),
    ).toBe(true);
  }, 60_000);
});
