import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Logger } from '@nestjs/common';
import { parseSecretKey } from '../../config/secret-key-env.js';
import { SecretKey, SecretKeyProblem } from '../core/secret-key.js';
import { SecretKeyFile } from '../core/secret-key-ports.js';

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** The error's code (`EACCES`, …), never its message: a message could quote what was read. */
const why = (error: unknown): string => errorCode(error) ?? 'unknown error';

/**
 * `SecretKeyFile` on the local file system. The file holds the key as
 * base64 and a newline, so an operator can copy it into
 * `CCMS_SECRET_KEY`. It is made with mode 0600 (owner only; the umask can
 * only narrow it) in a folder made with 0700 when missing: first written
 * whole and synced under a temporary name, then linked to its name, which
 * fails when the name exists, so two servers starting at once never make
 * two keys, and none ever reads half a file. One readable by others is
 * used, with a warning.
 */
export class FsSecretKeyFile extends SecretKeyFile {
  private readonly logger = new Logger('SecretKey');

  constructor(readonly path: string) {
    super();
  }

  private get nextPath(): string {
    return `${this.path}.next`;
  }

  /** Where a rotation's next key that was not needed is set aside, under a name of its own (never deleted). */
  private get discardedPath(): string {
    return `${this.path}.next.discarded`;
  }

  read(): Promise<SecretKey | undefined> {
    return this.readKey(this.path, 'The key file');
  }

  readNext(): Promise<SecretKey | undefined> {
    return this.readKey(this.nextPath, 'The next key a rotation left');
  }

  async create(key: SecretKey): Promise<{ key: SecretKey; created: boolean }> {
    const temporary = await this.writeTemporary(key);
    try {
      await link(temporary, this.path);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new SecretKeyProblem(
          `Cannot write the key file ${this.path} (${why(error)}): make its folder writable for the server, or set CCMS_SECRET_KEY_FILE or CCMS_SECRET_KEY.`,
        );
      }
      // Another server starting at the same time wrote it first: its key it is.
      const theirs = await this.read();
      if (!theirs) {
        throw new SecretKeyProblem(
          `The key file ${this.path} vanished while it was being made.`,
        );
      }
      return { key: theirs, created: false };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.syncFolder();
    return { key, created: true };
  }

  async writeNext(key: SecretKey): Promise<void> {
    const temporary = await this.writeTemporary(key);
    try {
      await rename(temporary, this.nextPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new SecretKeyProblem(
        `Cannot write the next key ${this.nextPath} (${why(error)}).`,
      );
    }
    await this.syncFolder();
  }

  async promoteNext(key: SecretKey): Promise<void> {
    const next = await this.readNext();
    if (!next) {
      // Another server finished it already (under the key's lock, as here).
      if ((await this.read())?.equals(key)) return;
      throw new SecretKeyProblem(
        `The next key ${this.nextPath} is gone, and ${this.path} does not hold it: the secrets are sealed under it now. Look for it as ${this.discardedPath}.* (or a later rotation replaced it: start a server, it says whether the key file opens the database).`,
      );
    }
    if (!next.equals(key)) {
      throw new SecretKeyProblem(
        `${this.nextPath} holds another key than this rotation's (another rotation ran): nothing was moved. Start a server: it keeps whichever key opens the database.`,
      );
    }
    try {
      await rename(this.nextPath, this.path);
    } catch (error) {
      throw new SecretKeyProblem(
        `Cannot move the next key ${this.nextPath} to ${this.path} (${why(error)}): the secrets are sealed under it now, so keep it; the next start moves it.`,
      );
    }
    await this.syncFolder();
  }

  async discardNext(): Promise<void> {
    try {
      // A name of its own: one set aside before is never replaced.
      await link(
        this.nextPath,
        `${this.discardedPath}.${Date.now()}.${randomUUID().slice(0, 8)}`,
      );
      await unlink(this.nextPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new SecretKeyProblem(
        `Cannot set ${this.nextPath} aside (${why(error)}).`,
      );
    }
    await this.syncFolder();
  }

  private async readKey(
    path: string,
    what: string,
  ): Promise<SecretKey | undefined> {
    let text: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        throw new SecretKeyProblem(`${what} ${path} is not a file.`);
      }
      // Group or others may read it: used, but said (never what it holds).
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        this.logger.warn(
          `${what} ${path} may be read by other users of this machine (mode ${(info.mode & 0o777).toString(8)}): chmod 600 it.`,
        );
      }
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof SecretKeyProblem) throw error;
      if (errorCode(error) === 'ENOENT') return undefined;
      throw new SecretKeyProblem(
        `Cannot read ${what.toLowerCase()} ${path} (${why(error)}).`,
      );
    }
    const bytes = parseSecretKey(text);
    if (!bytes) {
      throw new SecretKeyProblem(
        `${what} ${path} holds no key (32 bytes as base64 or 64 hex digits): restore it from a backup.`,
      );
    }
    return new SecretKey(bytes);
  }

  /** The key, whole and synced, under a temporary name beside the file (mode 0600). */
  private async writeTemporary(key: SecretKey): Promise<string> {
    const folder = dirname(this.path);
    const temporary = join(
      folder,
      `.${basename(this.path)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${key.bytes().toString('base64')}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new SecretKeyProblem(
        `Cannot write the key file ${this.path} (${why(error)}): make its folder writable for the server, or set CCMS_SECRET_KEY_FILE or CCMS_SECRET_KEY.`,
      );
    }
    return temporary;
  }

  /** The folder's entry for a new or renamed file survives a crash too. */
  private async syncFolder(): Promise<void> {
    if (process.platform === 'win32') return;
    const folder = await open(dirname(this.path), 'r').catch(() => undefined);
    try {
      await folder?.sync();
    } catch {
      // Not every file system syncs a folder; the file itself is synced.
    } finally {
      await folder?.close();
    }
  }
}
