import {
  AudienceError,
  checkManual,
  checkModules,
  checkReader,
  modulesOf,
} from '../build/audience.ts';
import { parseSnapshot, SNAPSHOT_FORMAT } from '../src/lib/snapshot.ts';

const LEVELS = [{ id: 'public' }, { id: 'internal' }, { id: 'restricted' }];
const me = (
  ...roles: { permissions: string[]; scope: Record<string, unknown> }[]
) => ({
  attributes: {
    kind: 'service',
    roles: roles.map((r, i) => ({ id: `r${i}`, ...r })),
  },
});
const reads = (maxAudience?: string, extra: Record<string, unknown> = {}) => ({
  permissions: ['content.read'],
  scope: { ...(maxAudience !== undefined && { maxAudience }), ...extra },
});

describe('the token', () => {
  it('may read up to the build audience, and only content.read', () => {
    expect(() =>
      checkReader(me(reads('public')), LEVELS, 'public'),
    ).not.toThrow();
    expect(() =>
      checkReader(
        me(reads('public', { languages: ['de'] })),
        LEVELS,
        'internal',
      ),
    ).not.toThrow();
  });

  it.each([
    [me(reads('internal')), 'reads up to "internal"'],
    [me(reads()), 'reads every audience level'],
    [
      me({
        permissions: ['content.read', 'content.read.draft'],
        scope: { maxAudience: 'public' },
      }),
      'holds content.read.draft',
    ],
    [
      me({ permissions: ['content.edit'], scope: { maxAudience: 'public' } }),
      'holds content.edit',
    ],
    [me(reads('public'), reads('restricted')), 'reads up to "restricted"'],
    [me(reads('unknown')), 'reads up to "unknown"'],
    [me(), 'holds no role'],
    [
      { attributes: { kind: 'user', roles: [reads('public')] } },
      'does not act as a service account',
    ],
  ])('is refused when it may read or do more (%#)', (actor, message) => {
    expect(() => checkReader(actor, LEVELS, 'public')).toThrow(AudienceError);
    expect(() => checkReader(actor, LEVELS, 'public')).toThrow(message);
  });

  it('is refused for an audience the configuration does not know', () => {
    expect(() => checkReader(me(reads('public')), LEVELS, 'everyone')).toThrow(
      'not a configured audience level',
    );
  });
});

describe('the content', () => {
  it('refuses a manual above the audience; one without an audience is the most restricted level', () => {
    expect(checkManual({ id: 'm', audience: 'public' }, LEVELS, 'public')).toBe(
      'public',
    );
    expect(() =>
      checkManual({ id: 'm', audience: 'internal' }, LEVELS, 'public'),
    ).toThrow(AudienceError);
    expect(() =>
      checkManual({ id: 'm', audience: undefined }, LEVELS, 'internal'),
    ).toThrow('for "restricted"');
    expect(
      checkManual({ id: 'm', audience: undefined }, LEVELS, 'restricted'),
    ).toBe('restricted');
  });

  it('finds every module: entries, groups and what references brought in', () => {
    const resolved = {
      entries: [
        { kind: 'module', module: 'a', blocks: [] },
        {
          kind: 'group',
          title: 'G',
          entries: [{ kind: 'module', module: 'b', blocks: [] }],
        },
      ],
      origins: {
        'a--x': { module: 'a', block: 'x' },
        'c--y': { module: 'c', block: 'y' },
      },
    };
    expect([...modulesOf(resolved)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds the modules from the blocks themselves, whatever origins says', () => {
    // Blocks inlined by a module reference carry their own module in their ID (`module--block`),
    // in sections, list items, procedure steps and table cells too; origins may leave them out.
    const block = (id: string, more: Record<string, unknown> = {}) => ({
      type: 'paragraph',
      id,
      content: [],
      ...more,
    });
    const resolved = {
      entries: [
        {
          kind: 'module',
          module: 'a',
          blocks: [
            block('a--p'),
            {
              type: 'section',
              id: 'a--s',
              title: [],
              blocks: [block('b--p')],
            },
            {
              type: 'list',
              id: 'a--l',
              items: [{ id: 'c--i', content: [], blocks: [block('d--p')] }],
            },
            {
              type: 'procedure',
              id: 'a--pr',
              steps: [{ id: 'a--st', content: [], blocks: [] }],
            },
            {
              type: 'table',
              id: 'a--t',
              rows: [{ cells: [{ blocks: [block('e--p--2')] }] }],
            },
          ],
        },
      ],
      origins: {},
    };
    expect([...modulesOf(resolved)].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('counts the modules a cross-reference names by their titles (#796)', () => {
    const resolved = {
      entries: [{ kind: 'module', module: 'a', blocks: [] }],
      origins: {},
      xrefTitles: { elsewhere: 'Elsewhere' },
    };
    expect([...modulesOf(resolved)].sort()).toEqual(['a', 'elsewhere']);
  });

  it('refuses a block whose ID does not name its module', () => {
    const resolved = {
      entries: [
        {
          kind: 'module',
          module: 'a',
          blocks: [{ type: 'paragraph', id: 'p', content: [] }],
        },
      ],
      origins: {},
    };
    expect(() => modulesOf(resolved)).toThrow(AudienceError);
    expect(() =>
      modulesOf({
        entries: [{ kind: 'module', module: 'a', blocks: [{ type: 'x' }] }],
      }),
    ).toThrow('does not name its module');
  });

  it('refuses a module above the audience, and one whose audience it cannot read', () => {
    const audiences: Record<string, string> = { a: 'public', b: 'internal' };
    const of = (id: string) => audiences[id];
    expect(checkModules('m', ['a'], of, LEVELS, 'public')).toEqual({
      a: 'public',
    });
    expect(() => checkModules('m', ['a', 'b'], of, LEVELS, 'public')).toThrow(
      'module b for "internal"',
    );
    expect(() => checkModules('m', ['c'], of, LEVELS, 'restricted')).toThrow(
      'cannot read',
    );
  });

  it('checks a snapshot again when the pages read it', () => {
    const snapshot = (moduleAudience: string) => ({
      format: SNAPSHOT_FORMAT,
      audience: 'public',
      audiences: LEVELS.map(({ id }) => ({ id, label: id })),
      lang: 'en',
      dir: 'ltr',
      languages: ['en'],
      variantAttributes: [],
      safetySymbols: [],
      outputLabels: {},
      releases: [
        {
          id: 'r',
          product: 'alpha',
          productLabel: 'Alpha',
          revision: '1',
          tag: 't',
          publishedAt: '2026-01-01T00:00:00Z',
          notes: null,
          manuals: [
            {
              id: 'm',
              title: 'M',
              audience: 'public',
              variants: [
                {
                  slug: 'x=y',
                  label: 'Y',
                  values: {},
                  resolved: {},
                  moduleAudiences: { a: moduleAudience },
                  pdf: null,
                },
              ],
            },
          ],
        },
      ],
      assets: {},
      symbols: {},
      branding: null,
    });
    expect(parseSnapshot(snapshot('public')).releases).toHaveLength(1);
    expect(() => parseSnapshot(snapshot('internal'))).toThrow(
      'above the build',
    );
  });

  it('recomputes the modules a resolved manual holds when the pages read it', () => {
    const resolved = {
      entries: [
        {
          kind: 'module',
          module: 'a',
          blocks: [{ type: 'paragraph', id: 'b--p', content: [] }],
        },
      ],
      origins: {},
    };
    const snapshot = (moduleAudiences: Record<string, string>) => ({
      format: SNAPSHOT_FORMAT,
      audience: 'public',
      audiences: LEVELS.map(({ id }) => ({ id, label: id })),
      lang: 'en',
      dir: 'ltr',
      languages: ['en'],
      variantAttributes: [],
      safetySymbols: [],
      outputLabels: {},
      releases: [
        {
          id: 'r',
          product: 'alpha',
          productLabel: 'Alpha',
          revision: '1',
          tag: 't',
          publishedAt: '2026-01-01T00:00:00Z',
          notes: null,
          manuals: [
            {
              id: 'm',
              title: 'M',
              audience: 'public',
              variants: [
                {
                  slug: 'x=y',
                  label: 'Y',
                  values: {},
                  resolved,
                  moduleAudiences,
                  pdf: null,
                },
              ],
            },
          ],
        },
      ],
      assets: {},
      symbols: {},
      branding: null,
    });
    expect(() => parseSnapshot(snapshot({ a: 'public' }))).toThrow(
      'module b in manual m has no checked audience',
    );
    expect(
      parseSnapshot(snapshot({ a: 'public', b: 'public' })).releases,
    ).toHaveLength(1);
  });

  it('checks an update guide’s steps and levels when the pages read it (#907)', () => {
    const snapshot = (
      step: string,
      level: string,
      stepLevel: string | null = null,
    ) => ({
      format: SNAPSHOT_FORMAT,
      audience: 'public',
      audiences: LEVELS.map(({ id }) => ({ id, label: id })),
      lang: 'en',
      dir: 'ltr',
      languages: ['en'],
      variantAttributes: [],
      safetySymbols: [],
      outputLabels: {},
      releases: [
        {
          id: 'r',
          product: 'alpha',
          productLabel: 'Alpha',
          revision: '1',
          tag: 't',
          publishedAt: '2026-01-01T00:00:00Z',
          notes: null,
          manuals: [
            {
              id: 'g',
              title: 'G',
              audience: 'public',
              variants: [
                {
                  slug: 'x=y',
                  label: 'Y',
                  values: {},
                  resolved: {},
                  moduleAudiences: { a: 'public' },
                  pdf: null,
                },
              ],
              guide: {
                attribute: { id: 'software', label: 'Software' },
                versions: ['1.0', '2.0'],
                levels: [{ id: level, label: level }],
                options: [],
                steps: [
                  {
                    id: step,
                    module: step,
                    title: 'S',
                    version: '2.0',
                    phase: 'after',
                    level: stepLevel,
                    when: null,
                  },
                ],
              },
            },
          ],
        },
      ],
      assets: {},
      symbols: {},
      branding: null,
    });
    expect(parseSnapshot(snapshot('a', 'public')).releases).toHaveLength(1);
    expect(() => parseSnapshot(snapshot('b', 'public'))).toThrow(
      'step b in update guide g has no checked audience',
    );
    expect(() => parseSnapshot(snapshot('a', 'internal'))).toThrow(
      'offers the level "internal", above the build',
    );
    expect(() => parseSnapshot(snapshot('a', 'public', 'internal'))).toThrow(
      'is for the level "internal", above the build',
    );
  });
});
