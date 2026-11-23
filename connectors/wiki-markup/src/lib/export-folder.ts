import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WikiPage } from './convert.js';

/** The front matter a page file may start with, between two `---` lines. */
const FrontMatter = z.strictObject({
  id: z.union([z.string().min(1), z.number()]).optional(),
  title: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
  order: z.number().optional(),
});

/** The largest page or attachment file read (64 MiB). */
export const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024;

export interface ExportFolder {
  readonly pages: WikiPage[];
  /** What was not read, for the person running the converter. */
  readonly skipped: string[];
}

/**
 * Reads an export folder: each `<name>.wiki` file is a page (its ID the
 * name, unless its front matter says another; its title the front
 * matter's, else the name), and the files directly inside a folder
 * `<name>/` next to it are its attachments. Pages are ordered by `order`,
 * then by file name. Links, folders inside an attachment folder and files
 * larger than `MAX_EXPORT_FILE_BYTES` are skipped and listed, never
 * followed.
 */
export async function readExportFolder(dir: string): Promise<ExportFolder> {
  const skipped: string[] = [];
  const names = (await readdir(dir)).sort();
  const pages: { order: number; file: string; page: WikiPage }[] = [];
  for (const name of names) {
    if (!name.endsWith('.wiki')) continue;
    const path = join(dir, name);
    const bytes = await readRegular(path, skipped);
    if (!bytes) continue;
    const stem = basename(name, '.wiki');
    const { front, markup } = splitFrontMatter(
      new TextDecoder().decode(bytes),
      name,
    );
    pages.push({
      page: {
        id: front.id === undefined ? stem : String(front.id),
        title: front.title ?? stem,
        markup,
        labels: front.labels,
        attachments: await readAttachments(join(dir, stem), skipped),
      },
      order: front.order ?? Number.POSITIVE_INFINITY,
      file: name,
    });
  }
  pages.sort((a, b) => a.order - b.order || (a.file < b.file ? -1 : 1));
  return {
    pages: pages.map(({ page }) => page),
    skipped,
  };
}

function splitFrontMatter(
  text: string,
  name: string,
): { front: z.output<typeof FrontMatter>; markup: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { front: FrontMatter.parse({}), markup: text };
  const parsed = FrontMatter.safeParse(parseYaml(match[1] ?? '') ?? {});
  if (!parsed.success) {
    throw new Error(
      `${name}: the front matter is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`,
    );
  }
  return { front: parsed.data, markup: text.slice(match[0].length) };
}

async function readAttachments(
  dir: string,
  skipped: string[],
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let names: string[];
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory()) return files;
    names = (await readdir(dir)).sort();
  } catch {
    return files;
  }
  for (const name of names) {
    const bytes = await readRegular(join(dir, name), skipped);
    if (bytes) files.set(name, bytes);
  }
  return files;
}

async function readRegular(
  path: string,
  skipped: string[],
): Promise<Uint8Array | undefined> {
  const stat = await lstat(path);
  if (!stat.isFile()) {
    skipped.push(`${path}: not a regular file`);
    return undefined;
  }
  if (stat.size > MAX_EXPORT_FILE_BYTES) {
    skipped.push(`${path}: larger than ${MAX_EXPORT_FILE_BYTES} bytes`);
    return undefined;
  }
  return new Uint8Array(await readFile(path));
}
