import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Env } from '../../config/env.js';
import { Database } from '../../database/database.js';
import { InstanceSizes } from '../core/storage-usage.js';

/** Past this many entries the content repository's size is not reported. */
export const MAX_ENTRIES = 1_000_000;

/**
 * `InstanceSizes`: the content repository's files on disk
 * (`CCMS_CONTENT_DIR`, walked without following links) and
 * `pg_database_size` of the app's database.
 */
@Injectable()
export class LocalInstanceSizes extends InstanceSizes {
  private readonly dir: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly database: Database,
  ) {
    super();
    this.dir = config.get('CCMS_CONTENT_DIR', { infer: true });
  }

  async gitBytes(signal?: AbortSignal): Promise<number | null> {
    return sizeOf(this.dir, signal);
  }

  async databaseBytes(): Promise<number | null> {
    const result = await this.database.db.execute<{ bytes: string | number }>(
      sql`select pg_database_size(current_database())::bigint as bytes`,
    );
    const bytes = Number(result.rows[0]?.bytes);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  }
}

/** The bytes of the files under `dir`; null past `MAX_ENTRIES`; stops when `signal` aborts. */
export async function sizeOf(
  dir: string,
  signal?: AbortSignal,
): Promise<number | null> {
  let bytes = 0;
  let entries = 0;
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of await readdir(next, { withFileTypes: true })) {
      if (++entries > MAX_ENTRIES) return null;
      signal?.throwIfAborted();
      const path = join(next, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) bytes += (await lstat(path)).size;
    }
  }
  return bytes;
}
