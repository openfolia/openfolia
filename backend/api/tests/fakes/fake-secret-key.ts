import {
  SealedSecretSource,
  type SealedValue,
  SecretSealer,
} from '../../src/base/core/secret-sealer.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { SecretKey } from '../../src/secrets/core/secret-key.js';
import {
  SecretCipher,
  SecretKeyCheck,
  SecretKeyFile,
  SecretKeySettings,
} from '../../src/secrets/core/secret-key-ports.js';
import type { SecretKeyVariable } from '../../src/secrets/core/secret-key.js';
import type { FakeTransaction } from './fake-unit-of-work.js';

/** A key of 32 times `byte` (tests only). */
export const testKey = (byte: number): SecretKey =>
  new SecretKey(Buffer.alloc(32, byte));

/**
 * Seals by naming the key (tests only): `sealed:<key's first byte>:<context>:<secret>`.
 * Opens only under the same key and context, as AES-GCM would.
 */
class FakeSealer extends SecretSealer {
  readonly available = true;
  constructor(private readonly id: number) {
    super();
  }
  seal(secret: string, context: string): string {
    return `sealed:${this.id}:${context}:${secret}`;
  }
  open(sealed: string, context: string): string {
    const prefix = `sealed:${this.id}:${context}:`;
    if (!sealed.startsWith(prefix)) throw new Error('cannot open');
    return sealed.slice(prefix.length);
  }
}

/** A sealer under the key named `id` (tests only): another `id` opens nothing it sealed. */
export const fakeSealer = (id = 1): SecretSealer => new FakeSealer(id);

/** `SecretCipher` over `FakeSealer`; makes the keys `generated` names, else 0x40, 0x41, … */
export class FakeSecretCipher extends SecretCipher {
  generated: SecretKey[] = [];
  private nextByte = 0x40;
  generateKey(): SecretKey {
    const key = testKey(this.nextByte++);
    this.generated.push(key);
    return key;
  }
  sealer(key: SecretKey): SecretSealer {
    return new FakeSealer(key.bytes()[0]!);
  }
}

export class FakeSecretKeySettings extends SecretKeySettings {
  configured:
    | { readonly key: SecretKey; readonly variable: SecretKeyVariable }
    | undefined = undefined;
  file = '/data/ccms-secret.key';
  generate = true;
}

/** The key file and its `.next` in memory; `beforeCreate` stands in for another server writing first. */
export class FakeSecretKeyFile extends SecretKeyFile {
  readonly path = '/data/ccms-secret.key';
  key: SecretKey | undefined;
  next: SecretKey | undefined;
  /** Runs as `create` is called, before it looks (a server racing it). */
  beforeCreate?: () => void;
  readonly writes: string[] = [];

  async read(): Promise<SecretKey | undefined> {
    return this.key;
  }
  async create(key: SecretKey): Promise<{ key: SecretKey; created: boolean }> {
    this.beforeCreate?.();
    if (this.key) return { key: this.key, created: false };
    this.key = key;
    this.writes.push('create');
    return { key, created: true };
  }
  async readNext(): Promise<SecretKey | undefined> {
    return this.next;
  }
  async writeNext(key: SecretKey): Promise<void> {
    this.next = key;
    this.writes.push('writeNext');
  }
  /** The next key set aside last (`discardNext`). */
  discarded: SecretKey | undefined;
  async promoteNext(key: SecretKey): Promise<void> {
    if (!this.next) {
      if (this.key?.equals(key)) return;
      throw new Error('No next key.');
    }
    if (!this.next.equals(key)) throw new Error('Another next key.');
    this.key = this.next;
    this.next = undefined;
    this.writes.push('promoteNext');
  }
  async discardNext(): Promise<void> {
    if (!this.next) return;
    this.discarded = this.next;
    this.next = undefined;
    this.writes.push('discardNext');
  }
}

/** Sealed values in memory, written on commit (`FakeTransaction`). */
export class FakeSealedSecretSource extends SealedSecretSource {
  readonly name = 'test secrets';
  values: SealedValue[] = [];

  async sample(_tx: Transaction, limit: number): Promise<SealedValue[]> {
    return this.values.slice(0, limit);
  }

  async reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number> {
    let count = 0;
    const next = this.values.map((value) => {
      const sealed = reseal(value);
      if (sealed === undefined) return value;
      count++;
      return { sealed, context: value.context };
    });
    (tx as FakeTransaction).onCommit(() => {
      this.values = next;
    });
    return count;
  }
}

/** The key check in memory, written on commit; `locks` counts the locks taken. */
export class FakeSecretKeyCheck extends SecretKeyCheck {
  sealed: string | undefined;
  locks = 0;
  async lock(): Promise<void> {
    this.locks++;
  }
  async read(): Promise<string | undefined> {
    return this.sealed;
  }
  async write(tx: Transaction, sealed: string): Promise<void> {
    if (this.sealed !== undefined) throw new Error('There is a check already.');
    (tx as FakeTransaction).onCommit(() => {
      this.sealed = sealed;
    });
  }
  async replace(tx: Transaction, sealed: string): Promise<void> {
    (tx as FakeTransaction).onCommit(() => {
      this.sealed = sealed;
    });
  }
}
