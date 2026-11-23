import fc from 'fast-check';
import { moduleArb } from '../../fixtures/module-arbitrary.js';
import type { Module } from '../module.js';
import { normalizeModule } from '../normalize.js';
import { sourceHash, translatableUnits } from '../translation.js';
import { parseModule } from './parse.js';
import { printModule } from './print.js';

describe('AsciiDoc round trip', () => {
  it('parse(print(module)) equals the normalized module, and printing is stable', () => {
    fc.assert(
      fc.property(moduleArb, (module) => {
        const printed = printModule(module);
        const parsed = parseModule(printed, { id: module.id });
        expect(parsed).toEqual(normalizeModule(module));
        expect(printModule(parsed)).toBe(printed);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps every translatable unit and its source hash over print and parse', () => {
    const hashes = (m: Module) =>
      translatableUnits(m).map((u) => [u.blockId, sourceHash(u)]);
    fc.assert(
      fc.property(moduleArb, (module) => {
        const parsed = parseModule(printModule(module), { id: module.id });
        expect(hashes(parsed)).toEqual(hashes(module));
      }),
      { numRuns: 150 },
    );
  });
});
