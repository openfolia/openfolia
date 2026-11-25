import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../build/api-client.ts';
import { readFileSync } from 'node:fs';
import { HashMismatchError } from '../build/assets.ts';
import { AudienceError } from '../build/audience.ts';
import { fetchSnapshots } from '../build/fetch.ts';

/**
 * The fetch step against an API that gives more than the token should read (a misconfigured
 * role, a bug in the API's scoping): the build refuses, whatever the token's own scope says.
 */
const TOKEN = `ccms_sat_${'1'.repeat(16)}_${'2'.repeat(64)}`;
const TAG = 'alpha-1.0';
const CONFIG = {
  languages: { source: 'en', targets: [] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'product',
      label: 'Product',
      values: [{ id: 'alpha', label: 'Alpha' }],
    },
  ],
  variantAttributes: [],
  safetySymbols: [],
};

let assetsDir: string;
beforeEach(() => {
  assetsDir = mkdtempSync(join(tmpdir(), 'openfolia-portal-fetch-'));
});
afterEach(() => rmSync(assetsDir, { recursive: true, force: true }));

/** Every path the fake API was asked for, in order. */
let asked: string[] = [];

function api(over: Record<string, unknown>): typeof fetch {
  const routes: Record<string, unknown> = {
    '/me': {
      data: {
        type: 'Actor',
        id: 'portal',
        attributes: {
          kind: 'service',
          roles: [
            {
              id: 'read-public',
              permissions: ['content.read'],
              scope: { maxAudience: 'public' },
            },
          ],
        },
      },
    },
    '/releases': {
      data: [
        {
          type: 'Release',
          id: '0193a8d0-0000-7000-8000-000000000001',
          attributes: {
            product: 'alpha',
            productFacet: 'product',
            revision: '1.0',
            tag: TAG,
            publishedAt: '2026-11-01T00:00:00Z',
            notes: null,
            notesByLanguage: {},
            withdrawal: null,
          },
        },
      ],
      meta: { page: { lastPage: 1 } },
    },
    '/config': {
      data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
    },
    '/modules': {
      data: [
        {
          type: 'Module',
          id: 'en/a',
          attributes: { moduleId: 'a', lang: 'en', audience: 'public' },
        },
        {
          type: 'Module',
          id: 'en/b',
          attributes: { moduleId: 'b', lang: 'en', audience: 'internal' },
        },
      ],
      meta: { page: { lastPage: 1 } },
    },
    '/manuals': {
      data: [
        {
          type: 'Manual',
          id: 'm',
          attributes: { title: 'M', audience: 'public' },
          meta: { variants: [{ slug: 'all', label: 'All', values: {} }] },
        },
      ],
      meta: { page: { lastPage: 1 } },
    },
    '/manuals/m/variants/all/en': {
      data: {
        type: 'ResolvedManual',
        id: 'm/all/en',
        attributes: {
          title: 'M',
          lang: 'en',
          variant: {},
          entries: [
            { kind: 'module', module: 'a', title: 'A', lang: 'en', blocks: [] },
          ],
          origins: {},
          anchors: {},
        },
      },
    },
    ...over,
  };
  return (async (url: URL | string) => {
    const path = new URL(String(url)).pathname.replace(/^\/api/, '');
    asked.push(path);
    const body = routes[path];
    if (body === undefined)
      return new Response('{"errors":[{"code":"not-found"}]}', { status: 404 });
    if (typeof body === 'string' || body instanceof Uint8Array)
      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          'content-type':
            typeof body === 'string'
              ? 'image/svg+xml'
              : 'application/octet-stream',
        },
      });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' },
    });
  }) as typeof fetch;
}

const run = (
  answer: typeof fetch,
  over: {
    languages?: string[];
    log?: (line: string) => void;
    branding?: boolean;
  } = {},
) => {
  asked = [];
  return fetchSnapshots(
    new ApiClient(new URL('https://api.example.com/api/'), TOKEN, {
      fetch: answer,
    }),
    {
      audience: 'public',
      languages: over.languages,
      releases: undefined,
      assetsDir,
      branding: over.branding ?? true,
      log: over.log ?? (() => undefined),
    },
  );
};

/** A resolved manual of module `a` holding `blocks`. */
const resolvedWith = (
  blocks: unknown[],
  origins: Record<string, unknown> = {},
) => ({
  data: {
    type: 'ResolvedManual',
    id: 'm/all/en',
    attributes: {
      title: 'M',
      lang: 'en',
      variant: {},
      entries: [
        { kind: 'module', module: 'a', title: 'A', lang: 'en', blocks },
      ],
      origins,
      anchors: {},
    },
  },
});

describe('the fetch step', () => {
  it('builds what the token reads', async () => {
    const [build] = await run(api({}));
    expect(
      build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.moduleAudiences,
    ).toEqual({ a: 'public' });
  });

  it('refuses a manual above its audience that the API listed', async () => {
    const lying = api({
      '/manuals': {
        data: [
          {
            type: 'Manual',
            id: 'm',
            attributes: { title: 'M', audience: 'internal' },
            meta: { variants: [] },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
    });
    await expect(run(lying)).rejects.toThrow(AudienceError);
  });

  it('refuses a module above its audience in a resolved manual, also one a reference brought in', async () => {
    const entry = api({
      '/manuals/m/variants/all/en': {
        data: {
          type: 'ResolvedManual',
          id: 'm/all/en',
          attributes: {
            title: 'M',
            lang: 'en',
            variant: {},
            entries: [
              {
                kind: 'module',
                module: 'b',
                title: 'B',
                lang: 'en',
                blocks: [],
              },
            ],
            origins: {},
            anchors: {},
          },
        },
      },
    });
    await expect(run(entry)).rejects.toThrow('module b for "internal"');
    const inlined = api({
      '/manuals/m/variants/all/en': {
        data: {
          type: 'ResolvedManual',
          id: 'm/all/en',
          attributes: {
            title: 'M',
            lang: 'en',
            variant: {},
            entries: [
              {
                kind: 'module',
                module: 'a',
                title: 'A',
                lang: 'en',
                blocks: [],
              },
            ],
            origins: { 'b--x': { module: 'b', block: 'x' } },
            anchors: {},
          },
        },
      },
    });
    await expect(run(inlined)).rejects.toThrow('module b for "internal"');
  });

  it('refuses a module the token cannot list', async () => {
    const unknown = api({
      '/modules': { data: [], meta: { page: { lastPage: 1 } } },
    });
    await expect(run(unknown)).rejects.toThrow(
      'whose audience the token cannot read',
    );
  });

  it('refuses a configured language that is no language tag: it would be a folder', async () => {
    const odd = api({
      '/config': {
        data: {
          type: 'ProjectConfig',
          id: 'project',
          attributes: { ...CONFIG, languages: { source: '../x', targets: [] } },
        },
      },
    });
    await expect(run(odd)).rejects.toThrow(
      'a configured language is not a language tag',
    );
  });

  it('leaves out a release with nothing for the audience', async () => {
    const empty = api({
      '/manuals': { data: [], meta: { page: { lastPage: 1 } } },
    });
    const [build] = await run(empty);
    expect(build!.snapshot.releases).toEqual([]);
  });

  it('leaves out a figure it cannot serve safely, and builds the rest', async () => {
    const svg =
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>';
    const hash = createHash('sha256').update(svg).digest('hex');
    const logged: string[] = [];
    const withFigure = api({
      '/manuals/m/variants/all/en': {
        data: {
          type: 'ResolvedManual',
          id: 'm/all/en',
          attributes: {
            title: 'M',
            lang: 'en',
            variant: {},
            entries: [
              {
                kind: 'module',
                module: 'a',
                title: 'A',
                lang: 'en',
                blocks: [
                  {
                    type: 'image',
                    id: 'a--i',
                    asset: `sha256:${hash}`,
                    alt: 'A figure',
                  },
                ],
              },
            ],
            origins: { 'a--i': { module: 'a', block: 'i' } },
            anchors: {},
          },
        },
      },
      [`/assets/${hash}`]: svg,
    });
    const [build] = await run(withFigure, { log: (line) => logged.push(line) });
    expect(build!.snapshot.assets).toEqual({});
    expect(logged).toContain(
      `Image ${hash} left out: an SVG with a DOCTYPE or an entity`,
    );
  });

  it('refuses two releases of one product', async () => {
    const release = (id: string) => ({
      data: {
        type: 'Release',
        id,
        attributes: {
          product: 'alpha',
          productFacet: 'product',
          revision: id,
          tag: TAG,
          publishedAt: '2026-11-01T00:00:00Z',
          notes: null,
          notesByLanguage: {},
          withdrawal: null,
        },
      },
    });
    const ids = [
      '0193a8d0-0000-7000-8000-000000000001',
      '0193a8d0-0000-7000-8000-000000000002',
    ];
    const two = api(
      Object.fromEntries(ids.map((id) => [`/releases/${id}`, release(id)])),
    );
    await expect(
      fetchSnapshots(
        new ApiClient(new URL('https://api.example.com/api/'), TOKEN, {
          fetch: two,
        }),
        {
          audience: 'public',
          languages: undefined,
          releases: ids,
          assetsDir,
          branding: false,
          log: () => undefined,
        },
      ),
    ).rejects.toThrow('two releases of one product');
  });

  it('refuses an ID it would write as a path', async () => {
    const odd = api({
      '/manuals': {
        data: [
          {
            type: 'Manual',
            id: '../m',
            attributes: { title: 'M', audience: 'public' },
            meta: { variants: [] },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
    });
    await expect(run(odd)).rejects.toThrow('not a safe path segment');
  });

  it('fails on an image whose bytes do not match its hash: the content changed or the store is corrupt', async () => {
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const hash = 'f'.repeat(64);
    const lying = api({
      '/manuals/m/variants/all/en': resolvedWith([
        { type: 'image', id: 'a--i', asset: `sha256:${hash}`, alt: 'A figure' },
      ]),
      [`/assets/${hash}`]: png,
    });
    await expect(run(lying)).rejects.toThrow(HashMismatchError);
  });

  it('fetches a refused figure once, however many variants and languages show it', async () => {
    const svg =
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>';
    const hash = createHash('sha256').update(svg).digest('hex');
    const figure = [
      { type: 'image', id: 'a--i', asset: `sha256:${hash}`, alt: 'A figure' },
    ];
    const resolved = (lang: string) => {
      const r = resolvedWith(figure);
      r.data.attributes.lang = lang;
      return r;
    };
    const twice = api({
      '/config': {
        data: {
          type: 'ProjectConfig',
          id: 'project',
          attributes: {
            ...CONFIG,
            languages: { source: 'en', targets: ['de'] },
          },
        },
      },
      '/manuals': {
        data: [
          {
            type: 'Manual',
            id: 'm',
            attributes: { title: 'M', audience: 'public' },
            meta: {
              variants: [
                { slug: 'one', label: 'One', values: {} },
                { slug: 'two', label: 'Two', values: {} },
              ],
            },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
      '/manuals/m/variants/one/en': resolved('en'),
      '/manuals/m/variants/two/en': resolved('en'),
      '/manuals/m/variants/one/de': resolved('de'),
      '/manuals/m/variants/two/de': resolved('de'),
      [`/assets/${hash}`]: svg,
    });
    const builds = await run(twice);
    expect(builds.map((b) => b.lang)).toEqual(['en', 'de']);
    expect(asked.filter((path) => path === `/assets/${hash}`)).toHaveLength(1);
  });

  it('writes each file as it arrives, once, and holds none in memory', async () => {
    const json = '{"a":1}';
    const hash = createHash('sha256').update(json).digest('hex');
    const withFile = api({
      '/manuals/m/variants/all/en': resolvedWith([
        {
          type: 'attachment',
          id: 'a--f',
          asset: `sha256:${hash}`,
          name: 'Data',
          fileName: 'data.json',
          mediaType: 'application/json',
          size: 7,
        },
      ]),
      [`/assets/${hash}`]: new TextEncoder().encode(json),
    });
    const [build] = await run(withFile);
    expect(readdirSync(assetsDir)).toEqual([`${hash}.json`]);
    expect(build!.snapshot.assets).toEqual({ [hash]: `${hash}.json` });
    expect(Object.keys(build!)).not.toContain('files');
  });

  it('names a download .bin when the file is written as .bin', async () => {
    const html = '<html><script>alert(1)</script></html>';
    const hash = createHash('sha256').update(html).digest('hex');
    const withFile = api({
      '/manuals/m/variants/all/en': resolvedWith([
        {
          type: 'attachment',
          id: 'a--f',
          asset: `sha256:${hash}`,
          name: 'Page',
          fileName: 'page.html',
          mediaType: 'text/html',
          size: html.length,
        },
      ]),
      [`/assets/${hash}`]: new TextEncoder().encode(html),
    });
    const [build] = await run(withFile);
    expect(build!.snapshot.assets).toEqual({ [hash]: `${hash}.bin` });
    const entry = (
      build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.resolved as {
        entries: { blocks: { fileName: string; mediaType: string }[] }[];
      }
    ).entries[0]!.blocks[0]!;
    expect(entry).toMatchObject({
      fileName: 'page.bin',
      mediaType: 'application/octet-stream',
    });
  });

  it('names a download by the file written, whatever its original name', async () => {
    const text = 'x<script>alert(1)</script>';
    const hash = createHash('sha256').update(text).digest('hex');
    const withFile = api({
      '/manuals/m/variants/all/en': resolvedWith([
        {
          type: 'attachment',
          id: 'a--f',
          asset: `sha256:${hash}`,
          name: 'Notes',
          fileName: 'notes.html',
          mediaType: 'text/plain',
          size: text.length,
        },
      ]),
      [`/assets/${hash}`]: new TextEncoder().encode(text),
    });
    const [build] = await run(withFile);
    expect(build!.snapshot.assets).toEqual({ [hash]: `${hash}.txt` });
    const entry = (
      build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.resolved as {
        entries: { blocks: { fileName: string; mediaType: string }[] }[];
      }
    ).entries[0]!.blocks[0]!;
    expect(entry).toMatchObject({
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    });
  });

  it('keeps an attachment whose hash a refused figure shares', async () => {
    const svg =
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>';
    const hash = createHash('sha256').update(svg).digest('hex');
    const both = api({
      '/manuals/m/variants/all/en': resolvedWith([
        { type: 'image', id: 'a--i', asset: `sha256:${hash}`, alt: 'A figure' },
        {
          type: 'attachment',
          id: 'a--f',
          asset: `sha256:${hash}`,
          name: 'Drawing',
          fileName: 'drawing.svg',
          mediaType: 'image/svg+xml',
          size: svg.length,
        },
      ]),
      [`/assets/${hash}`]: svg,
    });
    const [build] = await run(both);
    expect(build!.snapshot.assets).toEqual({ [hash]: `${hash}.bin` });
    expect(readdirSync(assetsDir)).toEqual([`${hash}.bin`]);
  });

  it('refuses configured languages that differ only in case: they would be one folder', async () => {
    const twins = api({
      '/config': {
        data: {
          type: 'ProjectConfig',
          id: 'project',
          attributes: {
            ...CONFIG,
            languages: { source: 'en', targets: ['EN'] },
          },
        },
      },
    });
    await expect(run(twins)).rejects.toThrow('differ only in case');
  });

  it('takes the stricter audience of a module in the language and in the source language it falls back to', async () => {
    const mixed = api({
      '/config': {
        data: {
          type: 'ProjectConfig',
          id: 'project',
          attributes: {
            ...CONFIG,
            languages: { source: 'en', targets: ['de'] },
          },
        },
      },
      '/modules': {
        data: [
          {
            type: 'Module',
            id: 'en/a',
            attributes: { moduleId: 'a', lang: 'en', audience: 'public' },
          },
          {
            type: 'Module',
            id: 'de/a',
            attributes: { moduleId: 'a', lang: 'de', audience: 'internal' },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
      '/manuals/m/variants/all/de': resolvedWith([]),
    });
    // English alone: its own file of `a` is public.
    const [en] = await run(mixed, { languages: ['en'] });
    expect(
      en!.snapshot.releases[0]!.manuals[0]!.variants[0]!.moduleAudiences,
    ).toEqual({ a: 'public' });
    // German: its file of `a` is internal.
    await expect(run(mixed, { languages: ['de'] })).rejects.toThrow(
      'module a for "internal"',
    );
    // A German file that is public does not lower its English source's audience.
    const viaSource = api({
      '/config': {
        data: {
          type: 'ProjectConfig',
          id: 'project',
          attributes: {
            ...CONFIG,
            languages: { source: 'en', targets: ['de'] },
          },
        },
      },
      '/modules': {
        data: [
          {
            type: 'Module',
            id: 'en/a',
            attributes: { moduleId: 'a', lang: 'en', audience: 'internal' },
          },
          {
            type: 'Module',
            id: 'de/a',
            attributes: { moduleId: 'a', lang: 'de', audience: 'public' },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
      '/manuals/m/variants/all/de': resolvedWith([]),
    });
    await expect(run(viaSource, { languages: ['de'] })).rejects.toThrow(
      'module a for "internal"',
    );
  });

  describe('update guides (#907)', () => {
    const guideApi = (steps: unknown[]) =>
      api({
        '/manuals': {
          data: [
            {
              type: 'Manual',
              id: 'g',
              attributes: {
                kind: 'update-guide',
                title: 'G',
                audience: 'public',
              },
              meta: {
                variants: [
                  { slug: 'one', label: 'One', values: {} },
                  { slug: 'two', label: 'Two', values: {} },
                ],
              },
            },
          ],
          meta: { page: { lastPage: 1 } },
        },
        '/manuals/g/variants/one/en': {
          data: {
            type: 'ResolvedManual',
            id: 'g/one/en',
            attributes: {
              title: 'G',
              lang: 'en',
              variant: {},
              entries: [
                {
                  kind: 'module',
                  module: 'a',
                  title: 'A',
                  lang: 'en',
                  blocks: [],
                },
              ],
              origins: {},
              anchors: {},
            },
          },
        },
        '/manuals/g/update-guide/en': {
          data: {
            type: 'UpdateGuide',
            id: 'g/en',
            attributes: {
              title: 'G',
              lang: 'en',
              attribute: { id: 'software', label: 'Software' },
              versions: ['1.0', '2.0'],
              levels: [{ id: 'public', label: 'Public' }],
              options: [
                {
                  id: 'cluster',
                  label: 'Cluster',
                  values: [
                    { id: 'yes', label: 'Yes' },
                    { id: 'no', label: 'No' },
                  ],
                },
              ],
            },
          },
        },
        '/manuals/g/update-guide/en/steps': {
          data: steps,
          meta: { page: { lastPage: 1 } },
        },
      });
    const step = (module: string, level: string | null = null) => ({
      type: 'UpdateGuideStep',
      id: level === null ? module : `${module}--2`,
      attributes: {
        module,
        title: module.toUpperCase(),
        lang: 'en',
        version: '2.0',
        phase: 'before',
        level,
        when: { op: 'in', attr: 'cluster', values: ['yes'] },
        condition: 'cluster in (yes)',
        blocks: [],
      },
    });

    it('reads the guide and its steps, and only its first variant', async () => {
      const [build] = await run(guideApi([step('a')]));
      const manual = build!.snapshot.releases[0]!.manuals[0]!;
      expect(manual.variants.map((v) => v.slug)).toEqual(['one']);
      expect(manual.guide).toEqual({
        attribute: { id: 'software', label: 'Software' },
        versions: ['1.0', '2.0'],
        levels: [{ id: 'public', label: 'Public' }],
        options: [
          {
            id: 'cluster',
            label: 'Cluster',
            values: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
        steps: [
          {
            id: 'a',
            module: 'a',
            title: 'A',
            version: '2.0',
            phase: 'before',
            level: null,
            when: { op: 'in', attr: 'cluster', values: ['yes'] },
          },
        ],
      });
      expect(asked).not.toContain('/manuals/g/variants/two/en');
    });

    it('leaves out a step for a level above the build’s audience, or for no configured level', async () => {
      const lines: string[] = [];
      const [build] = await run(
        guideApi([step('a'), step('a', 'internal'), step('a', 'nobody')]),
        { log: (line) => lines.push(line) },
      );
      const guide = build!.snapshot.releases[0]!.manuals[0]!.guide!;
      expect(guide.steps.map((s) => s.level)).toEqual([null]);
      expect(lines.filter((l) => l.includes('left out, above'))).toHaveLength(
        2,
      );
    });

    it('refuses a step whose module the resolved guide does not hold', async () => {
      await expect(run(guideApi([step('b')]))).rejects.toThrow(AudienceError);
    });
  });

  describe('the branding (#784)', () => {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const PNG_HASH = createHash('sha256').update(PNG).digest('hex');
    const branding = (over: Record<string, unknown> = {}, meta = {}) => ({
      '/branding': {
        data: {
          type: 'Branding',
          id: 'branding',
          attributes: {
            productName: 'Corvel',
            logoLight: `sha256:${PNG_HASH}`,
            logoDark: null,
            mark: null,
            favicon: `sha256:${PNG_HASH}`,
            appIcon: null,
            primary: '#1d4f91',
            accent: null,
            ...over,
          },
          meta: {
            tokens: {
              light: { primary: '#1d4f91', 'primary-foreground': '#ffffff' },
              dark: { primary: '#7bb0fa', unknown: '#000000' },
            },
            contrast: [
              {
                theme: 'light',
                pair: 'primary-foreground/primary',
                colour: 'primary',
                ratio: 8.1,
                required: 4.5,
              },
            ],
            ...meta,
          },
        },
      },
      [`/branding/images/${PNG_HASH}`]: new Uint8Array(PNG),
    });

    it('carries the name, the images (checked, written once) and the colour tokens', async () => {
      const [build] = await run(api(branding()));
      expect(build!.snapshot.branding).toEqual({
        productName: 'Corvel',
        logoLight: `${PNG_HASH}.png`,
        logoDark: null,
        mark: null,
        favicon: `${PNG_HASH}.png`,
        appIcon: null,
        // Only the tokens a brand may set.
        tokens: {
          light: { primary: '#1d4f91', 'primary-foreground': '#ffffff' },
          dark: { primary: '#7bb0fa' },
        },
      });
      expect(readFileSync(join(assetsDir, `${PNG_HASH}.png`))).toEqual(PNG);
      expect(asked.filter((p) => p.startsWith('/branding/images/'))).toEqual([
        `/branding/images/${PNG_HASH}`,
        `/branding/images/${PNG_HASH}`,
      ]);
    });

    it('asks nothing with the branding off, and builds the default look', async () => {
      const [build] = await run(api(branding()), { branding: false });
      expect(build!.snapshot.branding).toBeNull();
      expect(asked.some((p) => p.startsWith('/branding'))).toBe(false);
    });

    it('builds the default look when nothing is set, or the API has no branding', async () => {
      const none = branding(
        {
          productName: null,
          logoLight: null,
          favicon: null,
          primary: null,
        },
        { tokens: null, contrast: [] },
      );
      expect((await run(api(none)))[0]!.snapshot.branding).toBeNull();
      // The fake answers 404 for a route it does not have.
      expect((await run(api({})))[0]!.snapshot.branding).toBeNull();
    });

    it('fails on an image whose bytes do not match its hash', async () => {
      const lying = api({
        ...branding(),
        [`/branding/images/${PNG_HASH}`]: new Uint8Array([1, 2, 3]),
      });
      await expect(run(lying)).rejects.toThrow(HashMismatchError);
    });

    it('leaves out an image that is no PNG or WebP, and colours whose contrast fails', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
      const svgHash = createHash('sha256').update(svg).digest('hex');
      const logged: string[] = [];
      const [build] = await run(
        api({
          ...branding(
            { logoLight: `sha256:${svgHash}`, favicon: null },
            {
              contrast: [
                {
                  theme: 'dark',
                  pair: 'primary-foreground/primary',
                  colour: 'primary',
                  ratio: 2.1,
                  required: 4.5,
                },
              ],
            },
          ),
          [`/branding/images/${svgHash}`]: svg,
        }),
        { log: (line) => logged.push(line) },
      );
      expect(build!.snapshot.branding).toMatchObject({
        productName: 'Corvel',
        logoLight: null,
        tokens: null,
      });
      expect(logged.join('\n')).toContain('not a PNG or WebP');
      expect(logged.join('\n')).toContain('contrast is too low');
    });

    it('leaves out an image that is gone since, and colours with no contrast checks', async () => {
      const logged: string[] = [];
      const [build] = await run(
        api({
          ...branding({ favicon: null }, { contrast: undefined }),
          [`/branding/images/${PNG_HASH}`]: undefined as never,
        }),
        { log: (line) => logged.push(line) },
      );
      expect(build!.snapshot.branding).toMatchObject({
        productName: 'Corvel',
        logoLight: null,
        tokens: null,
      });
      expect(logged.join('\n')).toContain('no contrast checks');
    });

    it('refuses a product name with control characters', async () => {
      const [build] = await run(
        api(
          branding({
            productName: 'Cor\u0007vel',
            logoLight: null,
            favicon: null,
          }),
        ),
      );
      // The colours still apply; the name does not.
      expect(build!.snapshot.branding?.productName).toBeNull();
    });
  });

  describe('the PDFs (#784)', () => {
    const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const PDF_HASH = createHash('sha256').update(PDF).digest('hex');
    const RELEASE = '0193a8d0-0000-7000-8000-000000000001';
    const OUTPUT = '0193a8d0-0000-7000-8000-0000000000aa';
    const outputs = (over: Record<string, unknown> = {}) => ({
      [`/releases/${RELEASE}/outputs`]: {
        data: [
          {
            type: 'ReleaseOutput',
            id: OUTPUT,
            attributes: {
              manual: 'm',
              variant: 'all',
              lang: 'en',
              kind: 'pdf',
              // As the API sends it: a manual's PDF has the manual's audience, none of its own.
              audience: null,
              state: 'done',
              sha256: PDF_HASH,
              ...over,
            },
          },
        ],
        meta: { page: { lastPage: 1 } },
      },
      [`/releases/${RELEASE}/outputs/${OUTPUT}/file`]: PDF,
    });

    it('carries each variant’s PDF, checked against its hash', async () => {
      const [build] = await run(api(outputs()), { branding: false });
      expect(build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.pdf).toEqual(
        {
          file: `${PDF_HASH}.pdf`,
          size: PDF.byteLength,
          name: 'm_all_en_1.0.pdf',
        },
      );
      expect(readFileSync(join(assetsDir, `${PDF_HASH}.pdf`))).toEqual(
        Buffer.from(PDF),
      );
    });

    it('never fetches the PDF of a manual or variant the build does not hold', async () => {
      const other = '0193a8d0-0000-7000-8000-0000000000bb';
      const list = outputs();
      const listed = list[`/releases/${RELEASE}/outputs`] as {
        data: { attributes: Record<string, unknown> }[];
      };
      listed.data.push({
        type: 'ReleaseOutput',
        id: other,
        attributes: { ...listed.data[0]!.attributes, manual: 'not-built' },
      } as never);
      await run(api(list), { branding: false });
      expect(asked).toContain(`/releases/${RELEASE}/outputs/${OUTPUT}/file`);
      expect(asked.some((p) => p.includes(other))).toBe(false);
    });

    it('builds without PDFs where the release has none', async () => {
      const [build] = await run(api({}), { branding: false });
      expect(
        build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.pdf,
      ).toBeNull();
    });

    it('refuses a PDF that says it is above the build’s audience', async () => {
      await expect(
        run(api(outputs({ audience: 'internal' })), { branding: false }),
      ).rejects.toThrow(AudienceError);
    });

    it('fails on a PDF whose bytes do not match its hash, and leaves out one that is no PDF', async () => {
      await expect(
        run(
          api({
            ...outputs(),
            [`/releases/${RELEASE}/outputs/${OUTPUT}/file`]: new Uint8Array([
              1, 2,
            ]),
          }),
          { branding: false },
        ),
      ).rejects.toThrow(HashMismatchError);
      const notPdf = new TextEncoder().encode('<html></html>');
      const notPdfHash = createHash('sha256').update(notPdf).digest('hex');
      const [build] = await run(
        api({
          ...outputs({ sha256: notPdfHash }),
          [`/releases/${RELEASE}/outputs/${OUTPUT}/file`]: notPdf,
        }),
        { branding: false },
      );
      expect(
        build!.snapshot.releases[0]!.manuals[0]!.variants[0]!.pdf,
      ).toBeNull();
    });
  });
});
