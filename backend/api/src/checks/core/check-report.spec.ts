import type { Check } from './check.js';
import { reportChecks } from './check-report.js';

const COMMIT = 'a'.repeat(40);
const check = (over: Partial<Check>): Check => ({
  code: 'style-rule',
  subject: { type: 'module', lang: 'en', moduleId: 'storage' },
  blockId: 'dry',
  message: 'Name the\nconditions.',
  params: {},
  variants: [],
  languages: [],
  ...over,
});

describe('reportChecks (the CLI check, #55)', () => {
  it('exits 0 with warnings only, one line per check and a count', () => {
    const report = reportChecks(
      {
        commit: COMMIT,
        modules: ['storage'],
        checks: [
          check({}),
          check({
            code: 'missing-translation',
            subject: { type: 'manual', manualId: 'operating' },
            blockId: undefined,
            message: 'no "de" translation',
          }),
        ],
      },
      'text',
    );
    expect(report).toEqual({
      exitCode: 0,
      output: [
        'warning  style-rule en/storage#dry: Name the conditions.',
        'warning  missing-translation manual/operating: no "de" translation',
        `0 blocking, 2 warning(s) in 1 module(s) at ${COMMIT}.`,
        '',
      ].join('\n'),
    });
  });

  it('prints a message on one line, without bidirectional overrides or separators', () => {
    const report = reportChecks(
      {
        commit: COMMIT,
        modules: ['storage'],
        checks: [
          check({ message: 'a\u202Eb\u2028c\u2066d\u001B[31me\u009Bf' }),
        ],
      },
      'text',
    );
    expect(report.output.split('\n')[0]).toBe(
      'warning  style-rule en/storage#dry: a b c d [31me f',
    );
  });

  it('exits 1 with a blocking check, the severity the configuration gave it included', () => {
    const configured = reportChecks(
      {
        commit: COMMIT,
        modules: ['storage'],
        checks: [check({ code: 'forbidden-term', severity: 'blocking' })],
      },
      'text',
    );
    expect(configured.exitCode).toBe(1);
    expect(configured.output).toMatch(
      /^blocking forbidden-term en\/storage#dry/,
    );
    const json = reportChecks(
      {
        commit: COMMIT,
        modules: [],
        checks: [check({ code: 'invalid-module', blockId: undefined })],
      },
      'json',
    );
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.output)).toEqual({
      commit: COMMIT,
      counts: { blocking: 1, warning: 0 },
      modules: 0,
      checks: [
        {
          code: 'invalid-module',
          severity: 'blocking',
          category: 'validation',
          subject: { type: 'module', lang: 'en', moduleId: 'storage' },
          blockId: null,
          message: 'Name the\nconditions.',
          params: {},
          variants: [],
          languages: [],
        },
      ],
    });
  });
});
