import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  argumentsOf,
  checkLanguages,
  checkUsage,
  readScope,
  sourceFiles,
} from './translations.mjs';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const languages = readScope(at('../src/i18n/'));
// The library's keys are used by the library and by the apps built on it.
const files = sourceFiles([at('../src/lib/'), at('../../editor/src/app/')]);

describe('the ui translations', () => {
  it('ship English and German', () => {
    assert.ok(languages.has('en'));
    assert.ok(languages.has('de'));
  });

  it('have the same keys and arguments in every language, as valid ICU', () => {
    assert.deepEqual(checkLanguages(languages), []);
  });

  it('are all used, and every key the code uses exists', () => {
    const { unused, unknown } = checkUsage('ui', languages, files);
    assert.deepEqual(unused, [], 'keys no code uses');
    assert.deepEqual(unknown, [], 'keys the code uses that en.json lacks');
  });
});

describe('the checks themselves', () => {
  it('find a missing key, an extra key, a changed argument and broken ICU', () => {
    const en = new Map([
      ['a', 'A {name}'],
      ['b', 'B'],
      ['c', '{n, plural, one {# x} other {# xs}}'],
    ]);
    const de = new Map([
      ['a', 'A {nme}'],
      ['c', '{n, plural, one {# x} other {# xs}'],
      ['d', 'D'],
    ]);
    const problems = checkLanguages(
      new Map([
        ['en', en],
        ['de', de],
      ]),
    );
    assert.ok(problems.some((p) => p.includes('"b" is missing')));
    assert.ok(problems.some((p) => p.includes('"d" is not in en.json')));
    assert.ok(problems.some((p) => p.includes('"a" has the arguments')));
    assert.ok(problems.some((p) => p.includes('"c" is not valid ICU')));
  });

  it('read the arguments of nested ICU messages', () => {
    assert.deepEqual(
      argumentsOf('{n, plural, one {# for {term}} other {#}} {x, number}'),
      ['n', 'term', 'x'],
    );
  });
});
