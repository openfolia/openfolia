import { actorWith, NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { module, readable } from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import type { Module } from '@openfolia/content-model';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { ExportTermsAction } from './export-terms.action.js';
import { GetTermAction } from './get-term.action.js';
import { ListTermsAction, type TermFilter } from './list-terms.action.js';

const terms: Record<string, string> = {
  charger: `schemaVersion: 1
status: approved
domain: Charging
languages:
  de:
    preferred: Ladegerät
  en:
    preferred: charger
    forbidden:
      - term: loader
    definition: The device that charges the **battery**.
`,
  housing: `schemaVersion: 1
status: proposed
domain: mechanics
languages:
  en:
    preferred: housing
    definition: The outer shell.
`,
  'power-pack': `schemaVersion: 1
status: deprecated
replacedBy: charger
languages:
  en:
    preferred: power pack
  it:
    preferred: alimentatore
`,
  broken: 'status: [\n',
};

const page = { number: 1, size: 50 };
const snapshot = () => readable({ terms });

describe('ListTermsAction', () => {
  const action = new ListTermsAction();
  const ids = async (filter: TermFilter, actor = READER) =>
    (
      await action.handle({ actor, snapshot: snapshot(), filter, page })
    ).items.map((entry) => entry.id);

  it('lists every term by ID, a broken file with why, and the issues of each', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      filter: {},
      page,
    });
    expect(result.total).toBe(4);
    expect(result.items.map((e) => e.id)).toEqual([
      'broken',
      'charger',
      'housing',
      'power-pack',
    ]);
    expect(result.items[0]).toEqual({
      id: 'broken',
      error: expect.stringContaining('terms/broken.yaml'),
    });
    const powerPack = result.items[3];
    expect(powerPack && 'issues' in powerPack && powerPack.issues).toEqual([
      expect.objectContaining({ code: 'unknown-language', at: 'it' }),
    ]);
  });

  it('filters before paging, and a filter leaves broken files out', async () => {
    expect(await ids({ status: 'approved' })).toEqual(['charger']);
    expect(await ids({ domain: 'charging' })).toEqual(['charger']);
    expect(await ids({ lang: 'de' })).toEqual(['charger']);
    const second = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      filter: { lang: 'en' },
      page: { number: 2, size: 2 },
    });
    expect(second).toEqual({
      total: 3,
      items: [expect.objectContaining({ id: 'power-pack' })],
    });
  });

  it('finds a term by a forbidden variant and by its definition, folded', async () => {
    expect(await ids({ q: 'LOADER' })).toEqual(['charger']);
    expect(await ids({ q: 'ladegerat' })).toEqual(['charger']);
    expect(await ids({ q: 'charges the battery' })).toEqual(['charger']);
    expect(await ids({ q: 'shell' })).toEqual(['housing']);
    // In the language asked for only.
    expect(await ids({ q: 'loader', lang: 'de' })).toEqual([]);
    expect(await ids({ q: 'nothing' })).toEqual([]);
  });

  it('lets every reader read the terms, and nobody else', async () => {
    const narrow = actorWith(['content.read'], {
      languages: ['de'],
      maxAudience: 'public',
    });
    expect(await ids({}, narrow)).toEqual([
      'broken',
      'charger',
      'housing',
      'power-pack',
    ]);
    await expect(ids({}, NOBODY)).rejects.toThrow(ForbiddenError);
  });
});

describe('GetTermAction', () => {
  const linking = (id: string, lang: string): Module => {
    const m = module(id, lang);
    return {
      ...m,
      meta: { ...m.meta, title: `About ${id}` },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [
            {
              type: 'text',
              text: 'charger',
              marks: [{ type: 'term', termId: 'charger' }],
            },
          ],
        },
      ],
    };
  };
  const history = new FakeHistory({
    terms,
    modules: [linking('zeta', 'en'), linking('alpha', 'de'), module('plain')],
  });
  const action = new GetTermAction(fakeModuleIndex(history).readable);
  const snapshot = () =>
    history.openSnapshot.handle({ actor: READER, ref: 'main' });

  it('reads a term with its issues, and the modules the reader sees linking it (#245)', async () => {
    const { term, issues, usage } = await action.handle({
      actor: READER,
      snapshot: await snapshot(),
      id: 'charger',
    });
    expect(usage).toEqual({
      modules: 2,
      uses: [
        { moduleId: 'alpha', lang: 'de', title: 'About alpha' },
        { moduleId: 'zeta', lang: 'en', title: 'About zeta' },
      ],
    });
    expect(
      (
        await action.handle({
          actor: READER,
          snapshot: await snapshot(),
          id: 'housing',
        })
      ).usage,
    ).toEqual({ modules: 0, uses: [] });
    // One reading German only is told of the German module alone.
    const german = actorWith(['content.read'], { languages: ['de'] });
    expect(
      (
        await action.handle({
          actor: german,
          snapshot: await history.openSnapshot.handle({
            actor: german,
            ref: 'main',
          }),
          id: 'charger',
        })
      ).usage,
    ).toEqual({
      modules: 1,
      uses: [{ moduleId: 'alpha', lang: 'de', title: 'About alpha' }],
    });
    expect(term.languages['en']?.definition).toEqual([
      { type: 'text', text: 'The device that charges the ' },
      { type: 'text', text: 'battery', marks: [{ type: 'strong' }] },
      { type: 'text', text: '.' },
    ]);
    expect(issues).toEqual([]);
  });

  it('does not find what is not there, and refuses a file that is no term', async () => {
    await expect(
      action.handle({ actor: READER, snapshot: await snapshot(), id: 'nope' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      action.handle({
        actor: READER,
        snapshot: await snapshot(),
        id: 'broken',
      }),
    ).rejects.toThrow(InvalidContentError);
    await expect(
      action.handle({
        actor: NOBODY,
        snapshot: await snapshot(),
        id: 'charger',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('ExportTermsAction', () => {
  const action = new ExportTermsAction();

  it('exports every term as CSV, broken files left out', async () => {
    const file = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      format: 'csv',
    });
    expect(file.type).toBe('text/csv; charset=utf-8; header=present');
    expect(file.fileName).toBe('terms.csv');
    expect(file.count).toBe(3);
    expect(file.body.split('\r\n').map((row) => row.split(',')[0])).toEqual([
      'id',
      'charger',
      'charger',
      'housing',
      'power-pack',
      'power-pack',
      '',
    ]);
  });

  it('exports one language as TBX, leaving out the terms without it', async () => {
    const file = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      format: 'tbx',
      lang: 'de',
    });
    expect(file.fileName).toBe('terms-de.tbx');
    expect(file.type).toBe('application/x-tbx+xml; charset=utf-8');
    expect(file.count).toBe(1);
    expect(file.body).toContain('xml:lang="de" xmlns=');
    expect(file.body).toContain('<term>Ladegerät</term>');
    expect(file.body).not.toContain('housing');
  });

  it('needs content.read', async () => {
    await expect(
      action.handle({ actor: NOBODY, snapshot: snapshot(), format: 'csv' }),
    ).rejects.toThrow(ForbiddenError);
  });
});
