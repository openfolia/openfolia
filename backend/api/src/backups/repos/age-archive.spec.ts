import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encrypter } from 'age-encryption';
import {
  checkArchive,
  decryptTo,
  extract,
  openArchive,
} from './age-archive.js';
import { AgeBackupKeys } from './age-backup-keys.js';
import { run } from './processes.js';

describe('age archives', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'age-archive-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('makes keys whose identity decrypts what was encrypted to their recipient, and no other', async () => {
    const keys = new AgeBackupKeys();
    const { identity, recipient } = await keys.generate();
    expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(
      await keys.recipientOf(
        `# created: now\n# public key: ${recipient}\n${identity}\n`,
      ),
    ).toBe(recipient);
    await expect(keys.recipientOf('not a key')).rejects.toThrow(
      /age X25519 identity/,
    );

    const e = new Encrypter();
    e.addRecipient(recipient);
    await writeFile(join(dir, 'x.age'), await e.encrypt('the plain text'));
    await decryptTo(join(dir, 'x.age'), identity, join(dir, 'x.txt'));
    expect(await readFile(join(dir, 'x.txt'), 'utf8')).toBe('the plain text');
    const other = await keys.generate();
    await expect(
      decryptTo(join(dir, 'x.age'), other.identity, join(dir, 'y.txt')),
    ).rejects.toThrow(/does not open with this key/);
  });

  it('extracts files and folders, and refuses an archive with a link before extracting anything', async () => {
    const src = join(dir, 'src');
    await run('mkdir', ['-p', join(src, 'blobs', 'ab')]);
    await writeFile(join(src, 'manifest.json'), '{}');
    await writeFile(join(src, 'blobs', 'ab', 'abcd'), 'blob');
    await run('tar', [
      '-cf',
      join(dir, 'good.tar'),
      '-C',
      src,
      'manifest.json',
      'blobs',
    ]);
    expect((await checkArchive(join(dir, 'good.tar'))).sort()).toEqual(
      expect.arrayContaining(['manifest.json', 'blobs/ab/abcd']),
    );
    await run('mkdir', [join(dir, 'out')]);
    await extract(join(dir, 'good.tar'), join(dir, 'out'));
    expect(
      await readFile(join(dir, 'out', 'blobs', 'ab', 'abcd'), 'utf8'),
    ).toBe('blob');

    await symlink('/etc', join(src, 'evil'));
    await run('tar', [
      '-cf',
      join(dir, 'evil.tar'),
      '-C',
      src,
      'manifest.json',
      'evil',
    ]);
    await expect(checkArchive(join(dir, 'evil.tar'))).rejects.toThrow(
      /other than files and folders/,
    );
  });

  const manifest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 1,
      runId: 'r1',
      createdAt: '2026-11-20T02:00:00.000Z',
      database: { migrations: 44, rows: {} },
      content: null,
      blobs: { dir: 'blobs', referenced: [] },
      secretKeyFile: 'secret.key',
      ...over,
    });

  async function archive(name: string, text: string): Promise<string> {
    const src = join(dir, `src-${name}`);
    await run('mkdir', ['-p', join(src, 'blobs', 'ab')]);
    await writeFile(join(src, 'manifest.json'), text);
    await writeFile(join(src, 'database.dump'), 'dump');
    await writeFile(join(src, 'blobs', 'ab', 'abcd'), 'blob');
    await writeFile(join(src, 'secret.key'), 'KEY');
    const tar = join(dir, `${name}.tar`);
    await run('tar', [
      '-cf',
      tar,
      '-C',
      src,
      'manifest.json',
      'database.dump',
      'blobs',
      'secret.key',
    ]);
    return tar;
  }

  const there = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  it('unpacks a backup for a check without the instance secret key, and with it for a restore', async () => {
    const tar = await archive('ok', manifest());
    const check = join(dir, 'check');
    await run('mkdir', [check]);
    const read = await openArchive(tar, check, { withSecretKey: false });
    expect(read.secretKeyFile).toBe('secret.key');
    expect(await readFile(join(check, 'blobs', 'ab', 'abcd'), 'utf8')).toBe(
      'blob',
    );
    expect(await there(join(check, 'database.dump'))).toBe(true);
    expect(await there(join(check, 'secret.key'))).toBe(false);

    const restore = join(dir, 'restore');
    await run('mkdir', [restore]);
    await openArchive(tar, restore, { withSecretKey: true });
    expect(await readFile(join(restore, 'secret.key'), 'utf8')).toBe('KEY');
  });

  it('refuses a manifest that names a path outside the backup, or a part it does not hold', async () => {
    for (const [name, over] of [
      ['up', { blobs: { dir: '../../etc', referenced: [] } }],
      ['abs', { secretKeyFile: '/etc/passwd' }],
      ['missing', { content: { file: 'content.bundle', refs: 1 } }],
      ['format', { format: 2 }],
    ] as const) {
      const out = join(dir, `out-${name}`);
      await run('mkdir', [out]);
      await expect(
        openArchive(await archive(name, manifest(over)), out, {
          withSecretKey: true,
        }),
      ).rejects.toThrow();
      expect(await there(join(out, 'secret.key'))).toBe(false);
    }
  });
});
