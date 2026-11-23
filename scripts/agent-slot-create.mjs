// `node scripts/agent-slot.mjs create <name>` (the flow its header describes): checks the
// branch and base, takes the registry lock once for the name, the PORT, the slot's record and
// the worktree add (every .git/config write), then installs dependencies, makes the worktree's
// own local settings and prints the slot's brief. One sequence whose steps share the state its
// checks found (branch, base, port); what can be pure lives in agent-slot-plan.mjs.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';

import { slotBrief } from './agent-slot-brief.mjs';
import { writeSlotPort } from './agent-slot-files.mjs';
import {
  installDependencies,
  listening,
  refExists,
  run,
  setupLocal,
} from './agent-slot-io.mjs';
import {
  machineLoadWarnings,
  optionValue,
  pickPort,
  remoteBranch,
  resolveBase,
  slotPaths,
  worktreeAddArgs,
} from './agent-slot-plan.mjs';
import { withRegistryLock } from './registry-lock.mjs';
import { runGit } from './run-git.mjs';
import { readSlots, serializeSlot } from './slot-file.mjs';

/** The steps after the worktree exists; a test passes fakes for them. */
export const REAL_STEPS = { install: installDependencies, setup: setupLocal };

/**
 * A create that reserved its PORT (slot.json with `creating: <pid>`) and died before its
 * worktree existed: the pid is gone and there is no worktree. It no longer counts, and a new
 * create of the same name replaces it. A live create, or one whose worktree exists, counts.
 */
function staleReservation(slot) {
  if (typeof slot.creating !== 'number' || existsSync(slot.worktree))
    return false;
  try {
    process.kill(slot.creating, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/** Whole or not at all: a concurrent create reads every slot.json under the lock. */
function writeRecord(file, slot) {
  writeFileSync(`${file}.tmp`, serializeSlot(slot));
  renameSync(`${file}.tmp`, file);
}

/** Prints machineLoadWarnings: a warning, never a refusal. */
function warnIfLoaded() {
  const warnings = machineLoadWarnings({
    load1: os.loadavg()[0],
    cores: os.cpus().length,
  });
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
}

/**
 * Creates the slot `name`; `rest`: the command's other arguments (--base, --branch, --offline);
 * `steps`: the install and setup steps, a test's fakes included.
 */
export function create(
  root,
  name,
  rest,
  steps = REAL_STEPS,
  env = process.env,
) {
  const paths = slotPaths(root, name);
  if (existsSync(paths.worktree))
    throw new Error(`${paths.worktree} already exists.`);
  if (existsSync(paths.stackDir)) {
    const file = existsSync(paths.slotFile)
      ? JSON.parse(readFileSync(paths.slotFile, 'utf8'))
      : null;
    if (!file || !staleReservation(file))
      throw new Error(`${paths.stackDir} already exists.`);
  }
  const branch = optionValue(rest, '--branch') || paths.branch;
  const { ref: base, source: baseSource } = resolveBase(rest, env);
  warnIfLoaded();

  // Offline (--offline, or a clone without an origin remote): GitHub is never asked; the slot
  // starts from the local branch or the local base.
  const noOrigin =
    runGit(['-C', root, 'remote', 'get-url', 'origin'], { stdio: 'ignore' })
      .status !== 0;
  const offline = rest.includes('--offline') || noOrigin;
  if (noOrigin && !rest.includes('--offline'))
    console.log('No origin remote: working offline.');
  if (!offline && base.includes('/')) {
    const [remote, ...ref] = base.split('/');
    runGit(['-C', root, 'fetch', remote, ref.join('/')], { stdio: 'ignore' });
  }
  const local = refExists(root, `refs/heads/${branch}`);
  // No local branch: GitHub may still have it (the slot was removed, or made elsewhere). Asked
  // live, so a stale refs/remotes/origin/<branch> of a deleted branch never counts.
  const lsRemote =
    local || offline
      ? null
      : runGit(['-C', root, 'ls-remote', '--heads', 'origin', branch], {
          encoding: 'utf8',
        });
  const remote = remoteBranch({ branch, local, lsRemote, offline });
  if (remote) {
    run('git', [
      '-C',
      root,
      'fetch',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  }
  // Before any worktree or reservation: a base that isn't here (a typo, a deleted sprint
  // branch) stops it, unless an existing branch makes the slot without it.
  if (!refExists(root, base) && !(local || remote)) {
    throw new Error(
      `The base ${base} (${{ arg: 'from --base', env: 'from BASE_BRANCH', default: 'the default' }[baseSource]}) is not here: fetch it, or pass --base <ref>.`,
    );
  }

  // One registry lock for everything a concurrent create must see whole: the name, the PORT,
  // the slot's record and the worktree add (git takes .git/config's lock without waiting, so two
  // writers at once fail with "could not lock config file"). A clash at any step leaves nothing
  // behind. The record carries `creating` (this pid) until the worktree exists, so a create that
  // dies after the lock leaves a reservation the next create can tell is stale.
  const slot = withRegistryLock(root, () => {
    // Checked again under the lock: a same-name create that got here first owns the name.
    if (existsSync(paths.worktree))
      throw new Error(`${paths.worktree} already exists.`);
    if (existsSync(paths.slotFile)) {
      if (!staleReservation(JSON.parse(readFileSync(paths.slotFile, 'utf8')))) {
        throw new Error(`${paths.stackDir} already exists.`);
      }
      rmSync(paths.stackDir, { recursive: true, force: true });
    }
    const others = readSlots(root).filter((other) => !staleReservation(other));
    const port = pickPort(
      others.map((other) => other.port),
      listening,
    );
    const record = {
      name,
      branch,
      base,
      worktree: paths.worktree,
      port,
      created: new Date().toISOString(),
    };
    try {
      mkdirSync(paths.stackDir, { recursive: true });
      writeRecord(paths.slotFile, { ...record, creating: process.pid });
      run(
        'git',
        [
          '-C',
          root,
          'worktree',
          'add',
          ...worktreeAddArgs({
            worktree: paths.worktree,
            branch,
            base,
            local,
            remote,
          }),
        ],
        { stdio: 'inherit' },
      );
    } catch (error) {
      rmSync(paths.stackDir, { recursive: true, force: true }); // release the reservation
      throw error;
    }
    writeRecord(paths.slotFile, record);
    return record;
  });

  // The slot is made either way: a failing step says how to remove it.
  try {
    console.log('Installing dependencies …');
    steps.install(paths.worktree);
    steps.setup(paths.worktree);
    writeSlotPort(paths.worktree, slot.port);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nThe slot is created, though not ready: node scripts/agent-slot.mjs remove ${name} --force`,
      { cause: error },
    );
  }

  console.log(`\nSlot "${name}" is ready.`);
  console.log(`  worktree  ${paths.worktree} (branch ${branch}, from ${base})`);
  console.log(`  PORT      ${slot.port} (${paths.worktree}/.env.local)`);
  console.log(`\nWhen done: node scripts/agent-slot.mjs remove ${name}\n`);
  for (const line of slotBrief(slot)) console.log(line);
  return slot;
}
