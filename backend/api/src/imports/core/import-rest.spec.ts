import { createHash } from 'node:crypto';
import { type ImportBundle, validateImport } from '@openfolia/content-model';
import { actorWith } from '../../../tests/fakes/actors.js';
import { config, readable } from '../../../tests/fakes/fake-content.js';
import type { ImportReport } from './import.js';
import {
  decidesRestAlike,
  planWithRest,
  withoutRefused,
} from './import-rest.js';

const editor = actorWith(['content.edit', 'content.read']);
const settings = {
  maxImageBytes: 1024 * 1024,
  maxAttachmentBytes: 1024 * 1024,
  attachmentTypes: { allow: [], deny: [], open: [] },
} as never;

const NOT_AN_IMAGE = Buffer.from('not an image at all');
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const moduleJson = (
  id: string,
  { type = 'concept', blocks }: { type?: string; blocks?: unknown[] } = {},
) => ({
  schemaVersion: 1,
  id,
  meta: { title: id, type, lang: 'en', audience: 'public' },
  blocks: blocks ?? [
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'Hello.' }],
    },
  ],
});

const manualJson = (id: string, modules: string[]) => ({
  schemaVersion: 1,
  id,
  title: id,
  audience: 'public',
  variants: [{ model: 'small' }],
  entries: modules.map((module) => ({ module })),
});

function bundle(
  document: unknown,
  files: Record<string, Uint8Array> = {},
): ImportBundle {
  return {
    files: new Map<string, Uint8Array>([
      ['import.json', Buffer.from(JSON.stringify(document))],
      ...Object.entries(files),
    ]),
  };
}

const validated: ImportBundle[] = [];
const validate = (b: ImportBundle) => {
  validated.push(b);
  return validateImport(b, config, {
    existing: {
      modules: new Set<string>(),
      manuals: new Set<string>(),
      assets: new Set<string>(),
    },
  });
};

const plan = (b: ImportBundle) =>
  planWithRest(b, validate, {
    actor: editor,
    snapshot: readable({ config, modules: [], manifests: [] }, editor),
    config,
    updateExisting: false,
    settings,
  });

const actions = (report: ImportReport) =>
  report.items.map((i) => `${i.kind} ${i.id} ${i.action}`);

beforeEach(() => {
  validated.length = 0;
});

describe('planWithRest (#758)', () => {
  it('lets the rest be applied when nothing else needs the refused items', async () => {
    const p = await plan(
      bundle({
        formatVersion: 1,
        modules: [moduleJson('good'), moduleJson('broken', { type: 'nope' })],
        manuals: [manualJson('guide', ['good'])],
      }),
    );
    expect(actions(p.report)).toEqual([
      'module good create',
      'module broken refuse',
      'manual guide create',
    ]);
    expect(p.report).toMatchObject({
      applicable: false,
      applicableWithoutRefused: true,
    });
    // The writes are the rest, never the refused module.
    expect(p.writes.map((w) => w.subject)).toEqual([
      expect.objectContaining({ type: 'module', moduleId: 'good' }),
      expect.objectContaining({ type: 'manual', manualId: 'guide' }),
    ]);
    // Checked twice: the bundle, then the bundle without the refused module.
    expect(validated).toHaveLength(2);
  });

  it('does not when a manual names a refused module', async () => {
    const p = await plan(
      bundle({
        formatVersion: 1,
        modules: [moduleJson('good'), moduleJson('broken', { type: 'nope' })],
        manuals: [manualJson('guide', ['good', 'broken'])],
      }),
    );
    expect(actions(p.report)).toEqual([
      'module good create',
      'module broken refuse',
      'manual guide create',
    ]);
    expect(p.report.applicableWithoutRefused).toBe(false);
  });

  it('does not when a written module uses a refused file', async () => {
    const hash = sha(NOT_AN_IMAGE);
    const p = await plan(
      bundle(
        {
          formatVersion: 1,
          modules: [
            moduleJson('pictured', {
              blocks: [
                {
                  type: 'image',
                  id: 'figure',
                  asset: `sha256:${hash}`,
                  alt: 'A figure',
                },
              ],
            }),
            moduleJson('plain'),
          ],
        },
        { [`assets/${hash}`]: NOT_AN_IMAGE },
      ),
    );
    expect(actions(p.report)).toEqual([
      'module pictured create',
      'module plain create',
      `asset sha256:${hash} refuse`,
    ]);
    expect(p.report.applicableWithoutRefused).toBe(false);
  });

  it('checks only once when nothing is refused, or when the bundle itself has an error', async () => {
    const clean = await plan(
      bundle({ formatVersion: 1, modules: [moduleJson('good')] }),
    );
    expect(clean.report).toMatchObject({
      applicable: true,
      applicableWithoutRefused: true,
    });
    expect(validated).toHaveLength(1);
    validated.length = 0;
    const onlyRefused = await plan(
      bundle({
        formatVersion: 1,
        modules: [moduleJson('broken', { type: 'nope' })],
      }),
    );
    expect(onlyRefused.report.applicableWithoutRefused).toBe(false);
    expect(validated).toHaveLength(1);
  });
});

describe('withoutRefused', () => {
  const refusedAt = (pointer: string, kind: 'module' | 'manual' | 'asset') =>
    ({
      items: [
        {
          kind,
          id: 'x',
          pointer,
          action: 'refuse',
          reasons: [],
          issues: [],
          issueCount: 0,
        },
      ],
    }) as unknown as ImportReport;

  it('takes the refused modules, manuals and files out, and nothing else', () => {
    const hash = 'a'.repeat(64);
    const b = bundle(
      {
        formatVersion: 1,
        source: { system: 'Somewhere' },
        modules: [{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }],
        manuals: [{ id: 'g0' }],
      },
      {
        [`assets/${hash}`]: Buffer.from('x'),
        'assets/other': Buffer.from('y'),
      },
    );
    const report = {
      items: [
        ...refusedAt('/modules/1', 'module').items,
        ...refusedAt('/manuals/0', 'manual').items,
        ...refusedAt(`assets/${hash}`, 'asset').items,
        { ...refusedAt('/modules/0', 'module').items[0], action: 'create' },
      ],
    } as unknown as ImportReport;
    const rest = withoutRefused(b, report);
    expect([...(rest?.files.keys() ?? [])].sort()).toEqual([
      'assets/other',
      'import.json',
    ]);
    expect(
      JSON.parse(Buffer.from(rest?.files.get('import.json') ?? []).toString()),
    ).toEqual({
      formatVersion: 1,
      source: { system: 'Somewhere' },
      modules: [{ id: 'm0' }, { id: 'm2' }],
      manuals: [],
    });
  });

  it('gives up on a place it cannot take out', () => {
    const b = bundle({ formatVersion: 1, modules: [{ id: 'm0' }] });
    for (const [pointer, kind] of [
      ['/modules/1', 'module'],
      ['/modules/01', 'module'],
      ['/modules/-1', 'module'],
      ['/manuals/0', 'manual'],
      ['/manuals/0', 'module'],
      ['/modules/0/blocks/0', 'module'],
      [`assets/${'b'.repeat(64)}`, 'asset'],
      ['assets/../import.json', 'asset'],
    ] as const) {
      expect(withoutRefused(b, refusedAt(pointer, kind))).toBeUndefined();
    }
  });
});

describe('decidesRestAlike', () => {
  const item = (id: string, action: string) => ({ kind: 'module', id, action });
  const r = (...items: ReturnType<typeof item>[]) =>
    ({ items }) as unknown as ImportReport;

  it('holds only when every unrefused item is decided the same, in order', () => {
    const before = r(
      item('a', 'create'),
      item('b', 'refuse'),
      item('c', 'skip'),
    );
    expect(
      decidesRestAlike(before, r(item('a', 'create'), item('c', 'skip'))),
    ).toBe(true);
    expect(
      decidesRestAlike(before, r(item('a', 'create'), item('c', 'create'))),
    ).toBe(false);
    expect(decidesRestAlike(before, r(item('a', 'create')))).toBe(false);
    expect(
      decidesRestAlike(before, r(item('c', 'skip'), item('a', 'create'))),
    ).toBe(false);
  });
});
