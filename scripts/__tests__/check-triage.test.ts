import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RERUN_TIMEOUT_MS,
  rerunArgs,
  rerunOutcome,
  testTarget,
  timeoutOnlyFailures,
  triageMessage,
  unsafeFiles,
} from '@/scripts/check-triage.mjs';

const summary = (...failed: string[]) =>
  [
    '',
    ' NX   Ran targets test, lint for 3 projects (12s)',
    '',
    `   ✔  ${6 - failed.length}/6 succeeded [0 read from cache]`,
    '',
    `   ✖  ${failed.length}/6 targets failed, including the following:`,
    '',
    ...failed.map((task) => `      - ${task}`),
  ].join('\n');

/**
 * A real `check:changed` run (#627), cut short, ANSI codes kept: Nx printed its closing summary
 * while api:test was still writing, so the FAIL block and vitest's summary come after it, with
 * Nest's error logs from other tests in between.
 */
const FIXTURE = readFileSync(
  path.join(
    import.meta.dirname,
    'fixtures',
    'sync-main-timeout-after-summary.txt',
  ),
  'utf8',
);

const task = (name: string) => `\n> nx run ${name}\n`;

const timedOut = (file: string, test: string, label = '') =>
  [
    ` FAIL  ${label}${file} > ${test}`,
    'Error: Test timed out in 15000ms.',
    'If this is a long-running test, pass a timeout value as the last argument.',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
  ].join('\n');

describe('timeoutOnlyFailures', () => {
  it('returns the files per project when only test tasks failed, every one on a timeout', () => {
    const output = [
      task('api:lint'),
      'All files pass linting.',
      task('api:test'),
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
      timedOut('src/a.test.ts', 'saves', '|api| '),
      '\u001b[31m FAIL \u001b[39m src/b.test.ts > loads',
      'Error: Hook timed out in 10000ms.',
      timedOut('src/a.test.ts', 'deletes'),
      task('workflow:test'),
      timedOut('__tests__/c.test.ts', 'runs'),
      summary('api:test', 'workflow:test'),
    ].join('\n');
    expect(timeoutOnlyFailures(output)).toEqual({
      runs: [
        { project: 'api', files: ['src/a.test.ts', 'src/b.test.ts'] },
        { project: 'workflow', files: ['__tests__/c.test.ts'] },
      ],
    });
  });

  it('is null when any failure is not a timeout, a file did not load, or another target failed', () => {
    const assertion = [
      ' FAIL  src/x.test.ts > adds',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${timedOut('a.test.ts', 't')}\n${assertion}\n${summary('api:test')}`,
      ),
    ).toBeNull();
    expect(
      timeoutOnlyFailures(
        `${task('api:test')} FAIL  |api| src/x.test.ts [ src/x.test.ts ]\nError: x\n${timedOut('a.test.ts', 't')}\n${summary('api:test')}`,
      ),
    ).toBeNull();
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${timedOut('a.test.ts', 't')}\n${summary('api:lint', 'api:test')}`,
      ),
    ).toBeNull();
    // A failed test task without a timed-out file failed some other way.
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${timedOut('a.test.ts', 't')}\n${task('web:test')}Error: config\n${summary('api:test', 'web:test')}`,
      ),
    ).toBeNull();
    expect(timeoutOnlyFailures(summary('api:test'))).toBeNull();
    expect(
      timeoutOnlyFailures(`${task('api:test')}${timedOut('a.test.ts', 't')}`),
    ).toBeNull();
    expect(timeoutOnlyFailures('')).toBeNull();
  });

  it('reads the summary Nx prints when a run fails', () => {
    const output = [
      task('workflow:test'),
      timedOut('__tests__/c.test.ts', 'runs', '|workflow| '),
      // With colours, vitest's project label is a coloured name, no pipes.
      timedOut(
        '__tests__/d.test.ts',
        'runs',
        '\u001b[30m\u001b[45m workflow \u001b[49m\u001b[39m ',
      ),
      '',
      ' NX   Running targets test, lint for project workflow failed',
      '',
      'Failed tasks:',
      '',
      '- workflow:test',
    ].join('\n');
    expect(timeoutOnlyFailures(output)).toEqual({
      runs: [
        {
          project: 'workflow',
          files: ['__tests__/c.test.ts', '__tests__/d.test.ts'],
        },
      ],
    });
  });

  it('reads a real run whose timed-out FAIL came after Nx had printed its summary (#627)', () => {
    expect(timeoutOnlyFailures(FIXTURE)).toEqual({
      runs: [{ project: 'api', files: ['tests/refresh.e2e.spec.ts'] }],
    });
  });

  it('reads a FAIL printed after the summary, and still refuses one that is not a timeout', () => {
    const closing = [
      '',
      ' NX   Running targets test for project api failed',
      '',
      'Failed tasks:',
      '',
      '- api:test',
      '',
    ].join('\n');
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${closing}\n${timedOut('a.test.ts', 't')}`,
      ),
    ).toEqual({ runs: [{ project: 'api', files: ['a.test.ts'] }] });
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${closing}\n FAIL  a.test.ts > t\nAssertionError: expected 1 to be 2`,
      ),
    ).toBeNull();
    // A line of test output after the list is not another failed task.
    expect(
      timeoutOnlyFailures(
        `${task('api:test')}${closing}\n${timedOut('a.test.ts', 't')}\n- web:lint`,
      ),
    ).toEqual({ runs: [{ project: 'api', files: ['a.test.ts'] }] });
  });

  describe('rerunArgs', () => {
    const vitest = testTarget({
      root: 'backend/api',
      targets: {
        test: {
          executor: 'nx:run-commands',
          options: { cwd: 'backend/api', command: 'vitest run' },
        },
      },
    });
    const angular = testTarget({
      root: 'frontend/editor',
      sourceRoot: 'frontend/editor/src',
      targets: { test: { executor: '@angular/build:unit-test', options: {} } },
    });

    it('passes Vitest files as positional filters after --, without the cache', () => {
      expect(
        rerunArgs({ project: 'api', files: ['src/a.test.ts'] }, vitest),
      ).toEqual([
        'nx',
        'run',
        'api:test',
        '--skip-nx-cache',
        '--output-style=static',
        '--',
        'src/a.test.ts',
      ]);
    });

    it('passes the Angular builder each file as --include, never positional', () => {
      const args = rerunArgs(
        {
          project: 'editor',
          files: [
            'frontend/editor/src/app/review/review.page.spec.ts',
            'frontend/editor/src/app/a.spec.ts',
          ],
        },
        angular,
      );
      expect(args).toEqual([
        'nx',
        'run',
        'editor:test',
        '--skip-nx-cache',
        '--output-style=static',
        '--include=app/review/review.page.spec.ts',
        '--include=app/a.spec.ts',
      ]);
      expect(args).not.toContain('--');
    });

    it('makes the paths relative to the project: its test cwd for Vitest, its source root for Angular', () => {
      expect(
        rerunArgs(
          {
            project: 'api',
            files: ['backend/api/src/a.test.ts', 'src/b.test.ts'],
          },
          vitest,
        ).slice(-2),
      ).toEqual(['src/a.test.ts', 'src/b.test.ts']);
      expect(
        rerunArgs({ project: 'editor', files: ['app/x.spec.ts'] }, angular).at(
          -1,
        ),
      ).toBe('--include=app/x.spec.ts');
      // A project without its own cwd or source root: relative to the project root.
      const bare = testTarget({
        root: 'frontend/ui',
        targets: { test: { executor: '@angular/build:unit-test' } },
      });
      expect(
        rerunArgs(
          { project: 'ui', files: ['frontend/ui/src/b.spec.ts'] },
          bare,
        ).at(-1),
      ).toBe('--include=src/b.spec.ts');
    });
  });

  describe('rerunOutcome', () => {
    it('passed or failed only when the re-run ran tests', () => {
      const ran = (summary: string) =>
        `\u001b[2m      Tests \u001b[22m \u001b[1m${summary}\u001b[22m\n`;
      expect(
        rerunOutcome({ status: 0, output: ran('23 passed (23)') }),
      ).toEqual({
        kind: 'passed',
      });
      expect(
        rerunOutcome({ status: 1, output: ran('1 failed | 22 passed (23)') }),
      ).toEqual({ kind: 'failed' });
    });

    it('ran no test: a schema error, no tests found, or no summary at all, with its reason', () => {
      expect(
        rerunOutcome({
          status: 1,
          output:
            " NX  Schema does not support positional arguments. Argument 'frontend/editor/src/a.spec.ts' found\n",
        }),
      ).toEqual({
        kind: 'no-tests',
        reason:
          "NX  Schema does not support positional arguments. Argument 'frontend/editor/src/a.spec.ts' found",
      });
      expect(
        rerunOutcome({
          status: 1,
          output:
            'An exception occurred:\nError: No tests found matching the following patterns:\n',
        }).reason,
      ).toBe('Error: No tests found matching the following patterns:');
      expect(
        rerunOutcome({
          status: 1,
          output: 'No test files found, exiting with code 1\n',
        }).reason,
      ).toBe('No test files found, exiting with code 1');
      expect(rerunOutcome({ status: 0, output: 'done\n' })).toEqual({
        kind: 'no-tests',
        reason: 'its output has no test summary',
      });
    });
  });

  describe('rerunOutcome, the edges', () => {
    it('a re-run stopped by its deadline or a signal ran no test, whatever it printed', () => {
      const output = '      Tests  1 failed (1)\n';
      expect(rerunOutcome({ status: 1, output, timedOut: true })).toEqual({
        kind: 'no-tests',
        reason: `it did not finish within ${RERUN_TIMEOUT_MS / 60000} minutes and was stopped`,
      });
      expect(rerunOutcome({ status: 1, output, signal: 'SIGKILL' })).toEqual({
        kind: 'no-tests',
        reason: 'it was stopped by SIGKILL',
      });
    });

    it('only skipped tests is no pass; a file that failed to load is a failure', () => {
      expect(
        rerunOutcome({ status: 0, output: '      Tests  3 skipped (3)\n' }),
      ).toEqual({ kind: 'no-tests', reason: 'no test passed (all skipped)' });
      expect(
        rerunOutcome({
          status: 1,
          output: ' Test Files  1 failed (1)\n      Tests  no tests\n',
        }),
      ).toEqual({ kind: 'failed' });
    });

    it('names the specific reason before any error line', () => {
      expect(
        rerunOutcome({
          status: 1,
          output:
            'Error: something a dependency logged\n NX  Schema does not support positional arguments.\n',
        }).reason,
      ).toBe('NX  Schema does not support positional arguments.');
    });
  });

  it('unsafeFiles: options, absolute paths and .. segments are never handed to a command', () => {
    expect(
      unsafeFiles([
        'src/a.test.ts',
        '--config=x',
        '-t',
        '/etc/passwd',
        'src/../../x.test.ts',
        'src/a..b.test.ts',
      ]),
    ).toEqual(['--config=x', '-t', '/etc/passwd', 'src/../../x.test.ts']);
  });

  describe('triageMessage', () => {
    const files = ['editor/a.spec.ts'];

    it('says what the re-run means, both ways', () => {
      expect(
        triageMessage({
          files,
          outcomes: [{ project: 'editor', kind: 'passed' }],
        }),
      ).toMatch(/not a break/);
      expect(
        triageMessage({
          files,
          outcomes: [{ project: 'editor', kind: 'failed' }],
        }),
      ).toMatch(/a real break/);
    });

    it('a re-run that ran no test is its own message, with its reason, never a real break', () => {
      const message = triageMessage({
        files,
        outcomes: [
          { project: 'api', kind: 'passed' },
          {
            project: 'editor',
            kind: 'no-tests',
            reason: 'Schema does not support positional arguments',
          },
        ],
      });
      expect(message).not.toMatch(/real break/);
      expect(message).not.toMatch(/not a break/);
      expect(message).toMatch(/editor/);
      expect(message).toMatch(/ran no test/);
      expect(message).toMatch(/Schema does not support positional arguments/);
    });

    it('a re-run that failed on its tests still is a real break, whatever the others did', () => {
      expect(
        triageMessage({
          files,
          outcomes: [
            { project: 'api', kind: 'failed' },
            { project: 'editor', kind: 'no-tests', reason: 'x' },
          ],
        }),
      ).toMatch(/a real break/);
    });
  });
});
