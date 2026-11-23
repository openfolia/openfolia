import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { renderErrorCodes } from '../scripts/lib/catalogues.mjs';
import {
  exemptErrorCodes,
  germanErrorTexts,
  icuText,
  screenErrorTables,
} from '../scripts/lib/error-texts.mjs';
import {
  englishProse,
  ENGLISH_END,
  ENGLISH_START,
  withoutEnglish,
} from '../scripts/lib/german-check.mjs';

// #750: the German error code reference, its texts the editor's German messages.

const repoRoot = join(import.meta.dirname, '../../..');
const repo = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('an ICU message as a reference shows it', () => {
  it('puts "…" where a value goes', () => {
    expect(icuText('Der Wert von „{parameter}“ ist ungültig.')).toBe(
      'Der Wert von „…“ ist ungültig.',
    );
    expect(
      icuText(
        'Höchstens {columns, number} Spalten und {cells, number} Zellen.',
      ),
    ).toBe('Höchstens … Spalten und … Zellen.');
    expect(icuText('Eine Datei kann nicht gelesen werden: {path}.')).toBe(
      'Eine Datei kann nicht gelesen werden: …',
    );
  });

  it('shows a plural’s or a select’s other branch, its number as "…"', () => {
    expect(
      icuText(
        'Sie steht in {total, plural, one {# Datei} other {# Dateien}} im Konflikt.',
      ),
    ).toBe('Sie steht in … Dateien im Konflikt.');
    expect(
      icuText(
        '{n, plural, offset:1 =0 {keine} one {eine} other {# weitere {kind}}}',
      ),
    ).toBe('… weitere …');
    expect(
      icuText(
        '{reason, select, dangerous {Gefährlich.} other {Nicht erlaubt.}}',
      ),
    ).toBe('Nicht erlaubt.');
  });

  it('undoes ICU’s quoting', () => {
    expect(icuText("It''s '{literal}' here")).toBe("It's {literal} here");
    expect(icuText("Ein Apostroph ' bleibt.")).toBe("Ein Apostroph ' bleibt.");
  });
});

describe('the error codes’ German texts', () => {
  const de = {
    apiErrors: { codes: { locked: 'Gerade bearbeitet {who} das.' } },
    admin: { backups: { errors: { keyMissing: 'Erst den Schlüssel.' } } },
  };
  const tables = screenErrorTables([
    {
      path: 'admin/backups/backups-model.ts',
      text: `const ERRORS = {\n  'backup-key-missing':\n    'editor.admin.backups.errors.keyMissing',\n  'gone-key': 'editor.admin.backups.errors.gone',\n};`,
    },
  ]);
  const exempt = exemptErrorCodes(
    "const CLIENT = 'why';\nconst EXEMPT = {\n  'not-acceptable': CLIENT,\n  'token-expired': 'why',\n};",
  );

  it('take the editor’s text for the code, else a screen’s table’s', () => {
    const { texts, english, problems } = germanErrorTexts(
      ['locked', 'backup-key-missing', 'not-acceptable'],
      { de, tables, exempt },
    );
    expect(problems).toEqual([]);
    expect(Object.fromEntries(texts)).toEqual({
      locked: 'Gerade bearbeitet … das.',
      'backup-key-missing': 'Erst den Schlüssel.',
    });
    expect(english).toEqual(['not-acceptable']);
  });

  it('fail for a code with no German text that the editor does not exempt', () => {
    const { problems } = germanErrorTexts(['unknown', 'gone-key'], {
      de,
      tables,
      exempt,
    });
    expect(problems).toEqual([
      expect.stringContaining('unknown has no German text'),
      expect.stringContaining('none of editor.admin.backups.errors.gone'),
    ]);
  });

  it('fail when the editor’s exempt codes cannot be read', () => {
    expect(exemptErrorCodes('const OTHER = {};')).toBeUndefined();
    const { problems } = germanErrorTexts([], {
      de,
      tables,
      exempt: undefined,
    });
    expect(problems).toHaveLength(1);
  });

  it('cover every code of the API’s catalogue, from the editor', () => {
    const codes = Object.keys(parse(repo('backend/api/error-codes.yaml')));
    const app = join(repoRoot, 'frontend/editor/src/app');
    const files = readdirSync(app, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .sort()
      .map((f) => ({ path: f, text: readFileSync(join(app, f), 'utf8') }));
    const result = germanErrorTexts(codes, {
      de: JSON.parse(repo('frontend/editor/src/i18n/de.json')),
      tables: screenErrorTables(files),
      exempt: exemptErrorCodes(repo('frontend/editor/tools/i18n.test.mjs')),
    });
    expect(result.problems).toEqual([]);
    expect(result.texts.size + result.english.length).toBe(codes.length);
  });
});

describe('the German error code reference', () => {
  const catalogue = {
    'not-found': { status: 404, when: 'Nothing is there.' },
    'cursor-gone': { status: 410, when: 'The cursor is gone from the feed.' },
  };
  const german = {
    texts: new Map([['not-found', 'Das gibt es nicht.']]),
    english: ['cursor-gone'],
  };
  const body = renderErrorCodes(catalogue, 'de', german);

  it('lists the codes with the editor’s German texts', () => {
    expect(body).toContain('| Code | Status | Meldung |');
    expect(body).toContain(
      '| <code>not-<wbr />found</code> | 404 | Das gibt es nicht. |',
    );
    expect(body).toContain('| 404 | `not-found` |');
    expect(body).toContain('| 410 | `cursor-gone` |');
  });

  it('shows the codes no editor screen meets in English, in an English section', () => {
    const start = body.indexOf(ENGLISH_START);
    const end = body.indexOf(ENGLISH_END);
    expect(start).toBeGreaterThan(0);
    expect(body.indexOf('The cursor is gone')).toBeGreaterThan(start);
    expect(body.indexOf('The cursor is gone')).toBeLessThan(end);
    expect(body).toContain('[englischen Seite](/reference/errors)');
    expect(englishProse(withoutEnglish(body).text)).toEqual([]);
  });

  it('has no English section when every code has a German text', () => {
    const all = renderErrorCodes(catalogue, 'de', {
      texts: new Map([
        ['not-found', 'Das gibt es nicht.'],
        ['cursor-gone', 'Der Cursor ist weg.'],
      ]),
      english: [],
    });
    expect(all).not.toContain(ENGLISH_START);
    expect(all).not.toContain('## Codes nur für API-Clients');
  });
});

describe('a German page’s English sections', () => {
  it('are left out of the check, their line numbers kept', () => {
    const page = [
      'Diese Referenz ist auf Englisch.',
      ENGLISH_START,
      'Every setting the server reads from the environment, with what it says.',
      ENGLISH_END,
      'Read the rest of this page in the other language, if you can.',
    ].join('\n');
    const { text, sections, problems } = withoutEnglish(page);
    expect(sections).toBe(1);
    expect(problems).toEqual([]);
    expect(englishProse(text).map((p) => p.line)).toEqual([5]);
  });

  it('must end, and end once', () => {
    expect(withoutEnglish(`${ENGLISH_START}\ntext`).problems).toEqual([
      'an English section that does not end',
    ]);
    expect(withoutEnglish(`text\n${ENGLISH_END}`).problems).toEqual([
      "line 2: an English section's end without its start",
    ]);
    expect(
      withoutEnglish(`${ENGLISH_START}\n${ENGLISH_START}\n${ENGLISH_END}`)
        .problems,
    ).toEqual(['line 2: an English section inside one']);
  });
});
