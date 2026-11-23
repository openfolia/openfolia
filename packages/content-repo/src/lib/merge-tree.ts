import { GitError } from './git.js';

/** A path a merge could not combine, with what kind of conflict git found. */
export interface MergeConflict {
  /**
   * As git lists it: for a file/directory conflict git may name a path of
   * its own making next to the folder (`<path>~<commit>`).
   */
  readonly path: string;
  /**
   * The conflict types git names for the path (`contents`,
   * `modify/delete`, `add/add`, `rename/delete`, `file/directory`,
   * `binary`, …), as git spells them; empty when git gave none.
   */
  readonly kinds: readonly string[];
}

/** What `git merge-tree --write-tree -z --name-only` printed. */
export interface MergeTreeOutput {
  readonly tree: string;
  /** Empty for a clean merge. */
  readonly conflicts: readonly MergeConflict[];
}

/**
 * Parses the output of `git merge-tree --write-tree -z --name-only`: the
 * tree, and for a merge with conflicts (`conflicted`: exit status 1) the
 * conflicted paths, then an empty field, then the messages, each
 * `<count>\0<path>…\0<type>\0<text>\0`. The paths are what decides; the
 * messages only add the conflict types (and are skipped where they do not
 * parse, never guessed from their text).
 */
export function parseMergeTree(
  out: string,
  conflicted: boolean,
): MergeTreeOutput {
  const fields = out.split('\0');
  const tree = fields[0]?.trim() ?? '';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
    throw new GitError(`unexpected git merge-tree output: "${tree}"`);
  }
  if (!conflicted) return { tree, conflicts: [] };
  let i = 1;
  const paths: string[] = [];
  while (i < fields.length && fields[i] !== '') paths.push(fields[i++] ?? '');
  if (paths.length === 0) {
    throw new GitError('git merge-tree reported conflicts but listed no path');
  }
  const kinds = new Map(paths.map((p) => [p, new Set<string>()]));
  i++; // the empty field ending the paths
  while (i < fields.length) {
    const count = Number(fields[i]);
    if (!Number.isInteger(count) || count < 1) break;
    const named = fields.slice(i + 1, i + 1 + count);
    const type = fields[i + 1 + count];
    i += count + 3;
    const kind = /^CONFLICT \((.+)\)$/.exec(type ?? '')?.[1];
    if (!kind) continue;
    for (const path of named) kinds.get(path)?.add(kind);
  }
  return {
    tree,
    conflicts: paths.map((path) => ({
      path,
      kinds: [...(kinds.get(path) ?? [])],
    })),
  };
}
