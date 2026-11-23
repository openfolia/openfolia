// Writes the generated history into a bare repository with `git fast-import`: thousands of
// commits in seconds, without a working tree. Commits carry fixed, invented identities and
// dates, so the same profile gives the same commit IDs.

import { execFileSync, spawn } from 'node:child_process';

/** Git without the user's or the system's configuration, so nothing local changes the result. */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function initBare(dir) {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir], {
    env: GIT_ENV,
  });
}

/** Invented authors: `Writer 01 <writer01@example.com>` and so on. */
export function author(index) {
  const n = String((index % 12) + 1).padStart(2, '0');
  return { name: `Writer ${n}`, email: `writer${n}@example.com` };
}

/**
 * One `git fast-import` run appending commits to `branch`. `start` names the commit the first
 * one follows (none for a new repository). Resolves to the branch's new head.
 */
export async function importCommits(dir, branch, start, commits) {
  const child = spawn('git', ['-C', dir, 'fast-import', '--quiet', '--done'], {
    env: GIT_ENV,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git fast-import exited with ${code}`)),
    );
  });
  const write = (chunk) =>
    child.stdin.write(chunk)
      ? undefined
      : new Promise((r) => child.stdin.once('drain', r));
  let first = true;
  for (const commit of commits) {
    const who = commit.author;
    const date = `${commit.time} +0000`;
    const message = Buffer.from(`${commit.message}\n`);
    await write(`commit refs/heads/${branch}\n`);
    await write(`author ${who.name} <${who.email}> ${date}\n`);
    await write(`committer ${who.name} <${who.email}> ${date}\n`);
    await write(`data ${message.length}\n`);
    await write(message);
    if (first && start) await write(`from ${start}\n`);
    first = false;
    for (const change of commit.changes) {
      if (change.delete) {
        await write(`D ${change.path}\n`);
        continue;
      }
      const bytes = Buffer.isBuffer(change.content)
        ? change.content
        : Buffer.from(change.content);
      await write(`M 100644 inline ${change.path}\n`);
      await write(`data ${bytes.length}\n`);
      await write(bytes);
      await write('\n');
    }
    await write('\n');
  }
  await write('done\n');
  child.stdin.end();
  await exited;
  return git(dir, 'rev-parse', `refs/heads/${branch}`);
}
