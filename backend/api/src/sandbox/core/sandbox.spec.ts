import { describe, expect, it } from 'vitest';
import { ForbiddenError, UnprocessableError } from '../../base/core/errors.js';
import {
  Sandbox,
  SandboxNotAllowedError,
  type SandboxLimits,
} from './sandbox.js';

const LIMITS: SandboxLimits = {
  moduleBytes: 100,
  commentLength: 5,
  changeSets: 2,
  modules: 1,
  manuals: 1,
  releasesPerHour: 2,
  renderJobs: 1,
  writeBytes: 1_000_000,
};

function sandbox(start = Date.parse('2026-11-24T10:00:00Z')) {
  const clock = { now: start };
  const box = Sandbox.on({
    limits: LIMITS,
    lifetime: { idleMinutes: 30, maxMinutes: 90 },
    now: () => clock.now,
  });
  return { box, clock };
}

const limitOf = (error: unknown) =>
  error instanceof UnprocessableError ? error.meta : undefined;

describe('Sandbox', () => {
  it('off, refuses and counts nothing', async () => {
    expect(() => Sandbox.OFF.refuse('users')).not.toThrow();
    Sandbox.OFF.checkBytes(10 ** 9);
    Sandbox.OFF.checkCommentLength('x'.repeat(10 ** 6));
    for (let i = 0; i < 10; i++) {
      await Sandbox.OFF.counted('change-sets', () => Promise.resolve(i));
    }
    expect(Sandbox.OFF.status()).toBeUndefined();
  });

  it('on, refuses with 403 sandbox-not-allowed naming what', () => {
    const { box } = sandbox();
    const error = (() => {
      try {
        box.refuse('uploads');
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SandboxNotAllowedError);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({
      code: 'sandbox-not-allowed',
      meta: { refused: 'uploads' },
    });
  });

  it('counts what it makes up to the cap, then 422 sandbox-limit-reached', async () => {
    const { box } = sandbox();
    await box.counted('change-sets', () => Promise.resolve('a'));
    await box.counted('change-sets', () => Promise.resolve('b'));
    let ran = false;
    const refused = await box
      .counted('change-sets', () => {
        ran = true;
        return Promise.resolve('c');
      })
      .catch((error: unknown) => error);
    expect(ran).toBe(false);
    expect(refused).toMatchObject({ code: 'sandbox-limit-reached' });
    expect(limitOf(refused)).toEqual({ limit: 'changeSets', max: 2 });
    expect(box.status()?.used['change-sets']).toBe(2);
  });

  it('counts nothing for what fails, and counts running ones against the cap', async () => {
    const { box } = sandbox();
    await expect(
      box.counted('modules', () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused');
    expect(box.status()?.used.modules).toBe(0);
    let release: () => void = () => undefined;
    const first = box.counted(
      'modules',
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    // One is still running: a second at once would take it past the cap.
    await expect(
      box.counted('modules', () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'sandbox-limit-reached' });
    release();
    await first;
    expect(box.status()?.used.modules).toBe(1);
  });

  it('counts releases over the last hour', async () => {
    const { box, clock } = sandbox();
    await box.counted('releases', () => Promise.resolve());
    clock.now += 30 * 60_000;
    await box.counted('releases', () => Promise.resolve());
    await expect(
      box.counted('releases', () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'releasesPerHour', max: 2 },
    });
    // The first leaves the hour: one fits again.
    clock.now += 30 * 60_000 + 1;
    await box.counted('releases', () => Promise.resolve());
    expect(box.status()?.used.releases).toBe(2);
  });

  it('caps a working copy’s bytes and a comment’s characters', () => {
    const { box } = sandbox();
    box.checkBytes(100);
    expect(() => box.checkBytes(101)).toThrow(
      expect.objectContaining({
        code: 'sandbox-limit-reached',
        meta: { limit: 'moduleBytes', max: 100 },
      }),
    );
    // Characters, not UTF-16 units: five emoji are five.
    box.checkCommentLength('😀😀😀😀😀');
    expect(() => box.checkCommentLength('abcdef')).toThrow(
      expect.objectContaining({
        meta: { limit: 'commentLength', max: 5 },
      }),
    );
  });

  it('spends written bytes up to the budget, comments included, counting nothing refused', () => {
    const box = Sandbox.on({
      limits: { ...LIMITS, commentLength: 100, writeBytes: 10 },
      lifetime: { idleMinutes: 30, maxMinutes: 90 },
    });
    box.spend(6);
    // Bytes, not characters: "ü" is two.
    box.checkCommentLength('üü');
    expect(box.status()?.writtenBytes).toBe(10);
    expect(() => box.spend(1)).toThrow(
      expect.objectContaining({
        code: 'sandbox-limit-reached',
        meta: { limit: 'writeBytes', max: 10 },
      }),
    );
    expect(() => box.checkCommentLength('a')).toThrow(
      expect.objectContaining({ meta: { limit: 'writeBytes', max: 10 } }),
    );
    expect(box.status()?.writtenBytes).toBe(10);
    Sandbox.OFF.spend(10 ** 12);
  });

  it('ends idle minutes after the last activity, at most max minutes after its start', () => {
    const start = Date.parse('2026-11-24T10:00:00Z');
    const { box, clock } = sandbox(start);
    expect(box.status()?.endsAt.toISOString()).toBe('2026-11-24T10:30:00.000Z');
    clock.now = start + 20 * 60_000;
    box.touch();
    expect(box.status()?.endsAt.toISOString()).toBe('2026-11-24T10:50:00.000Z');
    clock.now = start + 80 * 60_000;
    box.touch();
    // Idle would be 11:50; the hard end is 11:30.
    expect(box.status()?.endsAt.toISOString()).toBe('2026-11-24T11:30:00.000Z');
    expect(box.status()?.startedAt.toISOString()).toBe(
      '2026-11-24T10:00:00.000Z',
    );
  });
});
