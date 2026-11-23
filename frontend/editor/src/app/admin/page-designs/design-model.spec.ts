import { PageDesign as PageDesignSchema } from '@openfolia/content-model';

import {
  contrastOnWhite,
  copyrightIn,
  designIdProblem,
  fieldRows,
  idFromName,
  issuesAt,
  levels,
  newDesign,
  normalColour,
  otherIssues,
  PRESETS,
  runningChoiceOf,
  runningText,
  RUNNING_CHOICES,
  shownFields,
  withCopyright,
  withLevel,
  withRunningChoice,
  withRunningVariant,
  type DesignIssue,
  type RunningRegion,
  type RunningText,
} from './design-model';

const issue = (at: string, code = 'low-contrast'): DesignIssue => ({
  severity: 'warning',
  code,
  message: code,
  at,
});

describe('design-model', () => {
  it('makes a new design the content model takes, from every preset', () => {
    for (const preset of PRESETS) {
      const design = newDesign('ours', 'Ours', preset);
      const parsed = PageDesignSchema.safeParse(design);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(design.preset).toBe(preset);
    }
  });

  it('makes an ID from a name, and says what is wrong with an ID', () => {
    expect(idFromName('Straße & Brücke — 2026')).toBe('strasse-brucke-2026');
    expect(idFromName('  --Hello--  ')).toBe('hello');
    expect(idFromName('x'.repeat(80))).toHaveLength(64);
    expect(designIdProblem('', [])).toBe(
      'editor.admin.pageDesigns.create.idRequired',
    );
    expect(designIdProblem('Not Ok', [])).toBe(
      'editor.admin.pageDesigns.create.idInvalid',
    );
    expect(designIdProblem('a--b', [])).toBe(
      'editor.admin.pageDesigns.create.idInvalid',
    );
    expect(designIdProblem('builtin', [])).toBe(
      'editor.admin.pageDesigns.create.idReserved',
    );
    expect(designIdProblem('ours', ['ours'])).toBe(
      'editor.admin.pageDesigns.create.idTaken',
    );
    expect(designIdProblem('ours-2', ['ours'])).toBeNull();
  });

  it('takes a colour as typed, and tells whether text in it reads on white', () => {
    expect(normalColour(' #ABC ')).toBe('#aabbcc');
    expect(normalColour('1f4e79')).toBe('#1f4e79');
    expect(normalColour('red')).toBeNull();
    expect(normalColour('#12345')).toBeNull();
    expect(contrastOnWhite('#000000')).toEqual({ ratio: 21, enough: true });
    expect(contrastOnWhite('#ffff00').enough).toBe(false);
  });

  it('lists the title page fields, the shown ones first, and reads back the order', () => {
    const rows = fieldRows(['product', 'title']);
    expect(rows.slice(0, 2).map((r) => [r.id, r.shown])).toEqual([
      ['product', true],
      ['title', true],
    ]);
    expect(rows.slice(2).every((r) => !r.shown)).toBe(true);
    const [a, b, c] = rows;
    if (!a || !b || !c) throw new Error('fields missing');
    expect(shownFields([b, a, { ...c, shown: true }])).toEqual([
      'title',
      'product',
      c.id,
    ]);
  });

  it('reads and writes a running header place as one of the manual’s data', () => {
    for (const choice of RUNNING_CHOICES) {
      expect(runningChoiceOf(runningText(choice))).toBe(choice);
    }
    const words = [{ type: 'text', text: 'Ours' }];
    expect(
      runningChoiceOf({ en: words, de: words } as unknown as RunningText),
    ).toBe('custom');
    expect(runningChoiceOf(words as RunningText)).toBe('custom');

    const region: RunningRegion = {
      default: { left: runningText('title') },
    };
    const set = withRunningChoice(region, 'default', 'right', 'page-of');
    expect(runningChoiceOf(set.default.right)).toBe('page-of');
    expect(runningChoiceOf(set.default.left)).toBe('title');
    const cleared = withRunningChoice(set, 'default', 'left', 'none');
    expect(cleared.default.left).toBeUndefined();
    // Custom text is the region editor's: choosing it changes nothing.
    expect(withRunningChoice(set, 'default', 'left', 'custom')).toBe(set);
  });

  it('gives the first page its own header from the default one, and takes it away', () => {
    const region: RunningRegion = {
      default: { centre: runningText('chapter') },
    };
    const on = withRunningVariant(region, 'first', true);
    expect(on.first).toEqual(region.default);
    expect(on.first).not.toBe(region.default);
    expect(withRunningVariant(on, 'first', false)).toEqual(region);
  });

  it('shows four heading levels, the last repeated, and changes one', () => {
    expect(levels(['decimal', 'none'])).toEqual([
      'decimal',
      'none',
      'none',
      'none',
    ]);
    expect(withLevel(['xl'], 2, 'base')).toEqual(['xl', 'xl', 'base', 'xl']);
  });

  it('puts the issues by their place, and the others apart', () => {
    const issues = [
      issue('colours.primary'),
      issue('header.default.left'),
      issue('fonts'),
      issue('somewhere-else', 'custom'),
      issue('backPage', 'missing-manufacturer'),
      { severity: 'error' as const, code: 'x', message: 'x' },
    ];
    expect(issuesAt(issues, 'colours').map((i) => i.at)).toEqual([
      'colours.primary',
    ]);
    expect(issuesAt(issues, 'header', 'fonts')).toHaveLength(2);
    expect(issuesAt(issues, 'col')).toHaveLength(0);
    expect(otherIssues(issues).map((i) => i.at)).toEqual([
      'somewhere-else',
      undefined,
    ]);
  });
});

describe('the back page’s copyright line (#395)', () => {
  it('reads the line in a language, else the source language’s', () => {
    expect(copyrightIn(undefined, 'de', 'en')).toBe('');
    expect(copyrightIn('© Example Works', 'de', 'en')).toBe('© Example Works');
    expect(
      copyrightIn({ en: 'All rights', de: 'Alle Rechte' }, 'de', 'en'),
    ).toBe('Alle Rechte');
    expect(copyrightIn({ en: 'All rights' }, 'fr', 'en')).toBe('All rights');
  });

  it('keeps a line the same in every language while it is edited in the source language', () => {
    expect(withCopyright(undefined, 'en', 'en', '  © Example  Works ')).toBe(
      '© Example Works',
    );
    expect(withCopyright('Old', 'en', 'en', 'New')).toBe('New');
    expect(withCopyright('Old', 'en', 'en', '')).toBeUndefined();
  });

  it('gives another language its own line, keeping the source language’s', () => {
    expect(withCopyright('All rights', 'de', 'en', 'Alle Rechte')).toEqual({
      en: 'All rights',
      de: 'Alle Rechte',
    });
    expect(withCopyright(undefined, 'de', 'en', 'Alle Rechte')).toEqual({
      de: 'Alle Rechte',
    });
    // Emptied in another language: that language's goes, the rest stays.
    expect(
      withCopyright({ en: 'All rights', de: 'Alle Rechte' }, 'de', 'en', ''),
    ).toEqual({ en: 'All rights' });
    expect(withCopyright('All rights', 'de', 'en', '')).toBe('All rights');
    expect(
      withCopyright({ de: 'Alle Rechte' }, 'de', 'en', ''),
    ).toBeUndefined();
  });
});
