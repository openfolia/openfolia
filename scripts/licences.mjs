// `pnpm licences` (`node scripts/licences.mjs check`, run by `pnpm check` as the workflow
// project's `licences` target): fails when a shipped dependency's licence is neither allowed
// nor a reviewed exception (`scripts/licence-policy.json`), or when `THIRD-PARTY-NOTICES.md` is
// out of date. `pnpm licences:notice` (`… write`) writes the notice again.
//
// Options (for the tests): `--report <file>` reads pnpm's licence report from a file instead of
// running `pnpm licenses list`, `--notice <file>` and `--policy <file>` use other files.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findViolations, packagesOf, renderNotice } from './licences-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bundled assets that are not npm packages. */
const FONTS = [
  {
    name: 'Geist, Geist Mono',
    licence: 'OFL-1.1',
    file: 'frontend/theme/src/fonts/LICENSE.txt',
  },
  {
    name: 'Noto Sans Arabic, Noto Sans Hebrew',
    licence: 'OFL-1.1',
    file: 'frontend/theme/src/fonts/LICENSE-Noto.txt',
  },
];

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`licences: ${name} needs a file`);
  }
  return path.resolve(value);
}

function pnpmReport() {
  const run = spawnSync(
    'pnpm',
    ['licenses', 'list', '--prod', '--json', '--recursive'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      `licences: pnpm licenses list failed (${run.status}): ${run.stderr.trim()}`,
    );
  }
  return JSON.parse(run.stdout);
}

/** Whether the package installed at `dir` is built for one platform. */
function isPlatformPackage(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  return Array.isArray(pkg.os) || Array.isArray(pkg.cpu);
}

export function main(argv) {
  const [mode, ...args] = argv;
  if (mode !== 'check' && mode !== 'write') {
    console.error('usage: node scripts/licences.mjs check|write');
    return 2;
  }
  const reportFile = option(args, '--report', null);
  const noticeFile = option(
    args,
    '--notice',
    path.join(ROOT, 'THIRD-PARTY-NOTICES.md'),
  );
  const policyFile = option(
    args,
    '--policy',
    path.join(ROOT, 'scripts/licence-policy.json'),
  );

  const report = reportFile
    ? JSON.parse(readFileSync(reportFile, 'utf8'))
    : pnpmReport();
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  const packages = packagesOf(report, isPlatformPackage);
  const notice = renderNotice(packages, { fonts: FONTS });

  const violations = findViolations(packages, policy);
  if (violations.length > 0) {
    console.error(
      'licences: these shipped dependencies have a licence that is not allowed with AGPL-3.0-only:',
    );
    for (const row of violations) {
      console.error(`  ${row.name}@${row.versions.join(', ')}: ${row.licence}`);
    }
    console.error(
      'Replace the dependency, or, once its licence is reviewed, add it to `exceptions` in scripts/licence-policy.json with the reason.',
    );
    return 1;
  }

  if (mode === 'write') {
    writeFileSync(noticeFile, notice);
    console.log(
      `licences: ${packages.length} packages, notice written to ${path.relative(ROOT, noticeFile)}`,
    );
    return 0;
  }
  const current = existsSync(noticeFile)
    ? readFileSync(noticeFile, 'utf8')
    : '';
  if (current !== notice) {
    console.error(
      `licences: ${path.relative(ROOT, noticeFile)} is out of date: run pnpm licences:notice and commit it.`,
    );
    return 1;
  }
  console.log(`licences: ${packages.length} packages, all allowed`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
