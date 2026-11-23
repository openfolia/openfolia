import { describe, expect, it } from 'vitest';

import { templateFileProblem, templateIdProblem } from './template-files';

const P = 'editor.admin.pageDesigns.templates.newFile.problems';

describe('templateFileProblem', () => {
  it('takes a text file in the folder or a folder of it', () => {
    expect(templateFileProblem('notice.typ', [])).toBeNull();
    expect(templateFileProblem('parts/data/table.csv', [])).toBeNull();
  });

  it('says why a path cannot be a new file, one rule at a time', () => {
    expect(templateFileProblem('', [])).toBe(`${P}.empty`);
    expect(templateFileProblem(`${'a'.repeat(147)}.typ`, [])).toBe(
      `${P}.tooLong`,
    );
    expect(templateFileProblem('a/b/c/d/e/f/g/h/i.typ', [])).toBe(
      `${P}.tooDeep`,
    );
    for (const path of [
      '../outside.typ',
      '/etc/passwd.txt',
      '.hidden.typ',
      'a//b.typ',
      'a\\b.typ',
      'name with space.typ',
    ]) {
      expect(templateFileProblem(path, []), path).toBe(`${P}.invalid`);
    }
    expect(templateFileProblem('logo.png', [])).toBe(`${P}.notText`);
    expect(templateFileProblem('README', [])).toBe(`${P}.notText`);
    expect(templateFileProblem('manual.typ', ['manual.typ'])).toBe(
      `${P}.taken`,
    );
    expect(templateFileProblem('manual.typ/x.typ', ['manual.typ'])).toBe(
      `${P}.clash`,
    );
    expect(templateFileProblem('parts.typ', ['parts.typ/a.typ'])).toBe(
      `${P}.clash`,
    );
  });

  it('allows exactly as deep as the API does', () => {
    expect(templateFileProblem('a/b/c/d/e/f/g/h.typ', [])).toBeNull();
  });
});

describe('templateIdProblem', () => {
  const C = 'editor.admin.pageDesigns.templates.create';

  it('takes a slug no template has', () => {
    expect(templateIdProblem('house-style', ['example'])).toBeNull();
  });

  it('refuses an empty, invalid, too long or taken ID', () => {
    expect(templateIdProblem('', [])).toBe(`${C}.idRequired`);
    expect(templateIdProblem('Not a slug', [])).toBe(`${C}.idInvalid`);
    expect(templateIdProblem('../x', [])).toBe(`${C}.idInvalid`);
    expect(templateIdProblem('a'.repeat(65), [])).toBe(`${C}.idInvalid`);
    expect(templateIdProblem('example', ['example'])).toBe(`${C}.idTaken`);
  });
});
