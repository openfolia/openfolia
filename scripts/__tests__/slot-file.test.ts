// The slot.json agent-slot writes and the PreToolUse hook reads: both go through
// scripts/slot-file.mjs, so a change of the layout fails here instead of locking every agent out
// of its own worktree.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { slotPaths } from '@/scripts/agent-slot-plan.mjs';
import {
  readSlots,
  serializeSlot,
  slotFileIn,
  slotWorktreeOf,
} from '@/scripts/slot-file.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('slot.json', () => {
  it('the hook reads the worktree from a file written the way agent-slot writes it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slot-file-'));
    dirs.push(root);
    const paths = slotPaths(root, 'agent-a');
    mkdirSync(paths.stackDir, { recursive: true });
    // The slot object as agent-slot's create builds it.
    const slot = {
      name: 'agent-a',
      branch: paths.branch,
      base: 'origin/main',
      worktree: paths.worktree,
      port: 3101,
      created: '2026-11-17T10:00:00.000Z',
    };
    writeFileSync(paths.slotFile, serializeSlot(slot));

    // agent-slot's path is the hook's path, and the hook's read gives the worktree back.
    expect(paths.slotFile).toBe(slotFileIn(paths.stackDir));
    expect(
      slotWorktreeOf(readFileSync(slotFileIn(paths.stackDir), 'utf8')),
    ).toBe(paths.worktree);
    expect(JSON.parse(readFileSync(paths.slotFile, 'utf8'))).toEqual(slot);
    expect(readSlots(root)).toEqual([slot]);
  });

  it('names no worktree for anything else', () => {
    for (const text of [
      '',
      'not json',
      '{}',
      '{"worktree":""}',
      '{"worktree":7}',
      'null',
    ]) {
      expect(slotWorktreeOf(text), text).toBeNull();
    }
  });
});
