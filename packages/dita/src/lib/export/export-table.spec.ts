import {
  MAX_TABLE_COLUMNS,
  TableTooLargeError,
  type Module,
  type Table,
} from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_MANUAL,
  SAMPLE_MODULES,
  sampleInput,
} from '../../testing/export-sample.js';
import { exportDita } from './export.js';

/**
 * A table past the column cap (#686), its columns behind a proxy counting how many are read:
 * laying out its grid starts with them, walking its blocks never reads one.
 */
function countingWideTable(): { table: Table; reads: () => number } {
  const columns = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => ({
    width: 1,
  }));
  let reads = 0;
  const counted = new Proxy(columns, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    table: {
      type: 'table',
      id: 'wide',
      columns: counted,
      header: false,
      rows: Array.from({ length: 3 }, () => ({
        cells: columns.map(() => ({ blocks: [] })),
      })),
    },
    reads: () => reads,
  };
}

describe('exportDita and a table past the caps (#686)', () => {
  it('refuses it before its grid is laid out', () => {
    const { table, reads } = countingWideTable();
    const wide: Module = {
      ...(SAMPLE_MODULES[1] as Module),
      id: 'wide',
      blocks: [table],
    };
    expect(() =>
      exportDita(
        sampleInput({
          languages: ['en'],
          manifest: { ...SAMPLE_MANUAL, entries: [{ module: 'wide' }] },
          module: (id) => (id === 'wide' ? wide : undefined),
        }),
      ),
    ).toThrow(TableTooLargeError);
    expect(reads()).toBe(0);
  });
});
