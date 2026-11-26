#!/usr/bin/env node
// `node <a checkout of the kit's repository>/scripts/kit/install.mjs <repository>`: installs the
// agent kit (scripts/kit/README.md) into another repository, or updates it there:
// - copies the kit's files (scripts/kit/files.mjs, KIT_FILES) over the repository's copies;
// - writes kit.config.json with every default when the repository has none (never overwrites
//   it: it is the repository's own);
// - merges the guard's hooks and the kit's permissions into .claude/settings.json (a hook the
//   repository already registers, by its command, is not added twice; the rest stays);
// - adds the kit's package.json scripts the repository lacks, and names those it has with
//   another command (left as they are);
// - adds the .gitignore lines the kit's local state needs;
// - writes a starter docs/agent-rules.md when there is none.
// Idempotent: a second run changes nothing but files the kit itself changed.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  KIT_CONFIG_FILE,
  KIT_DEFAULTS,
} from '../../.claude/hooks/kit-config.mjs';
import {
  KIT_FILES,
  KIT_IGNORES,
  KIT_PACKAGE_SCRIPTS,
  KIT_SETTINGS,
} from './files.mjs';

/** The kit's own repository: where its files are copied from. */
const SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const AGENT_RULES = `# Rules for parallel build agents

The kit's rules (slots, the guard, the review loop, merging) are in
[scripts/kit/README.md](../scripts/kit/README.md), "The agent rules". This file holds this
project's own; the kit's skills and \`build-agent\` read it.

## How to work

<!-- The project's own conventions: its architecture, its tests, how to start its server on
     the slot's PORT. -->

## Security-sensitive areas

<!-- The areas whose changes get the deepest review (the factory runs them on its strongest
     model): authentication and tokens, permissions, … -->

## Project checks

<!-- The project's own items for the verify-before-done checklist. -->
`;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * The repository's settings with the kit's merged in: each kit hook group whose commands the
 * repository doesn't register yet, and the permissions it lacks.
 */
export function mergedSettings(own, kit) {
  const out = structuredClone(own);
  const commands = (groups) =>
    new Set(
      (groups ?? []).flatMap((group) =>
        (group.hooks ?? []).map((hook) => hook.command),
      ),
    );
  for (const [event, groups] of Object.entries(kit.hooks ?? {})) {
    out.hooks ??= {};
    const have = commands(out.hooks[event]);
    const missing = groups.filter((group) =>
      group.hooks.some((hook) => !have.has(hook.command)),
    );
    if (missing.length > 0)
      out.hooks[event] = [...(out.hooks[event] ?? []), ...missing];
  }
  for (const kind of ['allow', 'deny']) {
    const want = kit.permissions?.[kind] ?? [];
    if (want.length === 0) continue;
    out.permissions ??= {};
    const have = out.permissions[kind] ?? [];
    out.permissions[kind] = [
      ...have,
      ...want.filter((rule) => !have.includes(rule)),
    ];
  }
  if (!out.$schema && kit.$schema) out.$schema = kit.$schema;
  return out;
}

/** The package.json scripts with the kit's added; `clashes`: the kit's names it has otherwise. */
export function mergedScripts(scripts = {}) {
  const out = { ...scripts };
  const clashes = [];
  for (const [name, command] of Object.entries(KIT_PACKAGE_SCRIPTS)) {
    if (out[name] === undefined) out[name] = command;
    else if (out[name] !== command) clashes.push(name);
  }
  return { scripts: out, clashes };
}

/** .gitignore's text with the kit's lines it lacks added at the end. */
export function mergedIgnores(text = '') {
  const have = new Set(text.split('\n').map((line) => line.trim()));
  const missing = KIT_IGNORES.filter((line) => !have.has(line));
  if (missing.length === 0) return text;
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${base ? '\n' : ''}# Agent kit (local state, never committed)\n${missing.join('\n')}\n`;
}

/** Installs the kit into `target` (a repository's root); returns the lines to print. */
export function install(target, source = SOURCE) {
  const root = path.resolve(target);
  if (!existsSync(path.join(root, 'package.json')))
    throw new Error(
      `${root} has no package.json: install into a repository's root.`,
    );
  if (root === source) throw new Error('The kit is this repository already.');
  const log = [];
  for (const file of KIT_FILES) {
    const from = path.join(source, file);
    const to = path.join(root, file);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: statSync(from).isDirectory(), force: true });
  }
  log.push(`Copied the kit's files (${KIT_FILES.length} entries).`);

  const config = path.join(root, KIT_CONFIG_FILE);
  if (existsSync(config))
    log.push(`${KIT_CONFIG_FILE}: kept (the repository's own).`);
  else {
    writeJson(config, KIT_DEFAULTS);
    log.push(`${KIT_CONFIG_FILE}: written with the defaults; fill it in.`);
  }

  const settingsFile = path.join(root, KIT_SETTINGS);
  const kitSettings = readJson(path.join(source, KIT_SETTINGS));
  const own = existsSync(settingsFile) ? readJson(settingsFile) : {};
  writeJson(settingsFile, mergedSettings(own, kitSettings));
  log.push(
    `${KIT_SETTINGS}: the guard's hooks and the kit's permissions merged in.`,
  );

  const pkgFile = path.join(root, 'package.json');
  const pkg = readJson(pkgFile);
  const { scripts, clashes } = mergedScripts(pkg.scripts);
  writeJson(pkgFile, { ...pkg, scripts });
  if (clashes.length > 0) {
    log.push(
      `package.json: kept your own ${clashes.join(', ')}; the kit's commands are in scripts/kit/files.mjs.`,
    );
  }

  const ignoreFile = path.join(root, '.gitignore');
  const ignores = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, 'utf8')
    : '';
  writeFileSync(ignoreFile, mergedIgnores(ignores));

  const rules = path.join(root, 'docs', 'agent-rules.md');
  if (!existsSync(rules)) {
    mkdirSync(path.dirname(rules), { recursive: true });
    writeFileSync(rules, AGENT_RULES);
    log.push(
      "docs/agent-rules.md: a starter written; fill in the project's own rules.",
    );
  }
  log.push(
    'Next: fill in kit.config.json, commit, then pnpm slot create <name>.',
  );
  return log;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [target, ...rest] = process.argv.slice(2);
  if (!target || rest.length > 0) {
    console.error('Usage: node scripts/kit/install.mjs <repository root>');
    process.exit(2);
  }
  try {
    for (const line of install(target)) console.log(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
