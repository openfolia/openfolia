import { describe, expect, it } from 'vitest';

import { checkEnv, checkRuns } from '@/scripts/check.mjs';

/** Nx's style that prints a failed task's own output and collapses the rest. */
const STATIC = '--output-style=static-failures-only';
/** Nx's style that prints every task's output: the flows' and speed criteria's summaries. */
const FULL = '--output-style=static';

describe('checkRuns', () => {
  it('runs the browser flows after the rest, and the speed criteria last', () => {
    expect(checkRuns('run-many')).toEqual([
      [
        'nx',
        ['run-many', '-t', 'test', 'lint', 'typecheck', 'build', STATIC],
        {},
      ],
      ['nx', ['run-many', '-t', 'e2e', FULL], {}],
      ['nx', ['run-many', '-t', 'perf', FULL], {}],
    ]);
  });

  it('hands the arguments to every run, and the base and head to the browser flows', () => {
    expect(checkRuns('affected', ['--base=a', '--head=b'])).toEqual([
      [
        'nx',
        [
          'affected',
          '-t',
          'test',
          'lint',
          'typecheck',
          'build',
          STATIC,
          '--base=a',
          '--head=b',
        ],
        {},
      ],
      [
        'nx',
        ['affected', '-t', 'e2e', FULL, '--base=a', '--head=b'],
        { CCMS_E2E_SELECT: 'affected', CCMS_E2E_BASE: 'a', CCMS_E2E_HEAD: 'b' },
      ],
      ['nx', ['affected', '-t', 'perf', FULL, '--base=a', '--head=b'], {}],
    ]);
  });

  it('selects the affected flows without a base too (nx affected then compares with main)', () => {
    expect(checkRuns('affected')[1]).toEqual([
      'nx',
      ['affected', '-t', 'e2e', FULL],
      { CCMS_E2E_SELECT: 'affected' },
    ]);
    expect(checkRuns('affected', ['--base', 'x'])[1]?.[2]).toEqual({
      CCMS_E2E_SELECT: 'affected',
      CCMS_E2E_BASE: 'x',
    });
  });

  it("prints a failed task's own output, and the flows' and speed criteria's summaries, unless the arguments name another style", () => {
    expect(
      checkRuns('run-many').map(([, args]) =>
        args.filter((arg) => arg.startsWith('--output-style')),
      ),
    ).toEqual([[STATIC], [FULL], [FULL]]);
    for (const own of [
      ['--output-style=stream'],
      ['--output-style', 'stream'],
      ['--outputStyle=tui'],
      ['--tui'],
      ['--no-tui'],
      ['--output-style'],
    ]) {
      for (const [, args] of checkRuns('run-many', own)) {
        expect(args).not.toContain(STATIC);
        expect(args).not.toContain(FULL);
        expect(args.slice(-own.length)).toEqual(own);
      }
    }
  });

  it('refuses another mode', () => {
    expect(() => checkRuns('run')).toThrow(/run-many or affected/);
  });
});

describe('checkEnv', () => {
  it('turns the Nx daemon off in a linked worktree (#615)', () => {
    expect(checkEnv({ inWorktree: true, env: {} })).toEqual({
      NX_DAEMON: 'false',
    });
  });

  it('leaves the main checkout, and a caller`s own choice, as they are', () => {
    expect(checkEnv({ inWorktree: false, env: {} })).toEqual({});
    expect(checkEnv({ inWorktree: true, env: { NX_DAEMON: 'true' } })).toEqual(
      {},
    );
  });
});
