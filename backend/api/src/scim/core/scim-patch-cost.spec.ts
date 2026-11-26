import { ScimInvalidValueError } from './scim-errors.js';
import type { JsonObject } from './scim-json.js';
import { listPage } from './scim-list.js';
import { applyPatch, type PatchOperation } from './scim-patch.js';
import { MAX_CPU_MS, spend, withBudget } from './scim-work.js';

/**
 * A PATCH runs under the access lock, on the one event loop: whatever shape its operations have,
 * it stops at the budget (`scim-work.ts`) before it holds the server up. Most cases below ran for
 * ten seconds to minutes under an earlier limit; a few are cheap and pass.
 */
describe('what a PATCH and a list filter may cost', () => {
  const members = (count: number, item: (i: number) => JsonObject) =>
    Array.from({ length: count }, (_, i) => item(i));
  const group = (items: unknown[]): JsonObject => ({
    id: 'g',
    displayName: 'Everyone',
    members: items,
  });
  const repeat = (count: number, op: (i: number) => PatchOperation) =>
    Array.from({ length: count }, (_, i) => op(i));
  const keys = (count: number, prefix: string) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`${prefix}k${i}`, 1]),
    );
  const many = members(20_000, (i) => ({ value: `u${i}` }));

  const cases: [string, JsonObject, PatchOperation[]][] = [
    [
      'a filtered remove per member',
      group(many),
      repeat(1000, (i) => ({
        op: 'remove',
        path: `members[value eq "u${i}"]`,
      })),
    ],
    [
      'a long filter over many members',
      group(many),
      repeat(5, () => ({
        op: 'remove',
        path: `members[${Array.from({ length: 80 }, (_, i) => `value eq "zz${i}"`).join(' or ')}]`,
      })),
    ],
    [
      'one operation bringing in an object of thousands of keys',
      { id: 'u' },
      [{ op: 'add', value: keys(40_000, '') }],
    ],
    [
      'operations growing one object',
      { id: 'u', name: { familyName: 'x' } },
      repeat(1000, (n) => ({
        op: 'add',
        path: 'name',
        value: keys(100, `o${n}`),
      })),
    ],
    [
      'operations growing the resource itself',
      { id: 'u' },
      repeat(1000, (n) => ({ op: 'add', value: keys(100, `o${n}`) })),
    ],
    [
      'operations growing one filtered value',
      group([{ value: 'u1' }]),
      repeat(1000, (n) => ({
        op: 'add',
        path: 'members[value eq "u1"]',
        value: keys(100, `o${n}`),
      })),
    ],
    [
      'a large array planted in one value, then filtered on',
      { id: 'u' },
      [
        {
          op: 'add',
          path: 'emails',
          value: [{ type: 'work', x: members(50_000, () => ({ v: 'a' })) }],
        },
        ...repeat(20, () => ({
          op: 'remove' as const,
          path: `emails[${Array.from({ length: 100 }, () => 'x.v eq "q"').join(' or ')}]`,
        })),
      ],
    ],
    [
      'a long string compared again and again',
      group([{ value: 'u', display: 'd'.repeat(500_000) }]),
      repeat(1000, () => ({ op: 'remove', path: 'members[display co "q"]' })),
    ],
    [
      'large values added and removed in turn',
      group(members(200, (i) => ({ value: `${i}${'v'.repeat(4000)}` }))),
      repeat(1000, (i) =>
        i % 2 === 0
          ? { op: 'add', path: 'members', value: [{ value: `n${i}` }] }
          : { op: 'remove', path: 'members', value: [{ value: `n${i - 1}` }] },
      ),
    ],
    [
      'a large value written into every value a filter selects',
      group(many),
      [
        {
          op: 'replace',
          path: 'members[value pr].display',
          value: 'd'.repeat(500_000),
        },
      ],
    ],
    [
      'numbers that print slowly, printed again and again',
      { id: 'u' },
      [
        {
          op: 'add',
          path: 'x',
          value: [Array.from({ length: 106_000 }, () => 8.4e-302)],
        },
        ...repeat(999, () => ({
          op: 'remove' as const,
          path: 'x',
          value: 0,
        })),
      ],
    ],
    [
      'text that lowercases slowly',
      { id: 'u', x: [{ a: '\u0130'.repeat(480_000) }] },
      repeat(990, () => ({ op: 'remove', path: 'x[a co "q"]' })),
    ],
    [
      'a search with a long needle that almost matches',
      { id: 'u', emails: [{ display: 'a'.repeat(800_000) }] },
      repeat(80, () => ({
        op: 'remove',
        path: `emails[display co "ab${'a'.repeat(1900)}"]`,
      })),
    ],
    [
      'presence of an object grown to thousands of keys',
      { id: 'u', 'urn:a': { t: { x: {} } } },
      [
        ...repeat(20, (n) => ({
          op: 'add' as const,
          path: 'urn:a:t.x',
          value: keys(100, `o${n}`),
        })),
        ...repeat(450, () => ({
          op: 'remove' as const,
          path: `urn:a:t[${'x pr and '.repeat(215)}y pr]`,
        })),
      ],
    ],
    [
      'long names in a filter over values without them',
      { id: 'u', ['a'.repeat(960)]: members(4000, () => ({})) },
      repeat(400, () => ({
        op: 'remove',
        path: `${'a'.repeat(960)}[b.${'c'.repeat(960)} eq 1]`,
      })),
    ],
    [
      'a long attribute name looked up again and again',
      { id: 'u', ['k'.repeat(500_000)]: 1 },
      repeat(1000, (i) => ({ op: 'replace', path: `a${i}`, value: 1 })),
    ],
  ];

  /** The CPU time of `run` in ms, which either ends or is refused as too much work. */
  function cpuOf(run: () => unknown): number {
    const start = process.threadCpuUsage();
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ScimInvalidValueError);
    }
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  }

  it.each(cases)(
    'is bounded: %s',
    { timeout: 120_000 },
    (_, resource, operations) => {
      expect(cpuOf(() => applyPatch(resource, operations))).toBeLessThan(
        2.5 * MAX_CPU_MS,
      );
    },
  );

  it('bounds what a long name written into every value selected adds', () => {
    const name = (i: number) => `n${i}`.padEnd(1900, 'x');
    const write = (op: 'add' | 'replace', path: (i: number) => string) =>
      applyPatch(
        group(many),
        repeat(5, (i) => ({ op, path: path(i), value: 1 })),
      );
    for (const op of ['add', 'replace'] as const) {
      expect(() => write(op, (i) => `members[value pr].${name(i)}`)).toThrow(
        ScimInvalidValueError,
      );
    }
  });

  it('refuses what is too much work', { timeout: 120_000 }, () => {
    expect(() =>
      applyPatch(
        group(many),
        repeat(1000, (i) => ({
          op: 'remove',
          path: `members[value eq "u${i}"]`,
        })),
      ),
    ).toThrow(ScimInvalidValueError);
    expect(() =>
      withBudget(() => {
        for (;;) spend(0);
      }),
    ).toThrow(ScimInvalidValueError);
  });

  it('leaves room for what directories send', { timeout: 60_000 }, () => {
    const added = applyPatch(
      group(many),
      repeat(1000, (i) => ({
        op: 'add',
        path: 'members',
        value: [{ value: `new${i}` }],
      })),
    );
    expect(added['members']).toHaveLength(21_000);
    const removed = applyPatch(group(many), [
      {
        op: 'remove',
        path: 'members',
        value: members(1000, (i) => ({ value: `u${i}` })),
      },
      ...repeat(20, (i) => ({
        op: 'remove' as const,
        path: `members[value eq "u${5000 + i}"]`,
      })),
    ]);
    expect(removed['members']).toHaveLength(18_980);
    const singly = applyPatch(
      group(many),
      repeat(60, (i) => ({
        op: 'remove',
        path: 'members',
        value: [{ value: `u${i}` }],
      })),
    );
    expect(singly['members']).toHaveLength(19_940);
    const smaller = applyPatch(
      group(many.slice(0, 5000)),
      repeat(200, (i) => ({ op: 'remove', path: `members[value eq "u${i}"]` })),
    );
    expect(smaller['members']).toHaveLength(4800);
  });

  it(
    'bounds a list filter too, and leaves plain ones room',
    { timeout: 60_000 },
    () => {
      const page = { startIndex: 1, count: 100 };
      const users = members(100, (i) => ({
        userName: `u${i}`,
        nickName: 'a'.repeat(15_900),
      }));
      const list = (filter: string, all = users) =>
        listPage(all, (u) => u, filter, page);
      expect(
        cpuOf(() =>
          list(
            `nickName co "ab${'a'.repeat(1960)}"`,
            Array.from({ length: 2000 }, () => users).flat(),
          ),
        ),
      ).toBeLessThan(2.5 * MAX_CPU_MS);
      const directory = members(50_000, (i) => ({
        id: `${i}`,
        userName: `u${i}@example.org`,
        emails: [{ value: `u${i}@example.org`, primary: true }],
      }));
      expect(
        list('userName eq "u7@example.org" or emails co "u8@"', directory)
          .total,
      ).toBe(2);
    },
  );
});
