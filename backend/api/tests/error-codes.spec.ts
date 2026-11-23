import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { collectErrorCodes, type FoundCode } from './error-codes.js';

/**
 * `error-codes.yaml` describes every error code the API raises: the docs site renders it as the
 * error code reference (`frontend/docs`), so a code without an entry would be a code nobody can
 * look up (README, "Error codes").
 */
interface Entry {
  readonly status?: number | number[];
  readonly when?: unknown;
}

const catalogueFile = join(import.meta.dirname, '../error-codes.yaml');
const catalogue = parse(readFileSync(catalogueFile, 'utf8')) as Record<
  string,
  Entry
>;
const { codes: found, unresolved } = collectErrorCodes();

const statusesOf = (entry: Entry): number[] =>
  entry.status === undefined ? [] : [entry.status].flat();

/** The entry to paste into `error-codes.yaml` for a code it lacks. */
function suggestion(
  code: string,
  { statuses, messages, places }: FoundCode,
): string {
  const status = [...statuses].sort();
  const lines = [`${code}:`];
  if (status.length === 1) lines.push(`  status: ${status[0]}`);
  if (status.length > 1) lines.push(`  status: [${status.join(', ')}]`);
  lines.push(
    `  when: ${JSON.stringify(messages[0] ?? '<what happened, for the person reading it>')}`,
  );
  return `${lines.join('\n')}\n    (raised at ${places.join(', ')})`;
}

describe('error-codes.yaml', () => {
  it('describes every error code the source raises', () => {
    const missing = [...found]
      .filter(([code]) => !Object.hasOwn(catalogue, code))
      .map(([code, at]) => suggestion(code, at));
    expect(
      missing,
      `backend/api/error-codes.yaml has no entry for these codes. Add each, in alphabetical order (status: the HTTP status, or a list; leave it out for a code reported elsewhere, such as a job's error; when: what happened, for the person reading the error):\n\n${missing.join('\n\n')}\n`,
    ).toEqual([]);
  });

  it('can read the code of every domain error the source raises', () => {
    expect(
      unresolved,
      'These places raise a domain error with a code computed at run time, so the catalogue cannot ' +
        'know it. Write the codes as literals (a literal per branch, or an `if` naming them: ' +
        "`error.code === '…'`, or `SET.has(error.code)` with SET a `new Set(['…'])` of the file):",
    ).toEqual([]);
  });

  it('names only codes the source still raises', () => {
    const stale = Object.keys(catalogue).filter((code) => !found.has(code));
    expect(
      stale,
      'backend/api/error-codes.yaml describes codes the API no longer raises: remove their entries.',
    ).toEqual([]);
  });

  it('lists every status the source answers a code with', () => {
    const wrong = [...found].flatMap(([code, { statuses, places }]) => {
      const entry = catalogue[code];
      if (!entry) return [];
      const listed = statusesOf(entry);
      const unlisted = [...statuses].filter((s) => !listed.includes(s));
      return unlisted.length > 0
        ? [
            `${code}: the source answers ${unlisted.join(', ')} (at ${places.join(', ')}); the entry lists ${listed.join(', ') || 'none'}`,
          ]
        : [];
    });
    expect(
      wrong,
      'Fix the `status` of these entries in backend/api/error-codes.yaml.',
    ).toEqual([]);
  });

  it('gives each entry a description and valid statuses, in alphabetical order', () => {
    const problems = Object.entries(catalogue).flatMap(([code, entry]) => [
      ...(typeof entry?.when === 'string' && entry.when.trim() !== ''
        ? []
        : [`${code}: no \`when\``]),
      ...statusesOf(entry ?? {})
        .filter((s) => !Number.isInteger(s) || s < 400 || s > 599)
        .map((s) => `${code}: ${s} is no error status`),
    ]);
    expect(problems).toEqual([]);
    const codes = Object.keys(catalogue);
    expect(codes, 'Keep the entries in alphabetical order.').toEqual(
      [...codes].sort((a, b) => a.localeCompare(b)),
    );
  });
});
