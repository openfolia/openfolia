import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_MAX_AGE_MS, healthOf, markAlive } from './health-file.js';

describe("the backup service's health file (#813)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-health-spec-'));
    file = join(dir, 'alive');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const at = new Date('2026-11-23T19:49:21.000Z');
  const later = (ms: number) => new Date(at.getTime() + ms);

  it('is healthy right after a heartbeat, and up to three heartbeats later', async () => {
    await markAlive(file, at);
    expect(await healthOf(file, at)).toEqual({
      healthy: true,
      detail: 'last heartbeat 0 s ago',
    });
    expect((await healthOf(file, later(HEALTH_MAX_AGE_MS))).healthy).toBe(true);
  });

  it('is unhealthy once the last heartbeat is older, and says how old', async () => {
    await markAlive(file, at);
    const health = await healthOf(file, later(HEALTH_MAX_AGE_MS + 1_000));
    expect(health.healthy).toBe(false);
    expect(health.detail).toMatch(/46 s ago \(at 2026-11-23T19:49:21.000Z/);
  });

  it('takes the newest heartbeat, written whole', async () => {
    await markAlive(file, at);
    await markAlive(file, later(60_000));
    expect((await healthOf(file, later(70_000))).healthy).toBe(true);
    expect(await readdir(dir)).toEqual(['alive']);
  });

  it('is unhealthy before the first heartbeat, and with a file that holds no time', async () => {
    const none = await healthOf(file, at);
    expect(none.healthy).toBe(false);
    expect(none.detail).toMatch(/no heartbeat yet/);

    await writeFile(file, 'garbage');
    const garbage = await healthOf(file, at);
    expect(garbage.healthy).toBe(false);
    expect(garbage.detail).toMatch(/holds no time/);
  });
});
