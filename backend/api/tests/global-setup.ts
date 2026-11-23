import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedDataDir } from './database.js';

/**
 * Once per test run: migrates an empty PGlite database and leaves its data
 * directory in a temporary file, from which `createTestDatabase()` starts
 * each test's own copy. So the migrations are those of this run's checkout.
 */
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-pglite-'));
  const file = join(dir, 'migrated.tar');
  const dump = await migratedDataDir();
  writeFileSync(file, new Uint8Array(await dump.arrayBuffer()));
  project.provide('pgliteTemplate', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
