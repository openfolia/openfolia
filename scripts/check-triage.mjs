// Reading a failed Nx check (`pnpm check:changed` / `pnpm check`) after a merge, as a plain
// function a test can pin (scripts/sync-main.mjs runs it): when only `test` tasks failed and
// every failure in them was a test or hook that ran out of time, those files are re-run on their
// own once, per project, before anyone calls it a real break. A loaded machine (several slots'
// suites at once) times tests out; a real break fails the same way on a quiet re-run.

import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const TIMEOUT = /\b(Test|Hook) timed out in \d+ms/;
/** The line Nx prints before a task's output (`> nx run <project>:<target>`). */
const TASK = /^\s*>\s+nx run ([^\s:]+):(\S+)/;
/** A task in Nx's closing list of failed ones (`- <project>:<target>`). */
const FAILED_TASK = /^\s*-\s+([^\s:]+):(\S+)\s*$/;
/** Nx's closing summary: `NX   Ran targets …` or `NX   Running targets … failed`. */
const SUMMARY = /\bNX\b.*\b(Ran|Running) targets?\b/;
/**
 * A vitest failure: `FAIL  [<project label> ]<file>[ > <test>]`. The label is `|name|`, or,
 * with colours (stripped here), a bare `name` before the file and its ` > `.
 */
const FAIL = /^\s*FAIL\s+(?:\|[^|]+\|\s+|\S+\s+(?=\S+\s+>\s))?(\S+)(.*)$/;

/**
 * The failed tasks Nx lists after its closing summary (line `summaryAt`): the first run of
 * `- <project>:<target>` lines after it, blank lines allowed between them. Only that run: a
 * task still writing when Nx printed the summary goes on after it, and its lines are no tasks.
 */
function failedTasksAfter(lines, summaryAt) {
  const tasks = [];
  for (const line of lines.slice(summaryAt + 1)) {
    const task = FAILED_TASK.exec(line);
    if (task) tasks.push({ project: task[1], target: task[2] });
    else if (tasks.length > 0 && line.trim() !== '') break;
  }
  return tasks;
}

/**
 * The test files to re-run, per Nx project, when `output` (the whole Nx run's output) failed
 * only in `test` tasks and only on timed-out tests: `{ runs: [{ project, files }] }`, or null
 * when anything else failed (another target, an assertion, a file that didn't load, a failed
 * test task with no timed-out file, or nothing to read). A task's output is read wherever it
 * is, after Nx's closing summary too: a streamed task can still be writing when Nx prints it
 * (as a loaded run has shown), so its FAIL blocks and vitest's count may follow the summary.
 */
export function timeoutOnlyFailures(output) {
  const text = stripVTControlCharacters(String(output ?? ''));
  const lines = text.split('\n');
  const summaryAt = lines.findLastIndex((line) => SUMMARY.test(line));
  if (summaryAt === -1) return null;
  const failedTasks = failedTasksAfter(lines, summaryAt);
  if (
    failedTasks.length === 0 ||
    failedTasks.some(({ target }) => target !== 'test')
  ) {
    return null;
  }
  const byProject = new Map();
  let project = null;
  // After the summary, lines still belong to the task whose header came last: the one writing.
  for (let i = 0; i < lines.length; i++) {
    const task = TASK.exec(lines[i]);
    if (task) {
      project = task[2] === 'test' ? task[1] : null;
      continue;
    }
    const fail = FAIL.exec(lines[i]);
    if (!fail) continue;
    // A FAIL outside a test task, or without a test name (a file that didn't load): not a timeout.
    if (!project || !/^\s+>\s+\S/.test(fail[2])) return null;
    let j = i + 1;
    while (
      j < lines.length &&
      j !== summaryAt &&
      !FAIL.test(lines[j]) &&
      !TASK.test(lines[j]) &&
      !/⎯{3,}/.test(lines[j])
    ) {
      j++;
    }
    if (!lines.slice(i + 1, j).some((line) => TIMEOUT.test(line))) return null;
    if (!byProject.has(project)) byProject.set(project, new Set());
    byProject.get(project).add(fail[1]);
  }
  // Every failed test task needs its timed-out files: one with none failed some other way.
  if (failedTasks.some(({ project: name }) => !byProject.has(name)))
    return null;
  return {
    runs: [...byProject]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => ({ project: name, files: [...files].sort() })),
  };
}

/** Test executors that take files as `--include=<glob>` options, never as positional arguments. */
const INCLUDE_EXECUTORS = new Set([
  '@angular/build:unit-test',
  '@angular-devkit/build-angular:unit-test',
]);

/**
 * What a re-run needs from a project's configuration (`nx show project <name> --json`): its
 * `test` target's executor and the directory its file paths are relative to (the Angular
 * builder's: the source root; any other: the target's `cwd`; both default to the project root).
 */
export function testTarget(config) {
  const root = String(config?.root ?? '');
  const test = config?.targets?.test ?? {};
  const executor = String(test.executor ?? '');
  const base = INCLUDE_EXECUTORS.has(executor)
    ? (config?.sourceRoot ?? root)
    : (test.options?.cwd ?? root);
  return { executor, base: String(base).replace(/\/+$/, '') };
}

/** `file` relative to `base` when it is written from the workspace root, else as it is. */
function relativeTo(base, file) {
  return base && file.startsWith(`${base}/`)
    ? file.slice(base.length + 1)
    : file;
}

/**
 * The command that re-runs one project's timed-out files on their own, without Nx's cache, in
 * the form its test target (`testTarget`) takes them: `--include=<file>` each for the Angular
 * unit-test builder (which refuses positional arguments), positional after `--` for Vitest and
 * anything else. `--output-style=static` keeps the test summary in the output `rerunOutcome`
 * reads (without a style Nx picks `summary` when not on a terminal).
 */
export function rerunArgs({ project, files }, { executor, base }) {
  const head = [
    'nx',
    'run',
    `${project}:test`,
    '--skip-nx-cache',
    '--output-style=static',
  ];
  const paths = files.map((file) => relativeTo(base, file));
  return INCLUDE_EXECUTORS.has(executor)
    ? [...head, ...paths.map((file) => `--include=${file}`)]
    : [...head, '--', ...paths];
}

/** How long one project's re-run may take before it is stopped (a hung test, a stuck Nx). */
export const RERUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Vitest's closing count (`Tests  23 passed (23)`): the re-run ran tests. */
const TEST_SUMMARY = /^\s*Tests\s+.*\b\d+\s+(passed|failed|skipped|todo)\b/m;
/** In that count: at least one test passed. */
const PASSED = /^\s*Tests\s+.*\b[1-9]\d*\s+passed\b/m;
/** Vitest's count of files: one failed (a file that did not load on its own is a break too). */
const FILES_FAILED = /^\s*Test Files\s+.*\b[1-9]\d*\s+failed\b/m;
/** Why a run ran no test, when its output says so: the specific reasons first, then any error. */
const NO_TESTS = [
  /Schema does not support/,
  /No tests? (files )?found/,
  /Cannot find (configuration|project)/,
  /\bError\b/,
];

/**
 * What one re-run showed, from its exit status, its output and whether it was stopped
 * (`signal`: the signal that ended it; `timedOut`: stopped after `RERUN_TIMEOUT_MS`):
 * `{ kind: 'passed' }` when it exited 0 with tests passed, `{ kind: 'failed' }` when it ran
 * tests and exited non-zero, else `{ kind: 'no-tests', reason }` (stopped, a schema error, no
 * test found, every test skipped, …), which says nothing about the tests either way.
 */
export function rerunOutcome({ status, output, signal, timedOut }) {
  if (timedOut) {
    return {
      kind: 'no-tests',
      reason: `it did not finish within ${RERUN_TIMEOUT_MS / 60000} minutes and was stopped`,
    };
  }
  if (signal)
    return { kind: 'no-tests', reason: `it was stopped by ${signal}` };
  const text = stripVTControlCharacters(String(output ?? ''));
  if (status !== 0 && FILES_FAILED.test(text)) return { kind: 'failed' };
  if (TEST_SUMMARY.test(text)) {
    if (status !== 0) return { kind: 'failed' };
    if (PASSED.test(text)) return { kind: 'passed' };
    return { kind: 'no-tests', reason: 'no test passed (all skipped)' };
  }
  const lines = text.split('\n').map((l) => l.trim());
  const line = NO_TESTS.map((reason) => lines.find((l) => reason.test(l))).find(
    Boolean,
  );
  return { kind: 'no-tests', reason: line || 'its output has no test summary' };
}

/**
 * The files parsed from a check's output that are not handed to a command: one that would read
 * as an option (`-…`), an absolute path, or one with a `..` segment.
 */
export function unsafeFiles(files) {
  return files.filter(
    (file) =>
      file.startsWith('-') ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).includes('..'),
  );
}

/**
 * What to say once the timed-out files ran again on their own. `outcomes`: one per project
 * re-run, `{ project, kind, reason? }` (`rerunOutcome`'s, or `no-tests` when the re-run could
 * not start). A re-run that failed on its tests is a real break; one that ran no test proves
 * nothing and is reported with its reason; only when every one passed is it a loaded machine.
 */
export function triageMessage({ files, outcomes }) {
  const list = files.join(', ');
  if (outcomes.some(({ kind }) => kind === 'failed')) {
    return `The check failed on tests that timed out (${list}), and run again on their own they failed again: a real break. Fix it now, naming the two changes that collided.`;
  }
  const noTests = outcomes.filter(({ kind }) => kind !== 'passed');
  if (noTests.length > 0) {
    const why = noTests
      .map(({ project, reason }) => `${project}: ${reason}`)
      .join('; ');
    return `The check failed only on tests that timed out (${list}), but the re-run ran no test (${why}), so it says nothing about them: the re-run failed, not the tests. Run those files on their own by hand before calling it a break or a loaded machine.`;
  }
  return `The check failed only on tests that timed out (${list}); run again on their own they passed: a loaded machine, not a break. Both runs are above.`;
}
