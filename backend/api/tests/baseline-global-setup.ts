import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  baselineMigration,
  componentsWithoutDomain,
  writeBaseline,
} from '../src/database/baseline.js';
import { migratedDataDir } from './database.js';

/**
 * `vitest.baseline.config.mts`: as `global-setup.ts`, but every test database is a copy of one
 * made by the baseline migration of every component but the documentation domain's, not by the
 * committed migrations. So those components' tests show the baseline is enough for them.
 */
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-baseline-'));
  const folder = join(dir, 'migrations');
  await writeBaseline(
    folder,
    await baselineMigration(componentsWithoutDomain()),
  );
  const file = join(dir, 'migrated.tar');
  const dump = await migratedDataDir(folder);
  writeFileSync(file, new Uint8Array(await dump.arrayBuffer()));
  project.provide('pgliteTemplate', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
