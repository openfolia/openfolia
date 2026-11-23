import { DEFAULT_CODE_LANGUAGES } from '../../doc-editor/blocks/code-languages';
import {
  builtInLanguages,
  ownLanguages,
  withBuiltInName,
  withOwnLanguages,
} from './code-languages-model';

const configured = [
  { id: 'fortran', label: 'Fortran' },
  { id: 'json', label: 'JSON (strict)' },
  { id: 'cobol', label: 'COBOL' },
];

describe('code languages in the settings', () => {
  it('splits the configured list into the own ones and the renamed built-in ones', () => {
    expect(ownLanguages(configured).map((l) => l.id)).toEqual([
      'fortran',
      'cobol',
    ]);
    const builtIn = builtInLanguages(configured);
    expect(builtIn.map((l) => l.id)).toEqual(
      DEFAULT_CODE_LANGUAGES.map((l) => l.id),
    );
    expect(builtIn.find((l) => l.id === 'json')?.label).toBe('JSON (strict)');
    expect(builtIn.find((l) => l.id === 'yaml')?.label).toBe('YAML');
  });

  it('matches a built-in ID whatever its case, as the picker does', () => {
    const list = [{ id: 'YAML', label: 'Yet another' }];
    expect(ownLanguages(list)).toEqual([]);
    expect(builtInLanguages(list).find((l) => l.id === 'yaml')?.label).toBe(
      'Yet another',
    );
  });

  it('renames a built-in one with an entry of its ID, in place of the one it had', () => {
    expect(withBuiltInName(configured, 'yaml', 'YAML 1.2')).toEqual([
      ...configured,
      { id: 'yaml', label: 'YAML 1.2' },
    ]);
    expect(withBuiltInName(configured, 'JSON', 'JSON5')).toEqual([
      configured[0],
      { id: 'json', label: 'JSON5' },
      configured[2],
    ]);
  });

  it('writes nothing for the shipped name, and Reset takes the entry out', () => {
    expect(withBuiltInName(configured, 'json', 'JSON')).toEqual([
      configured[0],
      configured[2],
    ]);
    expect(withBuiltInName(configured, 'json', null)).toEqual([
      configured[0],
      configured[2],
    ]);
    expect(withBuiltInName([], 'xml', 'XML')).toEqual([]);
  });

  it('leaves the list alone for an ID that is not built in', () => {
    expect(withBuiltInName(configured, 'fortran', null)).toEqual(configured);
  });

  it('keeps the renamed built-in ones when the own ones change', () => {
    expect(
      withOwnLanguages(configured, [{ id: 'cobol', label: 'COBOL' }]),
    ).toEqual([
      { id: 'cobol', label: 'COBOL' },
      { id: 'json', label: 'JSON (strict)' },
    ]);
  });
});
