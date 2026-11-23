#!/usr/bin/env node
// PostToolUse hook on Edit/Write (.claude/settings.json): runs Prettier on the file just
// edited, and only that file, so the lint and format checks stay green. Files
// Prettier doesn't know or .prettierignore lists are left alone (--ignore-unknown). It never
// blocks: any failure (no Prettier installed, a syntax error mid-edit) exits 0 silently.
//
// It only ever runs the project's own Prettier (<project>/node_modules/.bin/prettier) with the
// project's own config, and only on a file that really sits inside the project (symlinks
// resolved): an edited file elsewhere, e.g. in a downloaded folder with a planted
// node_modules/.bin/prettier, never gets a binary of its choosing run without a prompt.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG_FILES = [
  '.prettierrc.json',
  '.prettierrc',
  '.prettierrc.mjs',
  'prettier.config.mjs',
];

/** The edited file's path for this hook input (Edit/Write/MultiEdit), or null. */
export function editedFile(input) {
  if (!['Edit', 'Write', 'MultiEdit'].includes(input?.tool_name)) return null;
  const file = input?.tool_input?.file_path;
  if (typeof file !== 'string' || !file) return null;
  return path.resolve(input.cwd || process.cwd(), file);
}

/**
 * What to run for this input: `{ bin, args, cwd }`, or null to do nothing. `projectDir` is the
 * session's project (CLAUDE_PROJECT_DIR: the main checkout, or a worktree with its own
 * node_modules). `fs` is injectable for tests.
 */
export function prettierPlan(
  input,
  projectDir,
  fs = { realpath: realpathSync, exists: existsSync },
) {
  const edited = editedFile(input);
  if (!edited || !projectDir) return null;
  let root;
  let file;
  try {
    root = fs.realpath(projectDir);
    file = fs.realpath(edited);
  } catch {
    return null;
  }
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).includes('node_modules')) return null;
  const bin = path.join(root, 'node_modules', '.bin', 'prettier');
  if (!fs.exists(bin)) return null;
  const config = CONFIG_FILES.map((name) => path.join(root, name)).find((f) =>
    fs.exists(f),
  );
  const args = ['--write', '--ignore-unknown', '--log-level', 'silent'];
  if (config) args.push('--config', config);
  args.push(file);
  return { bin, args, cwd: root };
}

/** The session's project: CLAUDE_PROJECT_DIR, else the repository this hook lives in. */
function projectDir() {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const plan = prettierPlan(JSON.parse(raw), projectDir());
    if (plan)
      spawnSync(plan.bin, plan.args, {
        cwd: plan.cwd,
        stdio: 'ignore',
        timeout: 20000,
      });
  } catch {
    // Never block or complain: formatting is a convenience, check catches the rest.
  }
  process.exit(0);
}
