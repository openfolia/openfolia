import { describe, expect, it } from 'vitest';

import { slotBrief } from '@/scripts/agent-slot-brief.mjs';

const slot = {
  name: 'agent-a',
  worktree: '/repo/.claude/worktrees/agent-a',
  branch: 'agent/agent-a',
  base: 'origin/main',
  port: 3101,
};

describe('slotBrief', () => {
  const text = slotBrief(slot).join('\n');

  it('names the worktree, branch, base, PORT and the commands', () => {
    expect(text).toContain(`Worktree: ${slot.worktree}`);
    expect(text).toContain(
      'Branch: agent/agent-a, from origin/main; the PR targets main',
    );
    expect(text).toContain('PORT: 3101');
    expect(text).toContain('pnpm nx run api:serve-local');
    expect(text).toContain('http://127.0.0.1:3101/docs');
    for (const command of [
      'pnpm check:changed',
      'pnpm check',
      'pnpm review:diff',
    ]) {
      expect(text).toContain(command);
    }
  });

  it('names the slot`s database and who drops a throwaway one', () => {
    expect(text).toContain('ccms_agent_a');
    expect(text).toMatch(/throwaway database you make .* you drop yourself/);
    expect(text).toContain('unless --keep');
    expect(text).toContain("pnpm slot remove drops the slot's own");
  });

  it('is a block with a start and an end line', () => {
    const lines = slotBrief(slot);
    expect(lines[0]).toMatch(/^----- slot brief/);
    expect(lines.at(-1)).toMatch(/^----- end of slot brief/);
  });

  it('mentions nothing of a database stack', () => {
    expect(text).not.toMatch(/supabase|docker|migration/i);
  });
});
