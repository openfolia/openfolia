import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Decrypter } from 'age-encryption';
import { z } from 'zod';
import type { BackupManifest } from '../core/backup-ports.js';
import { identityLine } from './age-backup-keys.js';
import { output, run } from './processes.js';

/** What an archive member's name may be: relative, plain characters, no `..`. */
const MEMBER =
  /^(\.\/)?[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\/?$/;

/** The top-level names a backup holds besides the blob folder. */
export const BACKUP_FILES = [
  'manifest.json',
  'database.dump',
  'content.bundle',
];

/**
 * Decrypts the age file `encrypted` with `identity` into `plain` (a tar).
 * Throws when the identity does not open it or the file was changed (age
 * authenticates every chunk).
 */
export async function decryptTo(
  encrypted: string,
  identity: string,
  plain: string,
): Promise<void> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identityLine(identity));
  const input = Readable.toWeb(
    createReadStream(encrypted),
  ) as unknown as ReadableStream<Uint8Array>;
  let out: ReadableStream<Uint8Array>;
  try {
    out = await decrypter.decrypt(input);
  } catch (error) {
    throw new Error(
      `The backup does not open with this key (another key, or not an age file): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  await pipeline(
    Readable.fromWeb(out as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(plain, { mode: 0o600 }),
  );
}

/**
 * Checks every member of the tar `plain` before anything is extracted:
 * only regular files and folders (no links, devices or FIFOs), with plain
 * relative names, so a crafted archive (anyone holding the public
 * recipient can make one) never writes outside the folder it is unpacked
 * into.
 */
export async function checkArchive(plain: string): Promise<string[]> {
  const verbose = (await output('tar', ['-tvf', plain]))
    .split('\n')
    .filter(Boolean);
  for (const line of verbose) {
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new Error(
        `The backup holds something other than files and folders: ${line.slice(0, 200)}`,
      );
    }
  }
  const names = (await output('tar', ['-tf', plain]))
    .split('\n')
    .filter(Boolean);
  if (names.length !== verbose.length) {
    throw new Error('The backup’s member list cannot be read.');
  }
  for (const name of names) {
    if (!MEMBER.test(name) || name.split('/').includes('..')) {
      throw new Error(
        `The backup holds a member with an unexpected name: ${JSON.stringify(name.slice(0, 200))}`,
      );
    }
  }
  return names.map((n) => n.replace(/^\.\//, ''));
}

/** Extracts the checked tar `plain` into `dir`, owned by whoever runs it. */
export async function extract(plain: string, dir: string): Promise<void> {
  await run('tar', [
    '-xf',
    plain,
    '-C',
    dir,
    '--no-same-owner',
    '--no-same-permissions',
  ]);
}

/** A name the manifest gives a part of the backup: one plain path segment, no `..`. */
const PART = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,200}$/)
  .refine((name) => name !== 'manifest.json');

/**
 * `manifest.json` as a backup may hold it: anyone holding the public recipient can make a backup,
 * so its names are checked before any is joined to a path.
 */
const MANIFEST = z.object({
  format: z.number(),
  runId: z.string().max(100),
  createdAt: z.string().max(100),
  database: z.object({
    migrations: z.number().int().nonnegative(),
    rows: z.record(z.string(), z.number().int().nonnegative()),
  }),
  content: z
    .object({ file: PART, refs: z.number().int().nonnegative() })
    .nullable(),
  blobs: z
    .object({ dir: PART, referenced: z.array(z.string().max(200)) })
    .nullable(),
  secretKeyFile: PART.nullable(),
});

/**
 * Unpacks the checked tar `plain` into `dir` and answers its manifest, checked: each part it names
 * is one top-level member of the archive. The instance secret key file is unpacked only with
 * `withSecretKey` (a restore): a check never writes it to disk.
 */
export async function openArchive(
  plain: string,
  dir: string,
  options: { readonly withSecretKey: boolean },
): Promise<BackupManifest> {
  const top = new Set(
    (await checkArchive(plain)).map((name) => name.split('/')[0]!),
  );
  if (!top.has('manifest.json')) throw new Error('The backup has no manifest.');
  await run('tar', [
    '-xf',
    plain,
    '-C',
    dir,
    '--no-same-owner',
    '--no-same-permissions',
    'manifest.json',
  ]);
  const parsed = MANIFEST.safeParse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  if (!parsed.success)
    throw new Error('The backup’s manifest is not one this version reads.');
  const manifest = parsed.data;
  if (manifest.format !== 1) {
    throw new Error(
      `A backup of format ${String(manifest.format)}, which this version cannot restore.`,
    );
  }
  const named = [
    manifest.content?.file,
    manifest.blobs?.dir,
    manifest.secretKeyFile ?? undefined,
  ].filter((n): n is string => n !== undefined);
  for (const name of named) {
    if (!top.has(name)) {
      throw new Error(
        `The backup’s manifest names ${JSON.stringify(name)}, which it does not hold.`,
      );
    }
  }
  const rest = [...top].filter(
    (name) =>
      name !== 'manifest.json' &&
      (options.withSecretKey || name !== manifest.secretKeyFile),
  );
  if (rest.length > 0) {
    await run('tar', [
      '-xf',
      plain,
      '-C',
      dir,
      '--no-same-owner',
      '--no-same-permissions',
      '--',
      ...rest,
    ]);
  }
  return manifest as BackupManifest;
}
