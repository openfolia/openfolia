import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupStepError } from '../core/backup-ports.js';
import { LocalBackupTarget, resolveInside } from './backup-targets.js';

describe('the local backup location', () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'backup-volume-'));
    outside = await mkdtemp(join(tmpdir(), 'elsewhere-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('makes the subfolder inside the volume', async () => {
    const dir = await resolveInside(root, 'nightly/eu-1');
    expect(dir.endsWith(join('nightly', 'eu-1'))).toBe(true);
    expect(await readdir(join(root, 'nightly'))).toEqual(['eu-1']);
  });

  it('refuses a subfolder that leaves the volume, by name or through a link', async () => {
    for (const sub of ['..', '../x', '/etc', 'a/../../x']) {
      await expect(resolveInside(root, sub)).rejects.toBeInstanceOf(
        BackupStepError,
      );
    }
    await symlink(outside, join(root, 'escape'));
    await expect(resolveInside(root, 'escape')).rejects.toThrow(
      /leads out of the backup volume/,
    );
    await expect(resolveInside(root, 'escape/deeper')).rejects.toThrow(
      /leads out of the backup volume/,
    );
    expect(await readdir(outside)).toEqual([]);
    // A link that stays inside is followed.
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'alias'));
    await expect(resolveInside(root, 'alias')).resolves.toMatch(/real$/);
  });

  it('puts, lists, deletes only backups, and tests by writing, reading back and deleting', async () => {
    const target = new LocalBackupTarget(root, 'nightly');
    expect(target.description).toBe('local:nightly');
    await target.test();
    const staged = join(root, 'staged.age');
    await writeFile(staged, 'age-encryption.org/v1\n…');
    const name = 'openfolia-backup-20261120T010203Z-72ad5ad9.tar.age';
    await target.put(
      { path: staged, sizeBytes: 25, sha256: 'a'.repeat(64) },
      name,
    );
    await writeFile(join(root, 'nightly', 'notes.txt'), 'not a backup');
    expect((await target.list()).map((b) => b.name)).toEqual([name]);
    await expect(target.delete('notes.txt')).rejects.toThrow();
    await target.delete(name);
    expect((await readdir(join(root, 'nightly'))).sort()).toEqual([
      'notes.txt',
    ]);
  });
});
