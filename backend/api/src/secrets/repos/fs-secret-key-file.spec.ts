import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { SecretKey, SecretKeyProblem } from '../core/secret-key.js';
import { FsSecretKeyFile } from './fs-secret-key-file.js';

const key = (byte: number) => new SecretKey(Buffer.alloc(32, byte));
const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openfolia-key-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FsSecretKeyFile', () => {
  it('has no key before the file is made', async () => {
    expect(await new FsSecretKeyFile(join(dir, 'k')).read()).toBeUndefined();
  });

  it('makes the file with mode 0600 (in a folder made with 0700), as base64, and reads it back', async () => {
    const path = join(dir, 'data', 'ccms-secret.key');
    const file = new FsSecretKeyFile(path);
    const made = await file.create(key(7));
    expect(made.created).toBe(true);
    expect(made.key.equals(key(7))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      `${Buffer.alloc(32, 7).toString('base64')}\n`,
    );
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
    }
    expect((await file.read())?.equals(key(7))).toBe(true);
    // No temporary file is left beside it.
    expect(readdirSync(join(dir, 'data'))).toEqual(['ccms-secret.key']);
  });

  it('never replaces a file that is there: two servers starting at once share one key', async () => {
    const path = join(dir, 'ccms-secret.key');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new FsSecretKeyFile(path).create(key(i + 1)),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)!.key;
    for (const r of results) expect(r.key.equals(winner)).toBe(true);
    expect((await new FsSecretKeyFile(path).read())?.equals(winner)).toBe(true);
    expect(readdirSync(dir)).toEqual(['ccms-secret.key']);
  });

  it('reads a key written as hex too, and refuses a file holding no key, without quoting it', async () => {
    const path = join(dir, 'k');
    writeFileSync(path, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
    expect((await new FsSecretKeyFile(path).read())?.equals(key(0xab))).toBe(
      true,
    );
    writeFileSync(path, 'not-a-key-but-secret-text', { mode: 0o600 });
    const failure = new FsSecretKeyFile(path).read();
    await expect(failure).rejects.toBeInstanceOf(SecretKeyProblem);
    await expect(failure).rejects.toThrow(/holds no key/);
    await expect(new FsSecretKeyFile(path).read()).rejects.not.toThrow(
      /secret-text/,
    );
  });

  it('refuses a folder in the file’s place', async () => {
    await expect(new FsSecretKeyFile(dir).read()).rejects.toThrow(
      /is not a file/,
    );
  });

  it.runIf(posix)(
    'warns, without the key, when others may read the file',
    async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const path = join(dir, 'k');
      writeFileSync(path, Buffer.alloc(32, 5).toString('base64'));
      chmodSync(path, 0o644);
      expect((await new FsSecretKeyFile(path).read())?.equals(key(5))).toBe(
        true,
      );
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mode 644/));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        Buffer.alloc(32, 5).toString('base64'),
      );
    },
  );

  it.runIf(posix && process.getuid?.() !== 0)(
    'says what to do when the folder cannot be written',
    async () => {
      const folder = join(dir, 'locked');
      mkdirSync(folder, { mode: 0o500 });
      await expect(
        new FsSecretKeyFile(join(folder, 'k')).create(key(1)),
      ).rejects.toThrow(
        /Cannot write the key file .*EACCES.*CCMS_SECRET_KEY_FILE/,
      );
      chmodSync(folder, 0o700);
    },
  );

  it('writes, promotes and sets aside a rotation’s next key beside the file, never deleting one', async () => {
    const path = join(dir, 'k');
    const file = new FsSecretKeyFile(path);
    await file.create(key(1));
    await file.writeNext(key(2));
    if (posix) expect(statSync(`${path}.next`).mode & 0o777).toBe(0o600);
    expect((await file.readNext())?.equals(key(2))).toBe(true);
    await file.writeNext(key(3));
    expect((await file.readNext())?.equals(key(3))).toBe(true);
    // Another rotation's next key: nothing is moved.
    await expect(file.promoteNext(key(2))).rejects.toThrow(
      /holds another key than this rotation's/,
    );
    expect((await file.read())?.equals(key(1))).toBe(true);
    await file.promoteNext(key(3));
    expect((await file.read())?.equals(key(3))).toBe(true);
    expect(await file.readNext()).toBeUndefined();
    // Promoted already (another server finished it): nothing to do.
    await file.promoteNext(key(3));
    await expect(file.promoteNext(key(4))).rejects.toThrow(/is gone/);
    await file.writeNext(key(4));
    await file.discardNext();
    await file.discardNext();
    await file.writeNext(key(5));
    await file.discardNext();
    expect(await file.readNext()).toBeUndefined();
    expect((await file.read())?.equals(key(3))).toBe(true);
    // Each set aside under a name of its own: none replaced.
    const discarded = readdirSync(dir).filter((n) =>
      n.startsWith('k.next.discarded.'),
    );
    expect(readdirSync(dir).filter((n) => !discarded.includes(n))).toEqual([
      'k',
    ]);
    expect(
      discarded.map((n) => readFileSync(join(dir, n), 'utf8')).sort(),
    ).toEqual(
      [4, 5].map((b) => `${Buffer.alloc(32, b).toString('base64')}\n`).sort(),
    );
  });
});
