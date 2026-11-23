import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeSlotPort } from '@/scripts/agent-slot-files.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function worktree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-slot-files-'));
  dirs.push(dir);
  return dir;
}

describe('writeSlotPort', () => {
  it('sets PORT in the worktree`s own .env.local and keeps its other settings', () => {
    const dir = worktree();
    writeFileSync(
      path.join(dir, '.env.local'),
      'CCMS_API_TOKEN=abc\nPORT=3100\n',
    );
    const file = writeSlotPort(dir, 3104);
    expect(file).toBe(path.join(dir, '.env.local'));
    expect(readFileSync(file, 'utf8')).toBe(
      'CCMS_API_TOKEN=abc\nPORT=3104\nNX_DAEMON=false\n',
    );
  });

  it('turns the Nx daemon off, once, however often it runs (#615)', () => {
    const dir = worktree();
    writeFileSync(path.join(dir, '.env.local'), 'NX_DAEMON=true\nPORT=1\n');
    writeSlotPort(dir, 3102);
    const file = writeSlotPort(dir, 3102);
    expect(readFileSync(file, 'utf8')).toBe('NX_DAEMON=false\nPORT=3102\n');
  });

  it('starts an empty file when setup made none, readable by the owner only', () => {
    const dir = worktree();
    const file = writeSlotPort(dir, 3101);
    expect(readFileSync(file, 'utf8')).toBe('PORT=3101\nNX_DAEMON=false\n');
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});
