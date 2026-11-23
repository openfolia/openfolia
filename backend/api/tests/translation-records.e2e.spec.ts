import { execFileSync } from 'node:child_process';
import {
  type Manifest,
  type PageDesign,
  parseManifest,
  parsePageDesign,
  printManifest,
  printPageDesign,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Who changes a page design's or a manual's translation record (#663): `translations`, which
 * the translation status compares the source text with, is written only by someone holding
 * `translation.manage` for the languages whose entry changes, whatever path the file takes (a
 * working copy, a save point); taking a change set's change back out puts the base's back.
 * Over the sample repository with `classic` (`addSamplePageDesigns`) and `operating` given a
 * cover image, each with a German record on `main`.
 */
let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const READS: Permission[] = ['content.read', 'content.read.draft'];

/** A user `id` with one role per entry: its permissions and scope. */
const person = (
  id: string,
  roles: readonly (readonly [
    readonly Permission[],
    Actor['roles'][number]['scope'],
  ])[],
): Actor => ({
  kind: 'user',
  id,
  roles: roles.map(([permissions, scope], i) => ({
    id: `role-${i}`,
    name: `Role ${i}`,
    permissions: [...permissions],
    scope,
  })),
});

/** Edits everything, manages no translation. */
const editor = person('record-editor', [[[...READS, 'content.edit'], {}]]);
/** Edits everything and manages every language's translation. */
const manager = person('record-manager', [
  [[...READS, 'content.edit', 'translation.manage'], {}],
]);
/** Edits everything; manages the German translation only. */
const german = person('record-german', [
  [[...READS, 'content.edit'], {}],
  [['translation.manage'], { languages: ['de'] }],
]);
/** Edits everything, manages no translation, reads no drafts but their own work. */
const drafter = person('record-drafter', [
  [['content.read', 'content.edit'], {}],
]);
/** One person, first as a translation manager, then without it (`switching`). */
const switching = (managing: boolean) =>
  person('record-switching', [
    [
      [
        ...READS,
        'content.edit',
        ...(managing ? ['translation.manage' as const] : []),
      ],
      {},
    ],
  ]);

const HASH = (c: string) => c.repeat(64);

/** Commits `classic` on main with `change` applied to it; its record as written. */
async function onMain(
  change: (design: PageDesign) => PageDesign,
): Promise<PageDesign['translations']> {
  const theirs = change(
    parsePageDesign(git('show', 'main:design/classic.yaml'), { id: 'classic' }),
  );
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'main'),
    changes: [
      { path: 'design/classic.yaml', content: printPageDesign(theirs) },
    ],
    message: 'Classic on main',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return theirs.translations;
}
let mainHead: string;

beforeAll(async () => {
  t = await createTestApp();
  await addSamplePageDesigns(dir());
  const head = git('rev-parse', 'main');
  const manifest = parseManifest(git('show', 'main:manuals/operating.yaml'), {
    id: 'operating',
  });
  const design = parsePageDesign(git('show', 'main:design/classic.yaml'), {
    id: 'classic',
  });
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: head,
    changes: [
      {
        path: 'manuals/operating.yaml',
        content: printManifest({
          ...manifest,
          coverImage: {
            default: {
              asset: `sha256:${'a'.repeat(64)}`,
              alt: { en: 'The vehicle', de: 'Das Fahrzeug' },
            },
            variants: [],
          },
          translations: {
            de: {
              sourceCommit: head,
              blocks: { 'coverImage.default': HASH('1') },
            },
          },
        } as Manifest),
      },
      {
        path: 'design/classic.yaml',
        content: printPageDesign({
          ...design,
          translations: {
            de: {
              sourceCommit: head,
              blocks: { 'above-title.intro': HASH('2') },
            },
          },
        } as PageDesign),
      },
    ],
    message: 'Translation records',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  mainHead = git('rev-parse', 'main');
}, 60_000);
afterAll(() => t?.close());
/** The change sets a test made, with their authors: abandoned after it, so its locks go. */
const made: { id: string; author: Actor }[] = [];
afterEach(async () => {
  for (const { id, author } of made.splice(0)) {
    t.actAs(author);
    expect((await t.post(`/change-sets/${id}/abandon`).send()).status).toBe(
      200,
    );
  }
  t.actAs(undefined);
});

const body = (value: unknown) => JSON.stringify(value);

async function changeSet(
  actor: Actor,
): Promise<{ id: string; branch: string }> {
  t.actAs(actor);
  const created = await t
    .post('/change-sets')
    .send(
      body({ data: { type: 'ChangeSet', attributes: { title: 'Records' } } }),
    );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  made.push({ id, author: actor });
  return { id, branch: attributes.branch };
}

type Subject =
  { type: 'design'; designId: string } | { type: 'manual'; manualId: string };
const DESIGN: Subject = { type: 'design', designId: 'classic' };
const MANUAL: Subject = { type: 'manual', manualId: 'operating' };

const copyPath = (id: string, subject: Subject) =>
  subject.type === 'design'
    ? `/change-sets/${id}/page-designs/${subject.designId}/working-copy`
    : `/change-sets/${id}/manuals/${subject.manualId}/working-copy`;

/** Takes the lock and reads the working copy (the committed file while none is saved). */
async function open(id: string, subject: Subject) {
  const locked = await t
    .post(`/change-sets/${id}/locks`)
    .send(body({ data: { type: 'Lock', attributes: { subject } } }));
  expect(locked.status).toBe(201);
  const read = await t.get(copyPath(id, subject));
  expect(read.status).toBe(200);
  const { content, version, baseCommit } = read.body.data.attributes as {
    content: Record<string, unknown> & {
      translations?: Record<string, unknown>;
    };
    version: number;
    baseCommit: string;
  };
  return { content, version, baseCommit };
}

const save = (
  id: string,
  subject: Subject,
  content: unknown,
  meta: { version: number; baseCommit: string },
) =>
  t
    .put(copyPath(id, subject))
    .send(
      body({ data: { type: 'WorkingCopy', attributes: { content } }, meta }),
    );

const commit = (id: string) =>
  t
    .post(`/change-sets/${id}/commits`)
    .send(body({ data: { type: 'Commit', attributes: {} } }));

const firstError = (res: { body: unknown }) =>
  ErrorDocument.parse(res.body).errors[0];

/** `translations` with `lang`'s entry naming `hash` for `unit` (`undefined`: the entry left out). */
const withEntry = (
  translations: Record<string, unknown> | undefined,
  lang: string,
  unit: string,
  hash: string | undefined,
) => {
  const next = { ...translations };
  if (hash === undefined) delete next[lang];
  else next[lang] = { sourceCommit: mainHead, blocks: { [unit]: hash } };
  return next;
};

describe('a design’s and a manual’s translation record (#663)', () => {
  for (const [subject, unit] of [
    [DESIGN, 'above-title.intro'],
    [MANUAL, 'coverImage.default'],
  ] as const) {
    describe(subject.type, () => {
      it('is not changed in a working copy without translation.manage', async () => {
        const cs = await changeSet(editor);
        const { content, ...meta } = await open(cs.id, subject);
        for (const translations of [
          withEntry(content.translations, 'de', unit, HASH('3')),
          withEntry(content.translations, 'de', unit, undefined),
          withEntry(content.translations, 'fr', unit, HASH('3')),
        ]) {
          const res = await save(
            cs.id,
            subject,
            { ...content, translations },
            meta,
          );
          expect(res.status).toBe(422);
          const error = firstError(res);
          expect(error?.code).toBe('translation-record-protected');
        }
        // Anything else is saved, with the record as committed.
        const kept = await save(
          cs.id,
          subject,
          subject.type === 'design'
            ? { ...content, name: 'Classic, renamed' }
            : { ...content, title: 'Operating, renamed' },
          meta,
        );
        expect(kept.status).toBe(200);
      });

      it('is changed by a translation manager, and committed', async () => {
        const cs = await changeSet(manager);
        const { content, ...meta } = await open(cs.id, subject);
        const res = await save(
          cs.id,
          subject,
          {
            ...content,
            translations: withEntry(
              content.translations,
              'de',
              unit,
              HASH('4'),
            ),
          },
          meta,
        );
        expect(res.status).toBe(200);
        expect((await commit(cs.id)).status).toBe(201);
      });

      it('is changed only in the languages a restricted translation manager manages', async () => {
        const cs = await changeSet(german);
        const { content, ...meta } = await open(cs.id, subject);
        const french = await save(
          cs.id,
          subject,
          {
            ...content,
            translations: withEntry(
              content.translations,
              'fr',
              unit,
              HASH('5'),
            ),
          },
          meta,
        );
        expect(french.status).toBe(422);
        expect(firstError(french)?.code).toBe('translation-record-protected');
        expect(firstError(french)?.meta).toMatchObject({ languages: ['fr'] });
        const res = await save(
          cs.id,
          subject,
          {
            ...content,
            translations: withEntry(
              content.translations,
              'de',
              unit,
              HASH('5'),
            ),
          },
          meta,
        );
        expect(res.status).toBe(200);
        expect((await commit(cs.id)).status).toBe(201);
      });

      it('is checked again at the save point, against the roles held then', async () => {
        const cs = await changeSet(switching(true));
        const { content, ...meta } = await open(cs.id, subject);
        const saved = await save(
          cs.id,
          subject,
          {
            ...content,
            translations: withEntry(
              content.translations,
              'de',
              unit,
              HASH('6'),
            ),
          },
          meta,
        );
        expect(saved.status).toBe(200);
        t.actAs(switching(false));
        const res = await commit(cs.id);
        expect(res.status).toBe(422);
        expect(firstError(res)?.code).toBe('translation-record-protected');
      });

      it('goes back as the base has it when the change is taken out', async () => {
        const cs = await changeSet(switching(true));
        const { content, ...meta } = await open(cs.id, subject);
        expect(
          (
            await save(
              cs.id,
              subject,
              {
                ...content,
                translations: withEntry(
                  content.translations,
                  'de',
                  unit,
                  HASH('7'),
                ),
              },
              meta,
            )
          ).status,
        ).toBe(200);
        expect((await commit(cs.id)).status).toBe(201);
        // Without translation.manage now: putting back the base's record writes none of theirs.
        t.actAs(switching(false));
        const res = await t.post(`/change-sets/${cs.id}/reverts`).send(
          body({
            data: { type: 'Revert', attributes: { subjects: [subject] } },
          }),
        );
        expect(res.status).toBe(200);
        const path =
          subject.type === 'design'
            ? 'design/classic.yaml'
            : 'manuals/operating.yaml';
        expect(git('show', `${cs.branch}:${path}`)).toBe(
          git('show', `main:${path}`),
        );
      });
    });
  }
});

const refresh = (id: string, meta?: object) =>
  t
    .post(`/change-sets/${id}/refresh`)
    .send(meta === undefined ? '' : body({ meta }));

describe('updating a change set from its base (#663)', () => {
  it('keeps the branch’s design only with the base’s record, unless the person manages it', async () => {
    const cs = await changeSet(editor);
    const { content, ...meta } = await open(cs.id, DESIGN);
    expect(
      (await save(cs.id, DESIGN, { ...content, name: 'Classic, mine' }, meta))
        .status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    // Meanwhile on main: the same line, and a German record a translation manager wrote.
    const theirs = parsePageDesign(git('show', 'main:design/classic.yaml'), {
      id: 'classic',
    });
    const translations = withEntry(
      theirs.translations,
      'de',
      'above-title.intro',
      HASH('8'),
    ) as PageDesign['translations'];
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'main'),
      changes: [
        {
          path: 'design/classic.yaml',
          content: printPageDesign({
            ...theirs,
            name: 'Classic, theirs',
            translations,
          }),
        },
      ],
      message: 'Rename and record',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    t.actAs(editor);
    // Main's record is not theirs to take while no update reported the conflict.
    const early = await t.get(copyPath(cs.id, DESIGN));
    const before = early.body.data.attributes;
    const taken = await save(
      cs.id,
      DESIGN,
      { ...before.content, translations },
      { version: before.version, baseCommit: before.baseCommit },
    );
    expect(taken.status).toBe(422);
    expect(firstError(taken)?.code).toBe('translation-record-protected');
    expect((await refresh(cs.id)).status).toBe(409);
    // Their own file kept whole would put the old record back over main's.
    const mine = await refresh(cs.id, { keepMine: [DESIGN] });
    expect(mine.status).toBe(422);
    expect(firstError(mine)?.code).toBe('translation-record-protected');
    // Saved with main's record, which resolving the reported conflict may take, it is kept.
    const copy = await t.get(copyPath(cs.id, DESIGN));
    const { content: now, version, baseCommit } = copy.body.data.attributes;
    expect(
      (
        await save(
          cs.id,
          DESIGN,
          { ...now, translations },
          { version, baseCommit },
        )
      ).status,
    ).toBe(200);
    const kept = await refresh(cs.id, { keep: [DESIGN] });
    expect(kept.status).toBe(200);
    const file = parsePageDesign(
      git('show', `${cs.branch}:design/classic.yaml`),
      {
        id: 'classic',
      },
    );
    expect(file.name).toBe('Classic, mine');
    expect(file.translations).toEqual(translations);
  });
  it('keeps a design the change set deleted, its record going with it', async () => {
    const minimal: Subject = { type: 'design', designId: 'minimal' };
    const cs = await changeSet(editor);
    expect(
      (
        await t
          .post(`/change-sets/${cs.id}/locks`)
          .send(
            body({ data: { type: 'Lock', attributes: { subject: minimal } } }),
          )
      ).status,
    ).toBe(201);
    const deleted = await t
      .post(`/change-sets/${cs.id}/commits`)
      .send(
        body({ data: { type: 'Commit', attributes: { deletes: [minimal] } } }),
      );
    expect(deleted.status).toBe(201);
    const theirs = parsePageDesign(git('show', 'main:design/minimal.yaml'), {
      id: 'minimal',
    });
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'main'),
      changes: [
        {
          path: 'design/minimal.yaml',
          content: printPageDesign({
            ...theirs,
            name: 'Minimal, theirs',
            translations: {
              de: { sourceCommit: mainHead, blocks: {} },
            },
          }),
        },
      ],
      message: 'Record on minimal',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    t.actAs(editor);
    expect((await refresh(cs.id)).status).toBe(409);
    expect((await refresh(cs.id, { keepMine: [minimal] })).status).toBe(200);
  });
  it('takes the base head’s record as it is now while the conflict is reported, for an author without draft reads', async () => {
    const cs = await changeSet(drafter);
    const { content, ...meta } = await open(cs.id, DESIGN);
    expect(
      (
        await save(
          cs.id,
          DESIGN,
          { ...content, name: 'Classic, drafted' },
          meta,
        )
      ).status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    await onMain((d) => ({
      ...d,
      name: 'Classic, first',
      translations: withEntry(
        d.translations,
        'de',
        'above-title.intro',
        HASH('6'),
      ) as PageDesign['translations'],
    }));
    t.actAs(drafter);
    expect((await refresh(cs.id)).status).toBe(409);
    // Main moves on after the report: its record now is the one to take.
    const latest = await onMain((d) => ({
      ...d,
      name: 'Classic, second',
      translations: withEntry(
        d.translations,
        'de',
        'above-title.intro',
        HASH('7'),
      ) as PageDesign['translations'],
    }));
    t.actAs(drafter);
    // Main changed the file again: the update reports it again, against main now.
    expect((await refresh(cs.id)).status).toBe(409);
    const copy = await t.get(copyPath(cs.id, DESIGN));
    const { content: now, version, baseCommit } = copy.body.data.attributes;
    expect(
      (
        await save(
          cs.id,
          DESIGN,
          { ...now, translations: latest },
          { version, baseCommit },
        )
      ).status,
    ).toBe(200);
    const kept = await refresh(cs.id, { keep: [DESIGN] });
    expect(kept.status).toBe(200);
    const file = parsePageDesign(
      git('show', `${cs.branch}:design/classic.yaml`),
      { id: 'classic' },
    );
    expect(file.name).toBe('Classic, drafted');
    expect(file.translations).toEqual(latest);
  });
  it('takes in no record the person could not write onto the base, even without a conflict', async () => {
    const cs = await changeSet(switching(true));
    const { content, ...meta } = await open(cs.id, DESIGN);
    const translations = withEntry(
      content.translations,
      'de',
      'above-title.intro',
      HASH('9'),
    );
    expect(
      (await save(cs.id, DESIGN, { ...content, translations }, meta)).status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    // Main moves on elsewhere in the file: a clean merge.
    const theirs = parsePageDesign(git('show', 'main:design/classic.yaml'), {
      id: 'classic',
    });
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'main'),
      changes: [
        {
          path: 'design/classic.yaml',
          content: printPageDesign({
            ...theirs,
            colours: { ...theirs.colours, accent: '#123456' },
          }),
        },
      ],
      message: 'Accent',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    t.actAs(switching(false));
    const res = await refresh(cs.id);
    expect(res.status).toBe(422);
    expect(firstError(res)?.code).toBe('translation-record-protected');
    t.actAs(switching(true));
    expect((await refresh(cs.id)).status).toBe(200);
  });
});

describe('submitting a change set (#663)', () => {
  it('takes a record a translation manager wrote, whoever submits it', async () => {
    const cs = await changeSet(switching(true));
    const { content, ...meta } = await open(cs.id, DESIGN);
    const translations = withEntry(
      content.translations,
      'de',
      'above-title.intro',
      HASH('5'),
    );
    expect(
      (await save(cs.id, DESIGN, { ...content, translations }, meta)).status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    t.actAs(switching(false));
    expect((await t.post(`/change-sets/${cs.id}/submit`).send('')).status).toBe(
      200,
    );
  });
  it('is refused with a base head’s record an update that failed left behind, once the base withdrew it', async () => {
    const cs = await changeSet(switching(true));
    // A German entry on the manual, theirs to write as a manager.
    const manual = await open(cs.id, MANUAL);
    expect(
      (
        await save(
          cs.id,
          MANUAL,
          {
            ...manual.content,
            translations: withEntry(
              manual.content.translations,
              'de',
              'coverImage.default',
              HASH('4'),
            ),
          },
          { version: manual.version, baseCommit: manual.baseCommit },
        )
      ).status,
    ).toBe(200);
    const design = await open(cs.id, DESIGN);
    expect(
      (
        await save(
          cs.id,
          DESIGN,
          { ...design.content, name: 'Classic, left' },
          { version: design.version, baseCommit: design.baseCommit },
        )
      ).status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    const before = parsePageDesign(git('show', 'main:design/classic.yaml'), {
      id: 'classic',
    }).translations;
    const added = await onMain((d) => ({
      ...d,
      name: 'Classic, right',
      translations: withEntry(
        d.translations,
        'de',
        'above-title.intro',
        HASH('3'),
      ) as PageDesign['translations'],
    }));
    // No longer a manager: the update reports the design, which they save with main's record.
    t.actAs(switching(false));
    expect((await refresh(cs.id)).status).toBe(409);
    const copy = await t.get(copyPath(cs.id, DESIGN));
    const { content: now, version, baseCommit } = copy.body.data.attributes;
    expect(
      (
        await save(
          cs.id,
          DESIGN,
          { ...now, translations: added },
          { version, baseCommit },
        )
      ).status,
    ).toBe(200);
    // Its save point lands; the manual's record then stops the update.
    const failed = await refresh(cs.id, { keep: [DESIGN] });
    expect(failed.status).toBe(422);
    expect(firstError(failed)?.code).toBe('translation-record-protected');
    expect(
      parsePageDesign(git('show', `${cs.branch}:design/classic.yaml`), {
        id: 'classic',
      }).translations,
    ).toEqual(added);
    // A manager withdraws main's entry: merged, the branch's would come back.
    await onMain((d) => ({ ...d, translations: before }));
    t.actAs(switching(false));
    const refused = await t.post(`/change-sets/${cs.id}/submit`).send('');
    expect(refused.status).toBe(422);
    expect(firstError(refused)?.code).toBe('translation-record-protected');
  });
  it('checks a reported design of an author without draft reads, without waiting on itself', async () => {
    const cs = await changeSet(drafter);
    const { content, ...meta } = await open(cs.id, DESIGN);
    expect(
      (await save(cs.id, DESIGN, { ...content, name: 'Classic, mine' }, meta))
        .status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    await onMain((d) => ({ ...d, name: 'Classic, theirs' }));
    t.actAs(drafter);
    expect((await refresh(cs.id)).status).toBe(409);
    expect((await t.post(`/change-sets/${cs.id}/submit`).send('')).status).toBe(
      200,
    );
  });
  it('takes a change set that keeps the base’s record', async () => {
    const cs = await changeSet(editor);
    const { content, ...meta } = await open(cs.id, DESIGN);
    expect(
      (await save(cs.id, DESIGN, { ...content, name: 'Classic, plain' }, meta))
        .status,
    ).toBe(200);
    expect((await commit(cs.id)).status).toBe(201);
    expect((await t.post(`/change-sets/${cs.id}/submit`).send('')).status).toBe(
      200,
    );
  });
});
