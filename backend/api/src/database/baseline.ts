import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { DOMAIN_COMPONENTS } from '../components.js';
import { COMPONENT_SCHEMAS } from './component-schemas.js';
import { MIGRATIONS_FOLDER } from './database.js';

/** A baseline the command does not write, with why, for the person who ran it. */
export class BaselineRefused extends Error {}

/** Every component that has tables and is not of the documentation domain (`src/components.ts`). */
export function componentsWithoutDomain(): string[] {
  return Object.keys(COMPONENT_SCHEMAS).filter(
    (name) => !DOMAIN_COMPONENTS.includes(name),
  );
}

/** A baseline migration: its SQL statements and drizzle-kit's snapshot of its tables. */
export interface Baseline {
  readonly components: readonly string[];
  readonly statements: readonly string[];
  readonly snapshot: ReturnType<typeof generateDrizzleJson>;
}

/**
 * One migration that makes the tables of `components` (folders of `src/`, `COMPONENT_SCHEMAS`)
 * from nothing, with what their migrations write by hand, as the schema stands now: for a fresh
 * database only, never added to an existing chain. Refuses an unknown component, and a table
 * whose foreign key points at a table of a component not chosen (the migration would not run).
 */
export async function baselineMigration(
  components: readonly string[],
): Promise<Baseline> {
  const unknown = components.filter((name) => !(name in COMPONENT_SCHEMAS));
  if (unknown.length > 0) {
    throw new BaselineRefused(
      `Unknown component${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Components with tables: ${Object.keys(COMPONENT_SCHEMAS).join(', ')}.`,
    );
  }
  if (components.length === 0) {
    throw new BaselineRefused('Choose at least one component.');
  }
  const chosen = Object.keys(COMPONENT_SCHEMAS).filter((name) =>
    components.includes(name),
  );

  const owner = new Map<PgTable, string>();
  for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
    for (const value of Object.values(schema.tables)) {
      if (is(value, PgTable)) owner.set(value, name);
    }
  }
  const imports: Record<string, unknown> = {};
  for (const name of chosen) {
    for (const [key, value] of Object.entries(
      COMPONENT_SCHEMAS[name]!.tables,
    )) {
      if (!is(value, PgTable)) continue;
      imports[key] = value;
      for (const foreignKey of getTableConfig(value).foreignKeys) {
        const target = foreignKey.reference().foreignTable;
        const targetComponent = owner.get(target);
        if (targetComponent !== undefined && chosen.includes(targetComponent))
          continue;
        throw new BaselineRefused(
          `Table "${getTableName(value)}" of ${name} has a foreign key to table ` +
            `"${getTableName(target)}" of ${targetComponent ?? 'no component'}, which is not ` +
            `chosen: add ${targetComponent ?? 'its component'} or leave out ${name}.`,
        );
      }
    }
  }

  const snapshot = generateDrizzleJson(imports);
  const tables = await generateMigration(generateDrizzleJson({}), snapshot);
  const sql = chosen.map((name) => COMPONENT_SCHEMAS[name]!.sql);
  const statements = [
    ...sql.flatMap((part) => part?.before ?? []),
    ...tables,
    ...sql.flatMap((part) => part?.after ?? []),
  ];
  // A statement two components share (a trigger function) is written once, where it first comes.
  return { components: chosen, statements: [...new Set(statements)], snapshot };
}

/** The migration's tag: its SQL file's name and its journal entry. */
export const BASELINE_TAG = '0000_baseline';

/**
 * Writes `baseline` to `out` as a drizzle-kit migrations folder (the SQL, the journal, the
 * snapshot), so Drizzle's migrator applies it and drizzle-kit generates the next migration on top.
 * `out` must be new or empty, and outside this repository's migrations (`MIGRATIONS_FOLDER`):
 * nothing is overwritten. Returns the files written.
 */
export async function writeBaseline(
  out: string,
  baseline: Baseline,
): Promise<string[]> {
  const folder = resolve(out);
  const committed = await realpath(MIGRATIONS_FOLDER);
  const refuseCommitted = (real: string) => {
    const rest = relative(committed, real);
    if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest))
      return;
    throw new BaselineRefused(
      `${folder} is in the committed migrations (${MIGRATIONS_FOLDER}): write the baseline elsewhere.`,
    );
  };
  refuseCommitted(await realpathOfNearest(folder));
  let present: string[] = [];
  try {
    present = await readdir(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR')
      throw new BaselineRefused(`${folder} is a file, not a folder.`);
    if (code !== 'ENOENT') throw error;
  }
  if (present.length > 0) {
    throw new BaselineRefused(
      `${folder} is not empty: write the baseline to a new or empty folder.`,
    );
  }
  await mkdir(join(folder, 'meta'), { recursive: true });
  // Again with the folder made, in case a link in its path changed meanwhile: then no file is
  // written (the empty folders `mkdir` made may stay).
  refuseCommitted(await realpath(folder));

  const files: [string, string][] = [
    [
      `${BASELINE_TAG}.sql`,
      [
        `-- A baseline migration for a fresh database: the tables of ${baseline.components.join(', ')},\n` +
          `-- generated by api:db-baseline. Never apply it to a database that has tables already.\n` +
          baseline.statements[0],
        ...baseline.statements.slice(1),
      ].join('\n--> statement-breakpoint\n') + '\n',
    ],
    [
      join('meta', '_journal.json'),
      json({
        version: '7',
        dialect: 'postgresql',
        entries: [
          {
            idx: 0,
            version: '7',
            when: Date.now(),
            tag: BASELINE_TAG,
            breakpoints: true,
          },
        ],
      }),
    ],
    [
      join('meta', `${BASELINE_TAG.slice(0, 4)}_snapshot.json`),
      json(baseline.snapshot),
    ],
  ];
  const written: string[] = [];
  for (const [name, content] of files) {
    const path = join(folder, name);
    await writeFile(path, content, { flag: 'wx' });
    written.push(path);
  }
  return written;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** The real path of `path`, or of its nearest existing parent joined with the rest. */
async function realpathOfNearest(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await realpathOfNearest(parent), relative(parent, path));
  }
}
