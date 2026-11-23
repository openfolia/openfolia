// Which databases `slot remove` and `slot prune-databases` drop: the names (pure), and the flow
// against a fake Postgres client. No test here talks to a real Postgres, except the last block,
// which runs only with CCMS_TEST_PG_URL set and makes and drops databases of its own only.
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  apiDatabaseName,
  checkoutDatabases,
  isProtected,
  isSlotShaped,
  maintenanceUrl,
  orphanDatabases,
  ownerComment,
  perfDatabaseName,
  slotDatabasesToDrop,
  slotKey,
} from '@/scripts/slot-databases-plan.mjs';
import {
  COMPOSE_DATABASE_URL,
  dropSlotDatabases,
  liveSlots,
  pgConnect,
  pruneDatabases,
  sameServer,
  serverFrom,
} from '@/scripts/slot-databases.mjs';
import { serializeSlot } from '@/scripts/slot-file.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'slot-db-')));
  dirs.push(dir);
  return dir;
}

describe('the names', () => {
  it('derives a checkout`s databases as setup-local and perf:seed name them', () => {
    expect(slotKey('audience-filter')).toBe('audience_filter');
    expect(slotKey('a--b-')).toBe('a_b_');
    expect(apiDatabaseName('audience-filter')).toBe('ccms_audience_filter');
    expect(apiDatabaseName(undefined)).toBe('ccms');
    expect(perfDatabaseName('a-b', 'large')).toBe('ccms_perf_a_b_large');
    expect(perfDatabaseName(undefined, 'large')).toBe('ccms_perf_large');
    expect(checkoutDatabases('x')).toEqual([
      'ccms_x',
      'ccms_perf_x_small',
      'ccms_perf_x_large',
      'ccms_perf_x_xl',
    ]);
  });

  it('names a slot`s API database as setup-local does', () => {
    // setup-local.ts cannot import the plan (another project): its derivation, pinned here.
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../backend/api/scripts/setup-local.ts',
      ),
      'utf8',
    );
    const flat = source.replace(/\s+/g, '');
    expect(flat).toContain(
      "?`ccms_${basename(root).toLowerCase().replace(/[^a-z0-9]+/g,'_')}`:'ccms';",
    );
  });

  it('marks a slot`s database as setup-local does', () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../backend/api/scripts/setup-local.ts',
      ),
      'utf8',
    );
    expect(ownerComment('/x')).toBe('ccms-checkout:/x');
    expect(source).toContain(
      '`ccms-checkout:${dirname(dirname(dirname(realpathSync(root))))}`',
    );
  });

  it('protects Postgres`s own and the main checkout`s', () => {
    for (const name of [
      'postgres',
      'template0',
      'template1',
      'ccms',
      'ccms_perf_small',
      'ccms_perf_large',
      'ccms_perf_xl',
    ])
      expect(isProtected(name), name).toBe(true);
    for (const name of ['ccms_a', 'ccms_perf_a_large'])
      expect(isProtected(name), name).toBe(false);
  });
});

/** This checkout's comment on its slots' databases, in these tests. */
const OWNER = ownerComment('/repo');
/** Databases as pg_database lists them, with this checkout's comment unless another is given. */
function dbs(names: string[], comments: Record<string, string | null> = {}) {
  return names.map((name) => ({
    name,
    comment: name in comments ? comments[name] : OWNER,
  }));
}

describe('slotDatabasesToDrop', () => {
  const existing = dbs([
    'postgres',
    'template0',
    'template1',
    'ccms',
    'ccms_perf_large',
    'ccms_a',
    'ccms_a_b',
    'ccms_ab',
    'ccms_perf_a_small',
    'ccms_perf_a_b_small',
    'ccms_perf_a_huge',
    'ccms_a_old',
  ]);

  it('drops exactly the names derived from the slot`s name, never a prefix match', () => {
    expect(
      slotDatabasesToDrop({
        slot: 'a',
        liveSlots: ['a'],
        existing,
        owner: OWNER,
      }),
    ).toEqual({ drop: ['ccms_a', 'ccms_perf_a_small'], kept: [] });
    expect(
      slotDatabasesToDrop({
        slot: 'a-b',
        liveSlots: ['a', 'a-b'],
        existing,
        owner: OWNER,
      }),
    ).toEqual({ drop: ['ccms_a_b', 'ccms_perf_a_b_small'], kept: [] });
  });

  it('only those that exist', () => {
    expect(
      slotDatabasesToDrop({
        slot: 'zzz',
        liveSlots: [],
        existing,
        owner: OWNER,
      }),
    ).toEqual({ drop: [], kept: [] });
  });

  it('keeps a name another live slot derives too', () => {
    // `a-b` and `a--b` both give ccms_a_b.
    expect(
      slotDatabasesToDrop({
        slot: 'a--b',
        liveSlots: ['a-b'],
        existing,
        owner: OWNER,
      }).kept,
    ).toEqual([
      { name: 'ccms_a_b', why: "another live slot's name gives it too" },
      {
        name: 'ccms_perf_a_b_small',
        why: "another live slot's name gives it too",
      },
    ]);
    // The slot `perf-a-small` gives ccms_perf_a_small, the slot `a`'s small profile.
    expect(
      slotDatabasesToDrop({
        slot: 'perf-a-small',
        liveSlots: ['a'],
        existing,
        owner: OWNER,
      }),
    ).toEqual({
      drop: [],
      kept: [
        {
          name: 'ccms_perf_a_small',
          why: "another live slot's name gives it too",
        },
      ],
    });
  });

  it('keeps one another checkout (or a person) commented; one without a comment is the slot`s', () => {
    expect(
      slotDatabasesToDrop({
        slot: 'a',
        liveSlots: [],
        existing: dbs(['ccms_a', 'ccms_perf_a_small'], {
          ccms_a: 'ccms-checkout:/elsewhere',
          ccms_perf_a_small: null,
        }),
        owner: OWNER,
      }),
    ).toEqual({
      drop: ['ccms_perf_a_small'],
      kept: [
        {
          name: 'ccms_a',
          why: "its comment names another checkout's tooling, or none",
        },
      ],
    });
  });

  it('never the main checkout`s, whatever the slot is called', () => {
    // The slot `perf-large` gives ccms_perf_large, the main checkout's large profile.
    expect(
      slotDatabasesToDrop({
        slot: 'perf-large',
        liveSlots: [],
        existing,
        owner: OWNER,
      }),
    ).toEqual({
      drop: [],
      kept: [{ name: 'ccms_perf_large', why: "the main checkout's" }],
    });
  });
});

describe('orphanDatabases', () => {
  it('drops those this checkout made for a gone slot; lists others of the shape', () => {
    const existing = dbs(
      [
        'postgres',
        'template0',
        'template1',
        'template_custom',
        'ccms',
        'ccms_perf_large',
        'ccms_live_one',
        'ccms_perf_live_one_xl',
        'ccms_gone',
        'ccms_perf_gone_small',
        'ccms_test_locks_0a1b2c3d4e5f',
        'ccms_verify_20261101020304_0a1b2c3d',
        'someone_else',
        'ccms_',
        'ccms__x',
        'ccms_Upper',
        `ccms_${'a'.repeat(32)}`,
        'ccms_by_hand',
        'ccms_other_clone',
        'ccms_before_comments',
      ],
      {
        ccms_by_hand: 'my backup',
        ccms_other_clone: 'ccms-checkout:/elsewhere',
        ccms_before_comments: null,
      },
    );
    expect(
      orphanDatabases({ liveSlots: ['live-one'], existing, owner: OWNER }),
    ).toEqual({
      drop: ['ccms_gone', 'ccms_perf_gone_small'],
      unmarked: ['ccms_before_comments', 'ccms_by_hand', 'ccms_other_clone'],
    });
  });

  it('knows the shapes', () => {
    expect(isSlotShaped(`ccms_${'a'.repeat(31)}`)).toBe(true);
    expect(isSlotShaped('ccms_perf_a_b_large')).toBe(true);
    expect(isSlotShaped('ccms_test_saves_abc')).toBe(false);
    expect(isSlotShaped('other')).toBe(false);
  });
});

describe('maintenanceUrl', () => {
  it('turns a local database URL into its server`s postgres one', () => {
    expect(maintenanceUrl('postgres://u:secret@127.0.0.1:5432/ccms_a')).toEqual(
      {
        url: 'postgres://u:secret@127.0.0.1:5432/postgres',
        host: '127.0.0.1:5432',
      },
    );
    expect(maintenanceUrl('postgresql://u@localhost/x').host).toBe('localhost');
  });

  it('refuses anything else, never quoting the URL', () => {
    for (const url of [
      undefined,
      '',
      'not a url',
      'mysql://u:secret@127.0.0.1/x',
      'postgres://u:secret@db.example.com:5432/x',
      'postgres://u:secret@127.0.0.1:5432/x?host=elsewhere',
    ]) {
      const result = maintenanceUrl(url);
      expect(result.url, String(url)).toBeUndefined();
      expect(result.why).not.toContain('secret');
    }
  });
});

describe('serverFrom', () => {
  it('reads the first settings file that sets CCMS_DATABASE_URL', () => {
    const dir = tempDir();
    const none = path.join(dir, 'none.env');
    const without = path.join(dir, 'without.env');
    const slot = path.join(dir, 'slot.env');
    writeFileSync(without, 'PORT=3101\n');
    writeFileSync(
      slot,
      '# local\nCCMS_DATABASE_URL=postgres://u:pw@127.0.0.1:6543/ccms_x\n',
    );
    expect(serverFrom([none, without, slot])).toEqual({
      url: 'postgres://u:pw@127.0.0.1:6543/postgres',
      host: '127.0.0.1:6543',
    });
  });

  it('stops at a server that is not local, never trying another', () => {
    const dir = tempDir();
    const remote = path.join(dir, 'remote.env');
    const local = path.join(dir, 'local.env');
    writeFileSync(
      remote,
      'CCMS_DATABASE_URL=postgres://u:pw@db.example.com/x\n',
    );
    writeFileSync(local, 'CCMS_DATABASE_URL=postgres://u:pw@127.0.0.1/x\n');
    expect(serverFrom([remote, local])).toEqual({
      why: 'CCMS_DATABASE_URL is not on this machine',
    });
  });

  it('falls back to the compose Postgres', () => {
    expect(serverFrom([undefined])).toEqual(
      maintenanceUrl(COMPOSE_DATABASE_URL),
    );
  });
});

describe('sameServer', () => {
  it('keeps a slot`s drop on the main checkout`s server', () => {
    const main = maintenanceUrl('postgres://u:pw@127.0.0.1:5432/ccms');
    const same = maintenanceUrl('postgres://u:pw@127.0.0.1:5432/ccms_a');
    const other = maintenanceUrl('postgres://u:pw@127.0.0.1:5433/ccms_a');
    expect(sameServer(same, main)).toBe(same);
    expect(sameServer(other, main)).toEqual({
      why: "the slot's settings name another server than the main checkout's",
    });
    const refused = { why: 'CCMS_DATABASE_URL is not on this machine' };
    expect(sameServer(refused, main)).toBe(refused);
    expect(sameServer(same, refused)).toBe(refused);
  });
});

describe('liveSlots', () => {
  it('counts every record and every worktree folder', () => {
    const root = tempDir();
    mkdirSync(path.join(root, '.claude', 'stacks', 'recorded'), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, '.claude', 'stacks', 'recorded', 'slot.json'),
      serializeSlot({ name: 'recorded', port: 3101 }),
    );
    mkdirSync(path.join(root, '.claude', 'worktrees', 'folder-only'), {
      recursive: true,
    });
    expect(liveSlots(root).sort()).toEqual(['folder-only', 'recorded']);
  });
});

/** A Postgres client double: answers pg_database from `existing`, records every statement. */
function fakePostgres({
  existing,
  comments = {},
  inUse = [],
  failing = [],
  down = false,
  refused = false,
}: {
  existing: string[];
  comments?: Record<string, string | null>;
  inUse?: string[];
  failing?: string[];
  down?: boolean;
  refused?: boolean;
}) {
  const row = (datname: string) => ({
    datname,
    comment: datname in comments ? comments[datname] : OWNER,
  });
  const statements: string[] = [];
  const urls: string[] = [];
  let ended = 0;
  const connect = (url: string) => {
    urls.push(url);
    return {
      connect: async () => {
        if (down)
          throw Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          });
        if (refused)
          throw Object.assign(new Error('password authentication failed'), {
            code: '28P01',
          });
      },
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        if (sql.startsWith('select datname') && sql.includes('any($1')) {
          const wanted = new Set(params?.[0] as string[]);
          return { rows: existing.filter((n) => wanted.has(n)).map(row) };
        }
        if (sql.startsWith('select datname')) {
          return { rows: existing.map(row) };
        }
        if (sql.startsWith('select pg_size_pretty'))
          return { rows: [{ size: '8 MB' }] };
        const dropped = /^drop database if exists "([^"]+)"$/.exec(sql)?.[1];
        if (dropped && inUse.includes(dropped))
          throw Object.assign(new Error('in use'), { code: '55006' });
        if (dropped && failing.includes(dropped))
          throw Object.assign(new Error('permission denied'), {
            code: '42501',
          });
        return { rows: [] };
      },
      end: async () => {
        ended += 1;
      },
    };
  };
  return {
    connect,
    statements,
    urls,
    drops: () => statements.filter((sql) => sql.startsWith('drop ')),
    ended: () => ended,
  };
}

const server = maintenanceUrl('postgres://u:pw@127.0.0.1:5432/ccms_x') as {
  url: string;
  host: string;
};

describe('dropSlotDatabases', () => {
  const existing = ['ccms', 'ccms_x', 'ccms_perf_x_small', 'ccms_x_y'];

  it('drops the slot`s own, without FORCE, and says so', async () => {
    const pg = fakePostgres({ existing });
    const lines: string[] = [];
    const ok = await dropSlotDatabases({
      slot: 'x',
      live: ['x', 'x-y'],
      owner: OWNER,
      server,
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(true);
    expect(pg.urls).toEqual([server.url]);
    expect(pg.drops()).toEqual([
      'drop database if exists "ccms_x"',
      'drop database if exists "ccms_perf_x_small"',
    ]);
    expect(pg.statements.join('\n')).not.toMatch(/force/i);
    expect(lines).toEqual([
      'Databases: ccms_x dropped.',
      'Databases: ccms_perf_x_small dropped.',
    ]);
    expect(pg.ended()).toBe(1);
  });

  it('a dry run says what it would drop and drops nothing', async () => {
    const pg = fakePostgres({ existing });
    const lines: string[] = [];
    await dropSlotDatabases({
      slot: 'x',
      live: [],
      owner: OWNER,
      server,
      connect: pg.connect,
      dryRun: true,
      log: (line: string) => lines.push(line),
    });
    expect(pg.drops()).toEqual([]);
    expect(lines).toEqual([
      'Databases: would drop ccms_x.',
      'Databases: would drop ccms_perf_x_small.',
    ]);
  });

  it('skips a database in use with a note; a failed drop fails the run', async () => {
    const pg = fakePostgres({
      existing,
      inUse: ['ccms_x'],
      failing: ['ccms_perf_x_small'],
    });
    const lines: string[] = [];
    const ok = await dropSlotDatabases({
      slot: 'x',
      live: [],
      owner: OWNER,
      server,
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(false);
    expect(lines).toEqual([
      'Databases: ccms_x in use, left as it is.',
      'Databases: ccms_perf_x_small failed: 42501 permission denied.',
    ]);
  });

  it('Postgres not answering is a note, not a failure', async () => {
    const pg = fakePostgres({ existing, down: true });
    const lines: string[] = [];
    const ok = await dropSlotDatabases({
      slot: 'x',
      live: [],
      owner: OWNER,
      server,
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(true);
    expect(lines.join('\n')).toMatch(/does not answer at 127\.0\.0\.1:5432/);
    expect(lines.join('\n')).not.toContain('pw');
  });

  it('Postgres refusing the connection is a failure', async () => {
    const pg = fakePostgres({ existing, refused: true });
    const lines: string[] = [];
    const ok = await dropSlotDatabases({
      slot: 'x',
      live: [],
      owner: OWNER,
      server,
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(false);
    expect(lines).toEqual([
      'Databases: none dropped: Postgres at 127.0.0.1:5432 refused the connection (28P01).',
    ]);
  });

  it('an unusable server: nothing is tried', async () => {
    const pg = fakePostgres({ existing });
    const lines: string[] = [];
    await dropSlotDatabases({
      slot: 'x',
      live: [],
      owner: OWNER,
      server: { why: 'CCMS_DATABASE_URL is not on this machine' },
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(pg.urls).toEqual([]);
    expect(lines).toEqual([
      'Databases: none dropped (CCMS_DATABASE_URL is not on this machine).',
    ]);
  });
});

describe('pruneDatabases', () => {
  const existing = [
    'postgres',
    'template1',
    'ccms',
    'ccms_live',
    'ccms_gone',
    'ccms_perf_gone_xl',
    'ccms_test_x_0a1b2c',
    'ccms_mine_by_hand',
  ];
  const comments = { ccms_mine_by_hand: null };

  it('lists first and drops nothing without yes', async () => {
    const pg = fakePostgres({ existing, comments });
    const lines: string[] = [];
    await pruneDatabases({
      live: ['live'],
      owner: OWNER,
      server,
      connect: pg.connect,
      log: (line: string) => lines.push(line),
    });
    expect(pg.drops()).toEqual([]);
    expect(lines).toEqual([
      "Not dropped, not marked as made by this checkout's tooling (older, by hand or another clone's; drop them by hand if they are yours): ccms_mine_by_hand",
      'Databases of slots that are gone, on 127.0.0.1:5432 (live slots: live):',
      '  ccms_gone\t8 MB',
      '  ccms_perf_gone_xl\t8 MB',
      'Nothing dropped. To drop these 2: pnpm slot prune-databases --yes',
    ]);
  });

  it('drops them with yes, skipping one in use', async () => {
    const pg = fakePostgres({ existing, comments, inUse: ['ccms_gone'] });
    const lines: string[] = [];
    const ok = await pruneDatabases({
      live: ['live'],
      owner: OWNER,
      server,
      connect: pg.connect,
      yes: true,
      log: (line: string) => lines.push(line),
    });
    expect(ok).toBe(true);
    expect(pg.drops()).toEqual([
      'drop database if exists "ccms_gone"',
      'drop database if exists "ccms_perf_gone_xl"',
    ]);
    expect(lines.slice(-2)).toEqual([
      'Databases: ccms_gone in use, left as it is.',
      'Databases: ccms_perf_gone_xl dropped.',
    ]);
  });
});

// Against a real Postgres, only when one is named for tests (CCMS_TEST_PG_URL, .env.example):
// databases of a made-up slot with a random name, made here and dropped here.
const testPg = process.env.CCMS_TEST_PG_URL;
describe.skipIf(!testPg)('against a real Postgres (CCMS_TEST_PG_URL)', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const connect = pgConnect(root);
  const real = maintenanceUrl(testPg) as {
    url: string;
    host: string;
    why?: string;
  };
  const slot = `zz-dbtest-${randomBytes(4).toString('hex')}`;
  const mine = [apiDatabaseName(slot), perfDatabaseName(slot, 'small')];
  const busySlot = `zz-dbbusy-${randomBytes(4).toString('hex')}`;
  const busy = apiDatabaseName(busySlot);

  type Client = ReturnType<typeof connect>;
  async function admin<T>(fn: (client: Client) => Promise<T>) {
    const client = connect(real.url);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const present = () =>
    admin(async (client) =>
      (
        await client.query(
          'select datname from pg_database where datname = any($1::text[])',
          [[...mine, busy]],
        )
      ).rows
        .map((row: { datname: string }) => row.datname)
        .sort(),
    );

  afterAll(async () => {
    await admin(async (client) => {
      for (const name of [...mine, busy])
        await client.query(`drop database if exists "${name}"`);
    });
  }, 120_000);

  it('drops the slot`s own and leaves one in use', async () => {
    if (real.why) throw new Error(`CCMS_TEST_PG_URL: ${real.why}`);
    await admin(async (client) => {
      for (const name of [...mine, busy])
        await client.query(`create database "${name}"`);
    });
    const holder = connect(real.url.replace(/\/postgres$/, `/${busy}`));
    await holder.connect();
    try {
      const lines: string[] = [];
      const log = (line: string) => lines.push(line);
      expect(
        await dropSlotDatabases({
          slot,
          live: [],
          owner: OWNER,
          server: real,
          connect,
          log,
        }),
      ).toBe(true);
      expect(
        await dropSlotDatabases({
          slot: busySlot,
          live: [],
          owner: OWNER,
          server: real,
          connect,
          log,
        }),
      ).toBe(true);
      expect(await present()).toEqual([busy]);
      expect(lines).toContain(`Databases: ${busy} in use, left as it is.`);
    } finally {
      await holder.end();
    }
  }, 120_000);
});
