import { readFileSync } from 'node:fs';
import { batteryDisposal, chargingProcedure } from '../../fixtures/modules.js';
import { Module } from '../module.js';
import { normalizeModule } from '../normalize.js';
import { parseModule } from './parse.js';
import { printModule } from './print.js';

const golden = readFileSync(
  new URL('../../fixtures/battery-charging.adoc', import.meta.url),
  'utf8',
);

describe('AsciiDoc golden file', () => {
  it('prints the sample module exactly as the golden file', () => {
    expect(printModule(Module.parse(chargingProcedure))).toBe(golden);
  });

  it('parses the golden file back into the sample module', () => {
    expect(parseModule(golden, { id: 'battery-charging' })).toEqual(
      normalizeModule(Module.parse(chargingProcedure)),
    );
  });

  it('round-trips the reusable safety module', () => {
    const module = Module.parse(batteryDisposal);
    expect(parseModule(printModule(module), { id: module.id })).toEqual(
      normalizeModule(module),
    );
  });
});
