// The slot.json an agent slot keeps in its stack folder (scripts/agent-slot.mjs writes it), and
// how the PreToolUse hook (.claude/hooks/pre-tool-use.mjs) reads which worktree it belongs to.
// One module for both sides, so a change of the layout breaks a test, not every agent.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** The file's name inside `<main>/.claude/stacks/<slot>/`. */
const SLOT_FILE = 'slot.json';

/** The file's path inside a slot's stack folder. */
export function slotFileIn(stackDir) {
  return `${stackDir}/${SLOT_FILE}`;
}

/** What goes into the file. */
export function serializeSlot(slot) {
  return `${JSON.stringify(slot, null, 2)}\n`;
}

/** The worktree path a slot.json's text names, or null when it names none or isn't JSON. */
export function slotWorktreeOf(text) {
  try {
    const worktree = JSON.parse(text)?.worktree;
    return typeof worktree === 'string' && worktree !== '' ? worktree : null;
  } catch {
    return null;
  }
}

/**
 * Every slot record under `<root>/.claude/stacks/` (root: the main checkout), as written; a
 * folder without a slot.json is skipped. agent-slot, slot:db and merge:pr read the registry here.
 */
export function readSlots(root) {
  const dir = `${root}/.claude/stacks`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => slotFileIn(`${dir}/${name}`))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));
}
