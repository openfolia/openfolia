// The slot-specific part of an agent's brief, printed by `agent-slot create` as a block to paste
// into the agent's prompt. A pure function a test can pin.
import { apiDatabaseName } from './slot-databases-plan.mjs';

/** The block's lines. `slot`: `{ name, worktree, branch, base, port }`. */
export function slotBrief({ name, worktree, branch, base, port }) {
  return [
    `----- slot brief: paste into the agent's prompt -----`,
    `Your slot "${name}" (made by node scripts/agent-slot.mjs create):`,
    `- Worktree: ${worktree}. Every Bash call starts in the main checkout: cd ${worktree} && …`,
    `- Branch: ${branch}, from ${base}; the PR targets ${base.replace(/^origin\//, '')}. Push only it: git push -u origin ${branch}`,
    `- PORT: ${port}, the API's, set in ${worktree}/.env.local (never 3100, the person's own).`,
    `- API: cd ${worktree} && pnpm nx run api:serve-local (reads that .env.local; http://127.0.0.1:${port}/docs).`,
    '- Checks: pnpm check:changed while working, pnpm check before the PR. Database tests run in memory in the test process: nothing to start.',
    `- Databases: serve-local uses the slot's own (${apiDatabaseName(name)}, made by setup-local). A throwaway database you make (a test's) you drop yourself; a perf benchmark run drops its profile's unless --keep; pnpm slot remove drops the slot's own.`,
    '- Reviews: pnpm review:diff, then point /code-review and /security-review at the file it names.',
    '----- end of slot brief -----',
  ];
}
