import { execFileSync } from 'node:child_process';
import {
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import {
  addSampleTerms,
  SAMPLE_STYLE_RULES,
} from '@openfolia/content-repo/testing';
import type { Actor } from '../src/access/core/actor.js';
import { API_TOKEN_ACTOR } from '../src/access/core/service-actor.js';
import { NotFoundError } from '../src/base/core/errors.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckContentAction } from '../src/checks/core/actions/check-content.action.js';
import { reportChecks } from '../src/checks/core/check-report.js';
import { OpenSnapshotAction } from '../src/content/core/actions/open-snapshot.action.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The writing checks (#55) through the checks routes, over the sample with its terms and style
 * rules (`addSampleTerms`: the `storage` module says "Store the loader in a dry place.", a
 * forbidden variant of `charger` and the phrase of the style rule `dry-place`).
 */

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'writing-author',
};

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8', env }).trim();

beforeAll(async () => {
  t = await createTestApp();
  await addSampleTerms(dir());
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

type Doc = ReturnType<typeof CheckPageDocument.parse>;
const writing = (doc: Doc) =>
  doc.data
    .filter((c) => c.attributes.category === 'writing')
    .map(({ attributes: a }) => ({
      code: a.code,
      severity: a.severity,
      subject: a.subject,
      blockId: a.blockId,
      params: a.params,
    }));

/** Commits `changes` on `branch` (main by default). */
async function commit(
  changes: { path: string; content: string }[],
  branch = 'main',
): Promise<void> {
  await new GitWriter(dir()).commit({
    branch,
    parent: git('rev-parse', `refs/heads/${branch}`),
    changes,
    message: 'Writing checks',
    author: { name: 'Test', email: 'test@example.com' },
  });
}

const config = () => git('show', 'main:openfolia.yaml');

describe('the writing checks (#55)', () => {
  it('reports the forbidden variant and the style rule in a manual’s checks, at the block and range', async () => {
    t.actAs(READER);
    const res = await t.get('/manuals/operating/checks?page[size]=200');
    expect(res.status).toBe(200);
    const doc = CheckPageDocument.parse(res.body);
    expect(writing(doc)).toEqual([
      {
        code: 'forbidden-term',
        severity: 'warning',
        subject: { type: 'module', lang: 'en', moduleId: 'storage' },
        blockId: 'dry',
        params: {
          field: 'content',
          start: '10',
          end: '16',
          text: 'loader',
          replacement: 'charger',
          term: 'charger',
          status: 'forbidden',
          note: 'Reads as a machine that loads goods.',
        },
      },
      {
        code: 'style-rule',
        severity: 'warning',
        subject: { type: 'module', lang: 'en', moduleId: 'storage' },
        blockId: 'dry',
        params: {
          field: 'content',
          start: '17',
          end: '31',
          text: 'in a dry place',
          rule: 'dry-place',
          message:
            'Name the storage conditions, such as the temperature range.',
        },
      },
    ]);
  });

  it('reports them in a change set’s checks, blocking where the configuration says so', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Loader' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
      id: 'charging',
    });
    const changed: Module = {
      ...charging,
      blocks: [
        ...charging.blocks,
        {
          type: 'paragraph',
          id: 'loader',
          content: [{ type: 'text', text: 'Utilise the Loader.' }],
        },
      ],
    };
    await commit(
      [
        { path: 'modules/en/charging.adoc', content: printModule(changed) },
        {
          path: 'openfolia.yaml',
          content:
            `${config()}\nterminology:\n  forbiddenIsBlocking: true\n`.replace(
              'replacement: use\n',
              'replacement: use\n        severity: blocking\n',
            ),
        },
      ],
      attributes.branch,
    );
    const res = await t.get(`/change-sets/${id}/checks`);
    expect(res.status).toBe(200);
    const doc = CheckPageDocument.parse(res.body);
    expect(
      writing(doc).map((c) => [
        c.code,
        c.severity,
        c.blockId,
        c.params['text'],
      ]),
    ).toEqual([
      ['forbidden-term', 'blocking', 'loader', 'Loader'],
      ['style-rule', 'blocking', 'loader', 'Utilise'],
    ]);
    expect(writing(doc)[0]?.params['replacement']).toBe('Charger');
    expect(doc.meta.counts.blocking).toBeGreaterThanOrEqual(2);
    const blocking = await t.get(
      `/change-sets/${id}/checks?filter[severity]=blocking`,
    );
    expect(
      CheckPageDocument.parse(blocking.body).data.map((c) => c.attributes.code),
    ).toEqual(expect.arrayContaining(['forbidden-term', 'style-rule']));
  });

  /** What the CLI check (`scripts/check-content.mjs`) prints and exits with at `ref`. */
  async function cli(ref: string, manualId?: string) {
    const snapshot = await t.app
      .get(OpenSnapshotAction)
      .handle({ actor: API_TOKEN_ACTOR, ref });
    const result = await t.app.get(CheckContentAction).handle({
      actor: API_TOKEN_ACTOR,
      snapshot,
      ...(manualId !== undefined && { manualId }),
    });
    return {
      result,
      text: reportChecks(result, 'text'),
      json: reportChecks(result, 'json'),
    };
  }

  it('the CLI check reports them at a ref, exiting 0 with warnings only', async () => {
    const { result, text, json } = await cli('main');
    expect(result.commit).toBe(git('rev-parse', 'main'));
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain(
      'warning  forbidden-term en/storage#dry: "loader" is a forbidden variant of the term "charger": write "charger".\n',
    );
    expect(text.output).toContain('warning  style-rule en/storage#dry: ');
    expect(text.output).toMatch(
      new RegExp(
        `^0 blocking, \\d+ warning\\(s\\) in \\d+ module\\(s\\) at ${result.commit}\\.\\n$`,
        'm',
      ),
    );
    const document = JSON.parse(json.output) as {
      counts: { blocking: number };
      checks: {
        code: string;
        severity: string;
        params: Record<string, string>;
      }[];
    };
    expect(json.exitCode).toBe(0);
    expect(document.counts.blocking).toBe(0);
    expect(document.checks).toContainEqual(
      expect.objectContaining({
        code: 'forbidden-term',
        severity: 'warning',
        params: expect.objectContaining({ replacement: 'charger' }),
      }),
    );
    // Every module and manual: also what no manual includes.
    expect(result.modules).toEqual(
      expect.arrayContaining([
        'charging',
        'internals',
        'safety-note',
        'storage',
      ]),
    );
  });

  it('the CLI check exits 1 with a blocking check, and only reads one manual when asked', async () => {
    git('branch', '-f', 'blocking-terms', 'main');
    await commit(
      [
        {
          path: 'openfolia.yaml',
          content: `${config()}\nterminology:\n  forbiddenIsBlocking: true\n`,
        },
      ],
      'blocking-terms',
    );
    const { text } = await cli('blocking-terms');
    expect(text.exitCode).toBe(1);
    expect(text.output).toContain('blocking forbidden-term en/storage#dry: ');
    const one = await cli('blocking-terms', 'operating');
    expect(one.text.exitCode).toBe(1);
    await expect(cli('blocking-terms', 'no-such-manual')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('reads the rules from openfolia.yaml: a rule taken out finds nothing any more', async () => {
    expect(config()).toContain(SAMPLE_STYLE_RULES.trim());
    await commit([
      {
        path: 'openfolia.yaml',
        content: config().replace(SAMPLE_STYLE_RULES.trim(), ''),
      },
    ]);
    t.actAs(READER);
    const res = await t.get('/manuals/operating/checks?page[size]=200');
    expect(res.status).toBe(200);
    expect(
      writing(CheckPageDocument.parse(res.body)).map((c) => c.code),
    ).toEqual(['forbidden-term']);
  });
});
