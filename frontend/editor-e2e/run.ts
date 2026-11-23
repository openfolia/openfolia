// `pnpm nx run editor-e2e:e2e`: runs the suite (README.md). Every flow, unless
// CCMS_E2E_SELECT=affected (`pnpm check:changed`, `scripts/check.mjs`): then only the spec files
// the change since CCMS_E2E_BASE (default: main) needs (`tools/select.ts`), up to CCMS_E2E_HEAD
// (default: the working tree, uncommitted and untracked files included, as `nx affected`).
// Arguments after `--` go to `playwright test`.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISOLATED_SPECS } from './isolated.ts';
import { selectSpecs } from './tools/select.ts';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function changedFiles(base: string, head: string | undefined): string[] {
  const from = git('merge-base', base, head ?? 'HEAD');
  const files = head
    ? git('diff', '--name-only', from, head)
    : [
        git('diff', '--name-only', from),
        git('ls-files', '--others', '--exclude-standard'),
      ].join('\n');
  return files.split('\n').filter(Boolean);
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
let files: string[] = [];
if (process.env['CCMS_E2E_SELECT'] === 'affected') {
  const base = process.env['CCMS_E2E_BASE'] || 'main';
  const head = process.env['CCMS_E2E_HEAD'] || undefined;
  const specDir = join(here, 'specs');
  const specs = Object.fromEntries(
    readdirSync(specDir)
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => [name, readFileSync(join(specDir, name), 'utf8')]),
  );
  const selected = selectSpecs(changedFiles(base, head), specs);
  if (selected.length === 0) {
    console.log(
      `editor-e2e: no flow covers what changed since ${base}; nothing to run.`,
    );
    process.exit(0);
  }
  if (selected.length < Object.keys(specs).length) {
    console.log(
      `editor-e2e: the flows the change since ${base} touches: ${selected.join(', ')}`,
    );
    files = selected.map((name) => `specs/${name}`);
  }
}

const cli = join(here, 'node_modules', '@playwright', 'test', 'cli.js');
const playwright = (extra: string[]): number => {
  const { status, error } = spawnSync(
    process.execPath,
    [cli, 'test', ...extra, ...args],
    { cwd: here, stdio: 'inherit' },
  );
  if (error) throw error;
  return status ?? 1;
};

// The isolated flows (`ISOLATED_SPECS`, `playwright.config.ts`) run after every other flow, as
// the `isolated` project depends on `desktop` and `narrow`. Playwright runs a dependency's tests
// whatever files were named, so a selection that holds an isolated flow would run every flow:
// such a selection runs in two passes instead, the others first, then the isolated ones alone.
const isolated = files.filter((f) => ISOLATED_SPECS.test(f));
if (isolated.length === 0 || isolated.length === files.length) {
  process.exit(
    playwright(
      isolated.length > 0
        ? [...files, '--project=isolated', '--no-deps']
        : files,
    ),
  );
}
const others = playwright(files.filter((f) => !ISOLATED_SPECS.test(f)));
const alone = playwright([...isolated, '--project=isolated', '--no-deps']);
process.exit(others || alone);
