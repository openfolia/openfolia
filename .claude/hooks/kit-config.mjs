// The kit's one config file: `kit.config.json` at the repository root (scripts/kit/README.md,
// "The config file"). Everything project-specific the hooks and the scripts read comes from it;
// a key the file leaves out takes its default below, and a repository without the file runs on
// the defaults. Two readers:
// - readKitConfig (the scripts): a file that isn't valid stops them with what is wrong;
// - guardConfig (the guard hooks): such a file falls back to the defaults, so the guard keeps
//   every rule rather than failing to load.
// The file is found next to this one (<root>/.claude/hooks/ → <root>/kit.config.json), whatever
// the working directory, as pre-tool-use.mjs finds its repository.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The config file's name, at the repository root. */
export const KIT_CONFIG_FILE = 'kit.config.json';

/** The repository this file sits in. */
export const KIT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Every key with its default: the shape the file may have, and what a missing key means. */
export const KIT_DEFAULTS = Object.freeze({
  mainBranch: 'main',
  ownPort: 3100,
  check: [
    {
      targets: ['test', 'lint', 'typecheck', 'build'],
      output: 'static-failures-only',
    },
  ],
  slot: { setup: null, brief: [], bucketScript: null, databasesScript: null },
});

const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && v);
/** A path inside the repository, relative to its root. */
const isRelativePath = (value) =>
  typeof value === 'string' &&
  value !== '' &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes('..');

/** The problems with `config` (merged with the defaults), as lines; empty when it is valid. */
function problems(config) {
  const out = [];
  const need = (ok, key, what) => {
    if (!ok) out.push(`${key} must be ${what}`);
  };
  need(
    typeof config.mainBranch === 'string' &&
      BRANCH.test(config.mainBranch) &&
      !/\.\.|\/\.|\/$|\.lock$/.test(config.mainBranch),
    'mainBranch',
    'a branch name',
  );
  need(
    Number.isInteger(config.ownPort) &&
      config.ownPort > 0 &&
      config.ownPort + 100 <= 65535,
    'ownPort',
    'a port (slots take the 100 after it)',
  );
  need(
    Array.isArray(config.check) &&
      config.check.length > 0 &&
      config.check.every(
        (run) =>
          isObject(run) &&
          isStrings(run.targets) &&
          run.targets.length > 0 &&
          (run.output === undefined || typeof run.output === 'string') &&
          (run.affectedEnv === undefined || ENV_NAME.test(run.affectedEnv)),
      ),
    'check',
    'a list of runs, each { targets: [...], output?, affectedEnv? }',
  );
  const { slot } = config;
  need(
    slot.setup === null || (isStrings(slot.setup) && slot.setup.length > 0),
    'slot.setup',
    'null or a command as a list of words',
  );
  need(isStrings(slot.brief), 'slot.brief', 'a list of lines');
  for (const key of ['bucketScript', 'databasesScript']) {
    need(
      slot[key] === null || isRelativePath(slot[key]),
      `slot.${key}`,
      'null or a path in the repository',
    );
  }
  return out;
}

/**
 * The file's settings over the defaults: a section (`slot`, `board`, …) takes the keys the file
 * gives and keeps the others; a value inside it (a list, an option map) replaces the default.
 */
function merged(defaults, own) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(own)) {
    out[key] =
      isObject(defaults[key]) && isObject(value)
        ? { ...defaults[key], ...value }
        : value;
  }
  return out;
}

/**
 * The config from the file's text (`null`: no file), merged with the defaults; throws with what
 * is wrong when it isn't valid (not JSON, a key the kit doesn't know, a value of the wrong
 * shape).
 */
export function parseKitConfig(text) {
  if (text === null) return structuredClone(KIT_DEFAULTS);
  let own;
  try {
    own = JSON.parse(text);
  } catch (error) {
    throw new Error(`${KIT_CONFIG_FILE}: not JSON (${error.message}).`);
  }
  if (!isObject(own)) throw new Error(`${KIT_CONFIG_FILE}: not an object.`);
  const unknown = Object.keys(own).filter((key) => !(key in KIT_DEFAULTS));
  for (const [section, value] of Object.entries(own)) {
    if (isObject(KIT_DEFAULTS[section]) && !isObject(value))
      throw new Error(`${KIT_CONFIG_FILE}: ${section} must be an object.`);
    if (isObject(KIT_DEFAULTS[section])) {
      for (const key of Object.keys(value))
        if (!(key in KIT_DEFAULTS[section])) unknown.push(`${section}.${key}`);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `${KIT_CONFIG_FILE}: unknown key(s) ${unknown.join(', ')} (scripts/kit/README.md lists them).`,
    );
  }
  const config = merged(structuredClone(KIT_DEFAULTS), own);
  const wrong = problems(config);
  if (wrong.length > 0)
    throw new Error(`${KIT_CONFIG_FILE}: ${wrong.join('; ')}.`);
  return config;
}

/** The config of the repository at `root` (default: this one); throws when it isn't valid. */
export function readKitConfig(root = KIT_ROOT) {
  let text = null;
  try {
    text = readFileSync(path.join(root, KIT_CONFIG_FILE), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return parseKitConfig(text);
}

/** The guard's config: this repository's, or the defaults when the file can't be read. */
export function guardConfig(root = KIT_ROOT) {
  try {
    return readKitConfig(root);
  } catch {
    return structuredClone(KIT_DEFAULTS);
  }
}

/** `text` as a regular expression that matches it literally. */
export function literalPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
