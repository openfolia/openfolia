// The files a slot writes into its worktree, apart from the CLI so a test can run it on a
// temporary folder.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SLOT_NX_SETTINGS, withPort, withSetting } from './agent-slot-plan.mjs';

/**
 * Sets `PORT=<port>` and the slot's Nx settings (`SLOT_NX_SETTINGS`: no Nx daemon) in the
 * worktree's own `.env.local` (made by setup-local; one without it is started from an empty file).
 * Only that file is touched: the main checkout's is never read. Returns the file's path.
 */
export function writeSlotPort(worktree, port) {
  const file = path.join(worktree, '.env.local');
  let text = withPort(existsSync(file) ? readFileSync(file, 'utf8') : '', port);
  for (const [key, value] of Object.entries(SLOT_NX_SETTINGS)) {
    text = withSetting(text, key, value);
  }
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}
