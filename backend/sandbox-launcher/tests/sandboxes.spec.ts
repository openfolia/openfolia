import { silentLogger } from '../src/log.js';
import { Sandboxes, type SandboxLimits } from '../src/sandboxes.js';
import { clock, FakeRuntime } from './fakes.js';

const MINUTE = 60_000;
const LIMITS: SandboxLimits = {
  maxSandboxes: 3,
  perAddress: 1,
  perAddressDaily: 3,
  idleMinutes: 30,
  maxMinutes: 90,
  startTimeoutSeconds: 30,
};

function setup(limits: Partial<SandboxLimits> = {}) {
  const runtime = new FakeRuntime();
  const time = clock();
  const sandboxes = new Sandboxes(
    runtime,
    { ...LIMITS, ...limits },
    silentLogger,
    time.now,
  );
  return { runtime, time, sandboxes };
}

async function started(sandboxes: Sandboxes, address: string) {
  const result = await sandboxes.start(address, 'en');
  if (result.kind !== 'started') throw new Error(`not started: ${result.kind}`);
  return result;
}

describe('Sandboxes', () => {
  let runtime: FakeRuntime;
  afterEach(async () => runtime?.stopAll());

  describe('the cookie binding', () => {
    it('finds a sandbox by its token alone, and nothing by another', async () => {
      const s = setup();
      runtime = s.runtime;
      const a = await started(s.sandboxes, '10.0.0.1');
      const b = await started(s.sandboxes, '10.0.0.2');
      expect(s.sandboxes.find(a.token)?.id).toBe(a.session.id);
      expect(s.sandboxes.find(b.token)?.id).toBe(b.session.id);
      expect(a.session.id).not.toBe(b.session.id);
      expect(s.sandboxes.find(undefined)).toBeUndefined();
      expect(
        s.sandboxes.find(
          a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A'),
        ),
      ).toBeUndefined();
      // The token is random and long: 32 bytes.
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('ends a sandbox after the idle time, and a request moves the idle end on', async () => {
      const s = setup();
      runtime = s.runtime;
      const a = await started(s.sandboxes, '10.0.0.1');
      s.time.advance(29 * MINUTE);
      const session = s.sandboxes.find(a.token);
      expect(session).toBeDefined();
      s.sandboxes.touch(session!);
      s.time.advance(29 * MINUTE);
      expect(s.sandboxes.find(a.token)).toBeDefined();
      s.time.advance(2 * MINUTE);
      expect(s.sandboxes.find(a.token)).toBeUndefined();
      await vi.waitFor(() => expect(s.runtime.removed).toEqual([a.session.id]));
    });

    it('ends a sandbox at the maximum, however active', async () => {
      const s = setup();
      runtime = s.runtime;
      const a = await started(s.sandboxes, '10.0.0.1');
      for (let i = 0; i < 17; i++) {
        s.time.advance(5 * MINUTE);
        s.sandboxes.touch(s.sandboxes.find(a.token)!);
      }
      expect(s.sandboxes.endsAt(a.session)).toBe(
        a.session.startedAt + 90 * MINUTE,
      );
      s.time.advance(5 * MINUTE);
      expect(s.sandboxes.find(a.token)).toBeUndefined();
    });
  });

  describe('the limits', () => {
    it('starts at most the cap at once', async () => {
      const s = setup();
      runtime = s.runtime;
      for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3'])
        await started(s.sandboxes, address);
      expect(s.sandboxes.status()).toEqual({ capacity: 3, free: 0 });
      expect((await s.sandboxes.start('10.0.0.4', 'en')).kind).toBe('full');
      expect(s.runtime.started).toHaveLength(3);
    });

    it('counts starts under way against the cap and the address', async () => {
      const s = setup({ maxSandboxes: 2 });
      runtime = s.runtime;
      let open!: () => void;
      s.runtime.gate = new Promise((resolve) => (open = resolve));
      const first = s.sandboxes.start('10.0.0.1', 'en');
      const second = s.sandboxes.start('10.0.0.1', 'en');
      const third = s.sandboxes.start('10.0.0.2', 'en');
      const fourth = s.sandboxes.start('10.0.0.3', 'en');
      open();
      expect(
        (await Promise.all([first, second, third, fourth])).map((r) => r.kind),
      ).toEqual(['started', 'one-at-a-time', 'started', 'full']);
    });

    it('allows one at a time per address', async () => {
      const s = setup();
      runtime = s.runtime;
      const a = await started(s.sandboxes, '10.0.0.1');
      expect((await s.sandboxes.start('10.0.0.1', 'de')).kind).toBe(
        'one-at-a-time',
      );
      // Once it has ended, the next one may start.
      s.time.advance(31 * MINUTE);
      expect(s.sandboxes.find(a.token)).toBeUndefined();
      await vi.waitFor(() => expect(s.runtime.removed).toHaveLength(1));
      expect((await s.sandboxes.start('10.0.0.1', 'de')).kind).toBe('started');
    });

    it('allows three a day per address, then names when the next is possible', async () => {
      const s = setup({ maxSandboxes: 10 });
      runtime = s.runtime;
      const firstAt = s.time.now();
      for (let i = 0; i < 3; i++) {
        const r = await started(s.sandboxes, '10.0.0.1');
        s.time.advance(31 * MINUTE);
        s.sandboxes.find(r.token);
        await vi.waitFor(() => expect(s.runtime.removed).toHaveLength(i + 1));
      }
      const refused = await s.sandboxes.start('10.0.0.1', 'en');
      expect(refused).toEqual({
        kind: 'daily-limit',
        retryAt: firstAt + 24 * 60 * MINUTE,
      });
      // Another address is not affected.
      expect((await s.sandboxes.start('10.0.0.2', 'en')).kind).toBe('started');
      s.time.advance(24 * 60 * MINUTE - 3 * 31 * MINUTE + 1);
      expect((await s.sandboxes.start('10.0.0.1', 'en')).kind).toBe('started');
    });

    it('does not count a start that failed', async () => {
      const s = setup({ perAddressDaily: 1 });
      runtime = s.runtime;
      s.runtime.failNext = 'error';
      const failed = await s.sandboxes.start('10.0.0.1', 'en');
      expect(failed.kind).toBe('failed');
      expect(failed.kind === 'failed' && failed.reference).toMatch(
        /^[0-9a-f]{8}$/,
      );
      expect(s.sandboxes.status().free).toBe(3);
      expect((await s.sandboxes.start('10.0.0.1', 'en')).kind).toBe('started');
    });

    it('does not count a start that failed while the clean-up ran', async () => {
      const s = setup({ perAddressDaily: 1 });
      runtime = s.runtime;
      let open!: () => void;
      s.runtime.gate = new Promise((resolve) => (open = resolve));
      s.runtime.failNext = 'error';
      const pending = s.sandboxes.start('10.0.0.1', 'en');
      await s.sandboxes.sweep();
      open();
      s.runtime.gate = undefined;
      expect((await pending).kind).toBe('failed');
      expect((await s.sandboxes.start('10.0.0.1', 'en')).kind).toBe('started');
    });

    it('takes the runtime saying it is full as full', async () => {
      const s = setup();
      runtime = s.runtime;
      s.runtime.failNext = 'full';
      expect((await s.sandboxes.start('10.0.0.1', 'en')).kind).toBe('full');
      expect((await s.sandboxes.start('10.0.0.1', 'en')).kind).toBe('started');
    });
  });

  describe('the clean-up', () => {
    it('removes sandboxes past their time and the ones it does not know', async () => {
      const s = setup();
      runtime = s.runtime;
      const old = await started(s.sandboxes, '10.0.0.1');
      s.time.advance(20 * MINUTE);
      const young = await started(s.sandboxes, '10.0.0.2');
      s.runtime.strays.add('00000000000000aa');
      s.time.advance(11 * MINUTE);
      await s.sandboxes.sweep();
      expect(s.runtime.removed.sort()).toEqual(
        [old.session.id, '00000000000000aa'].sort(),
      );
      expect(s.sandboxes.find(young.token)).toBeDefined();
      expect(s.sandboxes.status().free).toBe(2);
    });

    it('leaves the runtime alone while a start is under way', async () => {
      const s = setup();
      runtime = s.runtime;
      let open!: () => void;
      s.runtime.gate = new Promise((resolve) => (open = resolve));
      const pending = s.sandboxes.start('10.0.0.1', 'en');
      s.runtime.strays.add('00000000000000bb');
      await s.sandboxes.sweep();
      expect(s.runtime.removed).toEqual([]);
      open();
      await pending;
    });

    it('removes every sandbox there is at its start, and every one it started at its end', async () => {
      const s = setup();
      runtime = s.runtime;
      s.runtime.strays.add('00000000000000cc');
      await s.sandboxes.reset();
      expect(s.runtime.removed).toEqual(['00000000000000cc']);
      const a = await started(s.sandboxes, '10.0.0.1');
      await s.sandboxes.removeAll();
      expect(s.runtime.removed).toContain(a.session.id);
      expect(s.sandboxes.find(a.token)).toBeUndefined();
    });

    it('ends a sandbox that stopped answering at once', async () => {
      const s = setup();
      runtime = s.runtime;
      const a = await started(s.sandboxes, '10.0.0.1');
      await s.sandboxes.drop(a.session, 'unreachable');
      expect(s.sandboxes.find(a.token)).toBeUndefined();
      expect(s.runtime.removed).toEqual([a.session.id]);
    });
  });
});
