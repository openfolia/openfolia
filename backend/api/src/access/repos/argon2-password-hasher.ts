import * as crypto from 'node:crypto';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { UnavailableError } from '../../base/core/errors.js';
import { normalizePassword, PasswordHasher } from '../core/passwords.js';

/**
 * The argon2id parameters a new hash is made with (#610), in this one place: memory in KiB,
 * passes, lanes. OWASP's first recommendation (19 MiB, 2 passes, 1 lane): about 50 ms on a
 * server core. A hash records its own parameters, so raising these keeps old hashes working;
 * each is replaced at its user's next sign-in.
 */
export const ARGON2_PARAMETERS = Object.freeze({
  memory: 19_456,
  passes: 2,
  parallelism: 1,
});

/** The salt and the hash, in bytes. */
const SALT_BYTES = 16;
const TAG_BYTES = 32;

/** At most this many hashes are computed at once (each holds `memory` KiB). */
const MAX_RUNNING = 2;
/** At most this many wait behind them; past it, 503 `sign-in-busy`. */
const MAX_WAITING = 64;

type Parameters = { memory: number; passes: number; parallelism: number };

/**
 * `crypto.argon2` (Node 24.7 and later), typed here: the project's Node type definitions
 * predate it.
 */
type Argon2 = (
  algorithm: 'argon2id',
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, derived: Buffer) => void,
) => void;

const argon2 = (crypto as unknown as { argon2?: Argon2 }).argon2;

/** A stored hash in the PHC string format: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`. */
interface Parsed {
  readonly parameters: Parameters;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{16,88})\$([A-Za-z0-9+/]{16,344})$/;

function parse(stored: string): Parsed | undefined {
  const match = PHC.exec(stored);
  if (!match) return undefined;
  const [, m, t, p, salt, tag] = match;
  const parameters = {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
  };
  // Within what this server would ever make, so a stored hash cannot make it work for minutes.
  if (
    parameters.memory < 8 * parameters.parallelism ||
    parameters.memory > 262_144 ||
    parameters.passes < 1 ||
    parameters.passes > 10 ||
    parameters.parallelism < 1 ||
    parameters.parallelism > 16
  ) {
    return undefined;
  }
  return {
    parameters,
    salt: Buffer.from(salt!, 'base64'),
    tag: Buffer.from(tag!, 'base64'),
  };
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

function format(parameters: Parameters, salt: Buffer, tag: Buffer): string {
  return `$argon2id$v=19$m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/**
 * `PasswordHasher` with argon2id from Node's own `crypto.argon2` (#610), in the PHC string
 * format. Hashing runs on libuv's thread pool, at most `MAX_RUNNING` at once, so a flood of
 * sign-ins cannot take every thread (file reads share them) or much memory; past
 * `MAX_WAITING` waiting, it refuses (503 `sign-in-busy`) instead of queueing without end.
 */
@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /**
   * What `verifyNothing` checks against: a well-formed hash of nothing, random bytes in the
   * current parameters. Not computed, so it can never fail (nor be cached as a failure, which
   * would make an unknown address answer differently from a wrong password) and the first
   * check of nothing costs what every other check does.
   */
  private readonly dummy: string;

  constructor(private readonly parameters: Parameters = ARGON2_PARAMETERS) {
    super();
    this.dummy = format(
      parameters,
      randomBytes(SALT_BYTES),
      randomBytes(TAG_BYTES),
    );
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await this.compute(password, salt, this.parameters);
    return format(this.parameters, salt, tag);
  }

  async verify(stored: string, password: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) {
      // Malformed (never written by this server): no, in about the usual time.
      await this.verifyNothing(password);
      return false;
    }
    const tag = await this.compute(
      password,
      parsed.salt,
      parsed.parameters,
      parsed.tag.length,
    );
    return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return false;
    const { memory, passes, parallelism } = parsed.parameters;
    return (
      memory !== this.parameters.memory ||
      passes !== this.parameters.passes ||
      parallelism !== this.parameters.parallelism ||
      parsed.salt.length !== SALT_BYTES ||
      parsed.tag.length !== TAG_BYTES
    );
  }

  async verifyNothing(password: string): Promise<void> {
    await this.verify(this.dummy, password).catch((error: unknown) => {
      // The same refusal a real check would give when busy; anything else is nothing to say.
      if (error instanceof UnavailableError) throw error;
    });
  }

  private async compute(
    password: string,
    salt: Buffer,
    parameters: Parameters,
    tagLength = TAG_BYTES,
  ): Promise<Buffer> {
    if (argon2 === undefined) {
      throw new Error(
        'Password hashing needs Node 24.7 or later (crypto.argon2).',
      );
    }
    await this.acquire();
    try {
      return await new Promise<Buffer>((resolve, reject) =>
        argon2(
          'argon2id',
          {
            message: Buffer.from(normalizePassword(password), 'utf8'),
            nonce: salt,
            parallelism: parameters.parallelism,
            tagLength,
            memory: parameters.memory,
            passes: parameters.passes,
          },
          (error, derived) => (error ? reject(error) : resolve(derived)),
        ),
      );
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < MAX_RUNNING) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_WAITING) {
      return Promise.reject(
        new UnavailableError(
          'sign-in-busy',
          'Too many sign-ins at once; try again in a moment.',
          1,
        ),
      );
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
