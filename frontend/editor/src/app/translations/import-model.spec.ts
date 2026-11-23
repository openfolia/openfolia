import { ApiError } from '../api';
import {
  decide,
  decisionOf,
  decisionsBody,
  importCount,
  importErrorText,
  KEEP_ALL,
  reasonText,
  sourceSides,
  unitKey,
  type ImportCounts,
} from './import-model';

const counts: ImportCounts = {
  units: 6,
  ok: 2,
  sourceChanged: 3,
  brokenMarkup: 1,
  unknownBlock: 0,
  unknownModule: 0,
  outsideScope: 0,
};
const changed = ['a', 'b', 'c'].map((blockId) => ({
  lang: 'de',
  moduleId: 'm',
  blockId,
}));
const key = (blockId: string) => unitKey('de', 'm', blockId);

describe('import decisions', () => {
  it('keeps every changed unit by default and sends no decision', () => {
    expect(decisionOf(KEEP_ALL, key('a'))).toBe('keep');
    expect(importCount(counts, KEEP_ALL)).toBe(5);
    expect(decisionsBody(KEEP_ALL, changed)).toEqual([]);
  });

  it('skips one unit, and keeping it again takes the skip back', () => {
    const skipped = decide(KEEP_ALL, key('b'), 'skip');
    expect(decisionOf(skipped, key('b'))).toBe('skip');
    expect(importCount(counts, skipped)).toBe(4);
    expect(decisionsBody(skipped, changed)).toEqual([
      { lang: 'de', moduleId: 'm', blockId: 'b', decision: 'skip' },
    ]);
    expect(decide(skipped, key('b'), 'keep').except.size).toBe(0);
  });

  it('skips all but those kept since, on every page', () => {
    const all = decide({ all: 'skip', except: new Set() }, key('a'), 'keep');
    expect(importCount(counts, all)).toBe(3);
    expect(decisionsBody(all, changed).map((d) => d.blockId)).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('import report texts', () => {
  it('marks what was deleted on the old side and what was inserted on the new', () => {
    const { before, after } = sourceSides('Weight 40 kg', 'Weight 42 kg');
    expect(before.filter((s) => s.op === 'del').map((s) => s.text)).toEqual([
      '40',
    ]);
    expect(after.filter((s) => s.op === 'ins').map((s) => s.text)).toEqual([
      '42',
    ]);
    expect(before.some((s) => s.op === 'ins')).toBe(false);
  });

  it('names why a unit is refused by its reason, or its state', () => {
    expect(
      reasonText({ blockId: 'x', state: 'broken-markup', reason: 'nesting' }),
    ).toBe('editor.translations.importScreen.reason.nesting');
    expect(
      reasonText({ blockId: 'x', state: 'broken-markup', reason: 'new-one' }),
    ).toBe('editor.translations.importScreen.reason.brokenMarkup');
    expect(reasonText({ blockId: 'x', state: 'outside-scope' })).toBe(
      'editor.translations.importScreen.reason.outsideScope',
    );
    expect(reasonText({ blockId: 'x', state: 'ok' })).toBeNull();
  });

  it('names the import’s own refusals, and leaves the rest to the shared texts', () => {
    const error = (code: string) =>
      new ApiError('invalid', 422, code, 'x', undefined, undefined, []);
    expect(importErrorText(error('xliff-too-deep')).key).toBe(
      'editor.translations.importScreen.fileError.tooComplex',
    );
    expect(importErrorText(error('xliff-something-new')).key).toBe(
      'editor.translations.importScreen.fileError.invalid',
    );
    expect(importErrorText(error('mixed-jobs')).key).toBe(
      'editor.translations.importScreen.error.mixedJobs',
    );
    expect(importErrorText(error('locked')).key).toBe(
      'editor.apiErrors.codes.locked',
    );
  });
});
