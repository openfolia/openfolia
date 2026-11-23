import { changedIn, subjectIdForMessage } from './commit.js';
import {
  MAX_TEMPLATE_FILE_BYTES,
  parseConfig,
  type ProjectConfig,
} from '@openfolia/content-model';
import { actorWith } from '../../../tests/fakes/actors.js';
import {
  config,
  manifest,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { ForbiddenError, UnprocessableError } from '../../base/core/errors.js';
import {
  LOCK_SUBJECT_TYPES,
  type LockSubject,
  parseSubject,
  subjectKey,
  subjectName,
  subjectOfKey,
} from './lock.js';
import {
  checkDeletable,
  checkSubject,
  kindOf,
  SUBJECT_KINDS,
  subjectOfPath,
} from './subject-kinds.js';

const subjects: [LockSubject, string, string][] = [
  [
    { type: 'module', lang: 'pt-BR', moduleId: 'charging' },
    'modules/pt-BR/charging.adoc',
    'module/pt-BR/charging',
  ],
  [
    { type: 'manual', manualId: 'operating' },
    'manuals/operating.yaml',
    'manual/operating',
  ],
  [{ type: 'config' }, 'openfolia.yaml', 'config'],
  [{ type: 'term', termId: 'charger' }, 'terms/charger.yaml', 'term/charger'],
  [
    { type: 'template', templateId: 'house', path: 'manual.typ' },
    'templates/house/manual.typ',
    'template/house/manual.typ',
  ],
  [
    { type: 'template', templateId: 'house', path: 'parts/Notice_2.typ' },
    'templates/house/parts/Notice_2.typ',
    'template/house/parts/Notice_2.typ',
  ],
];

const term = {
  schemaVersion: 1 as const,
  id: 'charger',
  status: 'approved' as const,
  languages: { en: { preferred: 'charger', allowed: [], forbidden: [] } },
};

describe('the subject kinds', () => {
  it('has one kind per subject type', () => {
    expect(Object.keys(SUBJECT_KINDS).sort()).toEqual(
      [...LOCK_SUBJECT_TYPES].sort(),
    );
  });

  it.each(subjects)(
    'names %o by its key, its name and its file',
    (subject, path, name) => {
      expect(kindOf(subject).path(subject)).toBe(path);
      expect(subjectOfPath(path)).toEqual(subject);
      expect(subjectName(subject)).toBe(name);
      expect(parseSubject(name)).toEqual(subject);
      expect(subjectOfKey(subjectKey(subject))).toEqual(subject);
    },
  );

  it('reads the configuration under its earlier name too, and writes it under the new one', () => {
    expect(subjectOfPath('ccms.yaml')).toEqual({ type: 'config' });
    expect(subjectOfPath('openfolia.yaml')).toEqual({ type: 'config' });
    expect(kindOf({ type: 'config' }).path({ type: 'config' })).toBe(
      'openfolia.yaml',
    );
    // The stored subject ID keeps the earlier name (the tables' check constraints hold it).
    expect(subjectKey({ type: 'config' })).toEqual({
      type: 'config',
      id: 'ccms.yaml',
    });
    // A change to either file is a change to the configuration; messages name the new file.
    expect(changedIn(new Set(['ccms.yaml']), { type: 'config' })).toBe(true);
    expect(changedIn(new Set(['openfolia.yaml']), { type: 'config' })).toBe(
      true,
    );
    expect(
      changedIn(new Set(['ccms.yaml']), { type: 'term', termId: 'ccms' }),
    ).toBe(false);
    expect(subjectIdForMessage({ type: 'config' })).toBe('openfolia.yaml');
  });

  it('takes no path but a subject’s canonical one', () => {
    for (const path of [
      'modules/PT-br/charging.adoc',
      'modules/en/Charging.adoc',
      'manuals/a/b.yaml',
      'terms/Charger.yaml',
      'terms/../openfolia.yaml',
      'terms/charger.yml',
      './openfolia.yaml',
      'templates/manual.typ',
      // A template's file (#396): only a text file inside its folder, by a name not starting with `.`.
      'templates/House/manual.typ',
      'templates/house/../manual.typ',
      'templates/house/.hidden.typ',
      'templates/house/parts//notice.typ',
      'templates/house/logo.png',
      'templates/house/manual',
    ]) {
      expect(subjectOfPath(path)).toBeUndefined();
    }
    for (const name of [
      'config/openfolia.yaml',
      'config/x',
      'term/',
      'term/A',
      'term/a/b',
      'nope/x',
      'template/house',
      'template/house/',
      'template/house/../x.typ',
      'template/house/./x.typ',
      'template/house//x.typ',
      'template/house/x.exe',
      'template/../etc/passwd.txt',
      `template/house/${'a/'.repeat(8)}x.typ`,
      `template/house/${'a'.repeat(150)}.typ`,
    ]) {
      expect(parseSubject(name)).toBeUndefined();
    }
    expect(subjectOfKey({ type: 'config', id: 'other.yaml' })).toBeUndefined();
  });

  it('stores the configuration with a format version and reads it back strictly', () => {
    const kind = kindOf({ type: 'config' });
    const stored = kind.stored(config);
    expect(stored.schemaVersion).toBe(kind.schemaVersion);
    expect(kind.fromStored(JSON.parse(JSON.stringify(stored)))).toEqual(config);
    expect(kind.fromStored({ ...stored, schemaVersion: 2 })).toBeUndefined();
    expect(kind.fromStored({ ...stored, extra: true })).toBeUndefined();
    expect(kind.fromStored([stored])).toBeUndefined();
  });

  it('reads a design working copy saved before the manufacturer moved to the configuration (#395)', () => {
    const kind = kindOf({ type: 'design', designId: 'old' });
    const stored = {
      schemaVersion: 1,
      id: 'old',
      name: 'Old',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#b45309', text: '#1f2328' },
      backPage: {
        manufacturer: { name: 'Example Works Ltd', address: [] },
        documentNumber: true,
        date: false,
      },
    };
    const read = kind.fromStored(stored) as {
      backPage?: Record<string, unknown>;
    };
    expect(read.backPage).toEqual({
      position: 'last',
      documentNumber: true,
      date: false,
    });
    expect(kind.fromStored({ ...stored, extra: true })).toBeUndefined();
  });

  it('prints every kind to a file that reads back the same', () => {
    const config$ = kindOf({ type: 'config' }).print(
      { type: 'config' },
      config,
    );
    expect('text' in config$ && parseConfig(config$.text)).toEqual(config);
    const term$ = kindOf({ type: 'term', termId: 'charger' }).print(
      { type: 'term', termId: 'charger' },
      term,
    );
    expect(term$).toEqual({
      text: 'schemaVersion: 1\nstatus: approved\nlanguages:\n  en:\n    preferred: charger\n',
    });
  });

  it('checks that the content is the subject’s', () => {
    const charger = { type: 'term', termId: 'charger' } as const;
    expect(() => checkSubject(charger, term)).not.toThrow();
    expect(() => checkSubject({ type: 'term', termId: 'other' }, term)).toThrow(
      UnprocessableError,
    );
    // A module named like the term is no term.
    expect(() => checkSubject(charger, module('charger'))).toThrow(
      UnprocessableError,
    );
    expect(() => checkSubject({ type: 'config' }, config)).not.toThrow();
    expect(() =>
      checkSubject({ type: 'manual', manualId: 'charger' }, module('charger')),
    ).toThrow(UnprocessableError);
    expect(() =>
      checkSubject({ type: 'manual', manualId: 'm' }, manifest('m', [])),
    ).not.toThrow();
  });

  it('validates a term’s languages against the configuration', () => {
    const charger = { type: 'term', termId: 'charger' } as const;
    const other: ProjectConfig = {
      ...config,
      languages: { source: 'de', targets: [] },
    };
    expect(kindOf(charger).issues(charger, term, config)).toEqual([]);
    expect(
      kindOf(charger)
        .issues(charger, term, other)
        .map((i) => i.code),
    ).toEqual(['unknown-language']);
  });
});

describe('who may change the configuration and terms', () => {
  const content = readable({
    terms: {
      charger:
        'schemaVersion: 1\nstatus: approved\nlanguages:\n  de:\n    preferred: Ladegerät\n',
      broken: 'not: [a term',
    },
  });
  const configSubject = { type: 'config' } as const;
  const may = (
    actor: Parameters<typeof checkDeletable>[0],
    subject: LockSubject,
    with$?: unknown,
  ) =>
    kindOf(subject)
      .checkChange(actor, content, subject, with$ as never)
      .then(
        () => true,
        (error: unknown) => {
          if (error instanceof ForbiddenError) return false;
          throw error;
        },
      );

  it('the configuration: `content.edit` restricting nothing, and `admin.roles`', async () => {
    expect(
      await may(actorWith(['content.edit', 'admin.roles']), configSubject),
    ).toBe(true);
    expect(await may(actorWith(['content.edit']), configSubject)).toBe(false);
    expect(await may(actorWith(['admin.roles']), configSubject)).toBe(false);
    expect(
      await may(
        actorWith(['content.edit', 'admin.roles'], { languages: ['en'] }),
        configSubject,
      ),
    ).toBe(false);
    expect(
      await may(
        actorWith(['content.edit', 'admin.roles'], { maxAudience: 'public' }),
        configSubject,
      ),
    ).toBe(false);
  });

  it('a term: one role editing everything in each of its languages, committed and new', async () => {
    const charger = { type: 'term', termId: 'charger' } as const;
    const german = actorWith(['content.edit'], { languages: ['de'] });
    const english = actorWith(['content.edit'], { languages: ['en'] });
    const both = actorWith(['content.edit'], { languages: ['de', 'en'] });
    const typed = actorWith(['content.edit'], {
      languages: ['de'],
      moduleTypes: ['concept'],
    });
    expect(await may(german, charger)).toBe(true);
    expect(await may(english, charger)).toBe(false);
    expect(await may(typed, charger)).toBe(false);
    expect(await may(german, charger, term)).toBe(false);
    expect(await may(both, charger, term)).toBe(true);
    // A new term: anyone editing, until its content says its languages.
    const fresh = { type: 'term', termId: 'fresh' } as const;
    expect(await may(english, fresh)).toBe(true);
    expect(await may(typed, fresh)).toBe(false);
    expect(await may(german, fresh, { ...term, id: 'fresh' })).toBe(false);
    // A file that is no term: only a role covering every language.
    const broken = { type: 'term', termId: 'broken' } as const;
    expect(await may(both, broken)).toBe(false);
    expect(await may(actorWith(['content.edit']), broken)).toBe(true);
  });

  it('deletes a term that is there, never the configuration', async () => {
    const editor = actorWith(['content.edit', 'admin.roles']);
    await expect(
      checkDeletable(editor, content, configSubject, 'config'),
    ).rejects.toMatchObject({ code: 'not-deletable' });
    await expect(
      checkDeletable(
        editor,
        content,
        { type: 'term', termId: 'charger' },
        'term charger',
      ),
    ).resolves.toBeUndefined();
    await expect(
      checkDeletable(
        editor,
        content,
        { type: 'term', termId: 'gone' },
        'term gone',
      ),
    ).rejects.toMatchObject({ code: 'nothing-to-delete' });
  });
});

describe('a page design template’s file (#396)', () => {
  const content = readable({
    designTemplates: {
      house: {
        'manual.typ': '#let manual(..a, body) = body\n',
        'logo.svg': new Uint8Array([0xff, 0xfe, 0x00]),
      },
    },
  });
  const manualTyp: Extract<LockSubject, { type: 'template' }> = {
    type: 'template',
    templateId: 'house',
    path: 'manual.typ',
  };
  const kind = kindOf(manualTyp);
  const may = (actor: Parameters<typeof checkDeletable>[0]) =>
    kind.checkChange(actor, content, manualTyp, undefined).then(
      () => true,
      (error: unknown) => {
        if (error instanceof ForbiddenError) return false;
        throw error;
      },
    );

  it('is its text, printed as it is', () => {
    const text = '#import "design.typ": *\n\n// ünïcode\n';
    expect(kind.print(manualTyp, { schemaVersion: 1, text })).toEqual({ text });
    checkSubject(manualTyp, { schemaVersion: 1, text });
    expect(kind.fromStored({ schemaVersion: 1, text })).toEqual({
      schemaVersion: 1,
      text,
    });
    // Nothing but its text: no other member, no other version, no NUL, no more than the cap.
    expect(
      kind.fromStored({ schemaVersion: 1, text, id: 'x' }),
    ).toBeUndefined();
    expect(kind.fromStored({ schemaVersion: 2, text })).toBeUndefined();
    expect(
      kind.content.safeParse({ schemaVersion: 1, text: 'a\0b' }).success,
    ).toBe(false);
    expect(
      kind.content.safeParse({
        schemaVersion: 1,
        text: 'é'.repeat(MAX_TEMPLATE_FILE_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
    expect(
      kind.content.safeParse({
        schemaVersion: 1,
        text: 'é'.repeat(MAX_TEMPLATE_FILE_BYTES / 2),
      }).success,
    ).toBe(true);
    expect(kind.issues(manualTyp, { schemaVersion: 1, text }, config)).toEqual(
      [],
    );
  });

  it('reads the committed text, and no bytes that are no text', async () => {
    expect(await kind.committed(content, manualTyp, config)).toEqual({
      content: { schemaVersion: 1, text: '#let manual(..a, body) = body\n' },
      issues: [],
    });
    const logo = { ...manualTyp, path: 'logo.svg' };
    expect(await kind.committed(content, logo, config)).toBeUndefined();
    expect(await kind.exists(content, logo)).toBe(true);
    expect(await kind.exists(content, { ...manualTyp, path: 'gone.typ' })).toBe(
      false,
    );
  });

  it('is changed only by one who may change page designs: `content.edit` restricting nothing', async () => {
    expect(await may(actorWith(['content.edit']))).toBe(true);
    expect(await may(actorWith(['content.edit'], { languages: ['en'] }))).toBe(
      false,
    );
    expect(
      await may(actorWith(['content.edit'], { moduleTypes: ['concept'] })),
    ).toBe(false);
    expect(await may(actorWith(['content.read']))).toBe(false);
    // Every reader of the branch knows of its lock and reads its working copy's text.
    expect(
      await kind.sees(
        actorWith(['content.read']),
        content,
        manualTyp,
        'content.read',
      ),
    ).toBe(true);
  });

  it('deletes a file that is there', async () => {
    const editor = actorWith(['content.edit']);
    await checkDeletable(
      editor,
      content,
      manualTyp,
      'template/house/manual.typ',
    );
    await expect(
      checkDeletable(
        editor,
        content,
        { ...manualTyp, path: 'gone.typ' },
        'gone',
      ),
    ).rejects.toMatchObject({ code: 'nothing-to-delete' });
    await expect(
      checkDeletable(
        actorWith(['content.edit'], { languages: ['en'] }),
        content,
        manualTyp,
        'x',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
