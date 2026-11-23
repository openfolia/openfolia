import { inspect } from 'node:util';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  FakeSealedSecretSource,
  FakeSecretCipher,
  FakeSecretKeyCheck,
  FakeSecretKeyFile,
  FakeSecretKeySettings,
  testKey,
} from '../../../../tests/fakes/fake-secret-key.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { InstanceSecretKey } from '../instance-secret-key.js';
import { SecretKey, SecretKeyProblem } from '../secret-key.js';
import {
  KEY_CHECK_CONTEXT,
  KEY_CHECK_TEXT,
  SealedSecretSources,
} from '../secret-key-ports.js';
import { GetSecretKeyAction } from './get-secret-key.action.js';
import { OpenSecretKeyAction } from './open-secret-key.action.js';
import { RotateSecretKeyAction } from './rotate-secret-key.action.js';

function setUp() {
  const settings = new FakeSecretKeySettings();
  const file = new FakeSecretKeyFile();
  const cipher = new FakeSecretCipher();
  const source = new FakeSealedSecretSource();
  const unit = new FakeUnitOfWork();
  const sources = new SealedSecretSources([source]);
  const check = new FakeSecretKeyCheck();
  const open = new OpenSecretKeyAction(
    settings,
    file,
    cipher,
    sources,
    check,
    unit,
  );
  const rotate = new RotateSecretKeyAction(
    open,
    file,
    cipher,
    sources,
    check,
    unit,
  );
  /** The key check as `key` seals it. */
  const checkOf = (key: SecretKey) =>
    cipher.sealer(key).seal(KEY_CHECK_TEXT, KEY_CHECK_CONTEXT);
  /** Stores `secret` sealed under `key`, as a component would. */
  const store = (key: SecretKey, secret: string, context = 'test:1') =>
    source.values.push({
      sealed: cipher.sealer(key).seal(secret, context),
      context,
    });
  const openWith =
    (key: SecretKey) => (value: { sealed: string; context: string }) =>
      cipher.sealer(key).open(value.sealed, value.context);
  return {
    settings,
    file,
    cipher,
    source,
    unit,
    open,
    rotate,
    store,
    openWith,
    check,
    checkOf,
  };
}

describe('SecretKey', () => {
  it('never shows its bytes when printed, logged or serialised', () => {
    const key = new SecretKey(Buffer.alloc(32, 0xab));
    const hex = 'ab'.repeat(32);
    for (const shown of [
      String(key),
      `${key}`,
      JSON.stringify({ key }),
      inspect(key),
      inspect({ nested: { key } }),
    ]) {
      expect(shown).not.toContain(hex);
      expect(shown).not.toContain(Buffer.alloc(32, 0xab).toString('base64'));
    }
    expect(key.equals(new SecretKey(Buffer.alloc(32, 0xab)))).toBe(true);
    expect(key.equals(testKey(1))).toBe(false);
    expect(() => new SecretKey(Buffer.alloc(16))).toThrow();
  });
});

describe('OpenSecretKeyAction', () => {
  it('makes the key file on a first start, with nothing sealed yet', async () => {
    const t = setUp();
    const opened = await t.open.handle();
    expect(opened.origin).toEqual({
      kind: 'file',
      path: '/data/ccms-secret.key',
      created: true,
    });
    expect(opened.key?.equals(t.cipher.generated[0]!)).toBe(true);
    expect(t.file.key?.equals(opened.key!)).toBe(true);
  });

  it('reads the key file on a later start, and checks it opens what is sealed', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.store(testKey(1), 'whsec_a');
    const opened = await t.open.handle();
    expect(opened.origin).toMatchObject({ kind: 'file', created: false });
    expect(opened.key?.equals(testKey(1))).toBe(true);
    expect(t.cipher.generated).toEqual([]);
    expect(t.file.writes).toEqual([]);
  });

  it('takes the key another server starting at the same time wrote first', async () => {
    const t = setUp();
    t.file.beforeCreate = () => (t.file.key = testKey(9));
    const opened = await t.open.handle();
    expect(opened.key?.equals(testKey(9))).toBe(true);
    expect(opened.origin).toMatchObject({ kind: 'file', created: false });
  });

  it('takes a key set by a variable, and writes no file', async () => {
    const t = setUp();
    t.settings.configured = { key: testKey(2), variable: 'CCMS_SECRET_KEY' };
    t.store(testKey(2), 'whsec_a');
    const opened = await t.open.handle();
    expect(opened.origin).toEqual({
      kind: 'environment',
      variable: 'CCMS_SECRET_KEY',
    });
    expect(opened.key?.equals(testKey(2))).toBe(true);
    expect(t.file.writes).toEqual([]);
  });

  it('refuses a variable whose key does not open what is sealed', async () => {
    const t = setUp();
    t.settings.configured = {
      key: testKey(2),
      variable: 'CCMS_WEBHOOKS_SECRET_KEY',
    };
    t.store(testKey(1), 'whsec_a');
    await expect(t.open.handle()).rejects.toThrow(
      /CCMS_WEBHOOKS_SECRET_KEY does not open the secrets/,
    );
  });

  it('refuses to start, and makes no key, when the key file is lost while secrets are sealed', async () => {
    const t = setUp();
    t.store(testKey(1), 'whsec_a');
    const failure = t.open.handle();
    await expect(failure).rejects.toBeInstanceOf(SecretKeyProblem);
    await expect(failure).rejects.toThrow(
      /no key file at \/data\/ccms-secret\.key[\s\S]*restore the key file from a backup/,
    );
    expect(t.file.writes).toEqual([]);
    expect(t.cipher.generated).toEqual([]);
  });

  it('refuses a key file whose key does not open what is sealed', async () => {
    const t = setUp();
    t.file.key = testKey(3);
    t.store(testKey(1), 'whsec_a');
    await expect(t.open.handle()).rejects.toThrow(
      /The key file \/data\/ccms-secret\.key does not open/,
    );
  });

  it('opens when one of the values checked opens (a single damaged row does not stop the server)', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.source.values.push({ sealed: 'garbage', context: 'test:0' });
    t.store(testKey(1), 'whsec_a');
    await expect(t.open.handle()).resolves.toMatchObject({
      origin: { kind: 'file' },
    });
  });

  it('with generation off and no key: none, nothing written', async () => {
    const t = setUp();
    t.settings.generate = false;
    const opened = await t.open.handle();
    expect(opened).toEqual({
      key: undefined,
      origin: { kind: 'none' },
      finishedRotation: false,
    });
    expect(t.file.writes).toEqual([]);
  });

  it('with generation off: still reads a key file the operator put there', async () => {
    const t = setUp();
    t.settings.generate = false;
    t.file.key = testKey(4);
    expect((await t.open.handle()).key?.equals(testKey(4))).toBe(true);
  });

  it('with generation off and secrets sealed: refuses to start without a key', async () => {
    const t = setUp();
    t.settings.generate = false;
    t.store(testKey(1), 'whsec_a');
    await expect(t.open.handle()).rejects.toBeInstanceOf(SecretKeyProblem);
  });

  it('finishes a rotation cut off after its commit: the next key opens, the file’s does not', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.file.next = testKey(2);
    t.store(testKey(2), 'whsec_a');
    const opened = await t.open.handle();
    expect(opened.finishedRotation).toBe(true);
    expect(opened.key?.equals(testKey(2))).toBe(true);
    expect(t.file.key?.equals(testKey(2))).toBe(true);
    expect(t.file.next).toBeUndefined();
  });

  it('drops a rotation’s next key cut off before its commit', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.file.next = testKey(2);
    t.store(testKey(1), 'whsec_a');
    const opened = await t.open.handle();
    expect(opened.finishedRotation).toBe(false);
    expect(opened.key?.equals(testKey(1))).toBe(true);
    expect(t.file.next).toBeUndefined();
    expect(t.file.discarded?.equals(testKey(2))).toBe(true);
  });

  it('refuses, and keeps both keys, when some secrets open with each', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.file.next = testKey(2);
    t.store(testKey(1), 'whsec_a', 'test:1');
    t.store(testKey(2), 'whsec_b', 'test:2');
    await expect(t.open.handle()).rejects.toThrow(/Keep both files/);
    expect(t.file.key?.equals(testKey(1))).toBe(true);
    expect(t.file.next?.equals(testKey(2))).toBe(true);
  });
  it('writes the key check on the first start that has a key, and judges by it afterwards', async () => {
    const t = setUp();
    const first = await t.open.handle();
    expect(t.check.sealed).toBe(t.checkOf(first.key!));
    // A damaged value does not matter: the check decides.
    t.source.values.push({ sealed: 'garbage', context: 'test:0' });
    await expect(t.open.handle()).resolves.toMatchObject({
      origin: { kind: 'file', created: false },
    });
    expect(t.check.locks).toBe(2);
  });

  it('refuses a second server that would make its own key (no shared key file), even with nothing sealed yet', async () => {
    const t = setUp();
    t.check.sealed = t.checkOf(testKey(1));
    await expect(t.open.handle()).rejects.toThrow(
      /there is no key to open them[\s\S]*share the key file/,
    );
    expect(t.cipher.generated).toEqual([]);
    expect(t.file.writes).toEqual([]);
  });

  it('refuses a key that does not open the check, whatever the sealed values', async () => {
    const t = setUp();
    t.settings.configured = { key: testKey(2), variable: 'CCMS_SECRET_KEY' };
    t.check.sealed = t.checkOf(testKey(1));
    t.store(testKey(2), 'whsec_a');
    await expect(t.open.handle()).rejects.toThrow(
      /CCMS_SECRET_KEY does not open/,
    );
  });

  it('keeps a rotation’s next key when the key file does not open the database either', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.file.next = testKey(2);
    t.check.sealed = t.checkOf(testKey(3));
    await expect(t.open.handle()).rejects.toThrow(/does not open/);
    expect(t.file.next?.equals(testKey(2))).toBe(true);
  });
});

describe('RotateSecretKeyAction', () => {
  it('re-seals every value under a new key file key, in one transaction', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.store(testKey(1), 'whsec_a', 'test:1');
    t.store(testKey(1), 'whsec_b', 'test:2');
    const rotated = await t.rotate.handle();
    expect(rotated.resealed).toEqual([
      { name: 'test secrets', count: 2, unreadable: 0 },
    ]);
    const next = t.cipher.generated[0]!;
    expect(t.file.key?.equals(next)).toBe(true);
    expect(t.file.writes).toEqual(['writeNext', 'promoteNext']);
    expect(t.source.values.map(t.openWith(next))).toEqual([
      'whsec_a',
      'whsec_b',
    ]);
    // The key check too, and under the key's lock (the rotation's, then the promotion's).
    expect(t.check.sealed).toBe(t.checkOf(next));
    expect(t.check.locks).toBe(2);
    // The re-sealing, then the promotion.
    expect(t.unit.committed).toBe(2);
  });

  it('leaves a value the current key does not open (unreadable already) as it is, and counts it', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.store(testKey(1), 'whsec_a', 'test:1');
    t.source.values.push({ sealed: 'garbage', context: 'test:2' });
    const rotated = await t.rotate.handle();
    expect(rotated.resealed).toEqual([
      { name: 'test secrets', count: 1, unreadable: 1 },
    ]);
    const next = t.cipher.generated[0]!;
    expect(t.openWith(next)(t.source.values[0]!)).toBe('whsec_a');
    expect(t.source.values[1]).toEqual({
      sealed: 'garbage',
      context: 'test:2',
    });
  });

  it('keeps the next key when the re-sealing fails, for the start to judge, and never deletes it', async () => {
    const t = setUp();
    t.file.key = testKey(1);
    t.store(testKey(1), 'whsec_a');
    t.source.reseal = () => Promise.reject(new Error('connection lost'));
    await expect(t.rotate.handle()).rejects.toThrow('connection lost');
    expect(t.file.key?.equals(testKey(1))).toBe(true);
    const next = t.file.next;
    expect(next).toBeDefined();
    // The old key opens the check: the next start sets `.next` aside.
    await t.open.handle();
    expect(t.file.next).toBeUndefined();
    expect(t.file.discarded?.equals(next!)).toBe(true);
  });

  it('takes the operator’s new key for a key set by a variable, and writes no file', async () => {
    const t = setUp();
    t.settings.configured = { key: testKey(1), variable: 'CCMS_SECRET_KEY' };
    t.store(testKey(1), 'whsec_a');
    await expect(t.rotate.handle()).rejects.toThrow(/CCMS_SECRET_KEY_NEW/);
    const rotated = await t.rotate.handle({ next: testKey(5) });
    expect(rotated.origin).toEqual({
      kind: 'environment',
      variable: 'CCMS_SECRET_KEY',
    });
    expect(t.file.writes).toEqual([]);
    expect(t.source.values.map(t.openWith(testKey(5)))).toEqual(['whsec_a']);
  });

  it('refuses without a key, or with the same key', async () => {
    const t = setUp();
    await expect(t.rotate.handle()).rejects.toThrow(/no key to rotate/);
    expect(t.file.writes).toEqual([]);
    t.file.key = testKey(1);
    await expect(t.rotate.handle({ next: testKey(1) })).rejects.toThrow(
      /is the current one/,
    );
  });
});

describe('GetSecretKeyAction', () => {
  it('says where the key is, to administrators only', async () => {
    const t = setUp();
    const key = new InstanceSecretKey(t.cipher);
    const get = new GetSecretKeyAction(key, t.settings);
    const admin = actorWith(['admin.roles']);
    expect(await get.handle({ actor: admin })).toEqual({
      origin: { kind: 'none' },
      generate: true,
    });
    key.use(await t.open.handle());
    expect(await get.handle({ actor: admin })).toEqual({
      origin: { kind: 'file', path: '/data/ccms-secret.key', created: true },
      generate: true,
    });
    await expect(
      get.handle({ actor: actorWith(['webhook.manage']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('InstanceSecretKey', () => {
  it('seals nothing until the start opened a key, then under it', async () => {
    const t = setUp();
    const key = new InstanceSecretKey(t.cipher);
    expect(key.available).toBe(false);
    expect(() => key.seal('x', 'c')).toThrow(/no secret key/);
    key.use({
      key: testKey(1),
      origin: { kind: 'environment', variable: 'CCMS_SECRET_KEY' },
      finishedRotation: false,
    });
    expect(key.available).toBe(true);
    expect(key.open(key.seal('x', 'c'), 'c')).toBe('x');
    expect(() =>
      key.use({
        key: undefined,
        origin: { kind: 'none' },
        finishedRotation: false,
      }),
    ).toThrow();
  });
});
