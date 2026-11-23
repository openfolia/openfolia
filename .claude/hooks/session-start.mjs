#!/usr/bin/env node
// SessionStart hook (.claude/settings.json): when a coordinator handover exists
// (.claude/handover/handover.md, git-ignored), tells the new
// session to read it first. Prints nothing otherwise; never fails.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The line to add to the session's context, or null. */
export function handoverNote(projectDir, exists = existsSync) {
  const file = path.join(projectDir, '.claude', 'handover', 'handover.md');
  return exists(file)
    ? `A coordinator handover exists: read ${file} first (it lists the running agents, their slots and the standing decisions), before anything else.`
    : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const note = handoverNote(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (note) process.stdout.write(`${note}\n`);
  } catch {
    // Never fail a session start.
  }
  process.exit(0);
}
