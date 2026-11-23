import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStagingRoot, stageRun } from './staging.js';

describe('the staging folder', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staging-spec-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('takes a private folder of this user, outside the backup volume', async () => {
    const root = join(dir, 'staging');
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    expect(await openStagingRoot(root, join(dir, 'backups'))).toBe(root);
  });

  it('refuses a symlink, a folder others can enter, and one inside the backup volume', async () => {
    const real = join(dir, 'real');
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    await symlink(real, join(dir, 'link'));
    await expect(
      openStagingRoot(join(dir, 'link'), join(dir, 'backups')),
    ).rejects.toThrow(/symbolic link|not a folder/);

    const open = join(dir, 'open');
    await mkdir(open);
    await chmod(open, 0o755);
    await expect(openStagingRoot(open, join(dir, 'backups'))).rejects.toThrow(
      /0700/,
    );

    const volume = join(dir, 'backups');
    await mkdir(join(volume, 'staging'), { recursive: true, mode: 0o700 });
    await chmod(join(volume, 'staging'), 0o700);
    await expect(
      openStagingRoot(join(volume, 'staging'), volume),
    ).rejects.toThrow(/inside the backup volume/);
  });

  it('makes a private folder of its own for a run when none is configured, never a fixed name in the shared temporary folder', async () => {
    const a = await openStagingRoot(undefined, join(dir, 'backups'));
    const b = await openStagingRoot(undefined, join(dir, 'backups'));
    try {
      expect(a).not.toBe(b);
      expect((await stat(a)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('stages each run in a fresh private folder under the root', async () => {
    const root = join(dir, 'staging');
    await mkdir(root, { mode: 0o700 });
    const one = await stageRun(root, 'run-1');
    const two = await stageRun(root, 'run-1');
    expect(one).not.toBe(two);
    expect(one.startsWith(`${root}/`)).toBe(true);
    expect((await stat(one)).mode & 0o777).toBe(0o700);
  });
});

describe('clearing the staging folder', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staging-clear-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('removes only the folders runs and restores make, never anything else in the root or behind a link', async () => {
    const { clearStaging } = await import('./staging.js');
    const { writeFile } = await import('node:fs/promises');
    const root = join(dir, 'root');
    await mkdir(root, { mode: 0o700 });
    const run = await stageRun(root, 'run-1');
    await writeFile(join(run, 'database.dump'), 'dump');
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'precious'), 'keep');
    await symlink(elsewhere, join(root, 'run-planted'));
    await writeFile(join(root, 'notes.txt'), 'keep');
    await mkdir(join(root, 'other'));

    const removed = await clearStaging(root);
    expect(removed).toHaveLength(1);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).sort()).toEqual(
      ['notes.txt', 'other', 'run-planted'].sort(),
    );
    expect((await readdir(elsewhere)).sort()).toEqual(['precious']);
  });

  it('refuses a root that holds the backup volume or the data', async () => {
    const root = join(dir, 'srv');
    await mkdir(join(root, 'backups'), { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await expect(openStagingRoot(root, join(root, 'backups'))).rejects.toThrow(
      /holds/,
    );
    const data = join(dir, 'data');
    await mkdir(join(data, 'staging'), { recursive: true, mode: 0o700 });
    await chmod(join(data, 'staging'), 0o700);
    await expect(
      openStagingRoot(join(data, 'staging'), join(dir, 'backups'), [data]),
    ).rejects.toThrow(/inside/);
  });

  it('refuses a sibling whose name only starts with the volume’s ("/backups..staging" style)', async () => {
    const volume = join(dir, 'backups');
    await mkdir(volume, { mode: 0o700 });
    const sibling = join(dir, 'backups..staging');
    await mkdir(sibling, { mode: 0o700 });
    await chmod(sibling, 0o700);
    // Outside the volume, so taken; and a folder inside it with such a name is refused.
    expect(await openStagingRoot(sibling, volume)).toBe(sibling);
    const inner = join(volume, '..staging');
    await mkdir(inner, { mode: 0o700 });
    await chmod(inner, 0o700);
    await expect(openStagingRoot(inner, volume)).rejects.toThrow(/inside/);
  });
});
