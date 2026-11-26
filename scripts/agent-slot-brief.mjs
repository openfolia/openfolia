// The slot-specific part of an agent's brief, printed by `agent-slot create` as a block to paste
// into the agent's prompt. A pure function a test can pin. The project's own lines (how to start
// its server, its databases) come from kit.config.json `slot.brief`, with `{name}`, `{key}`
// (the name as `slotKey` writes it), `{worktree}`, `{branch}` and `{port}` filled in.
import { readKitConfig } from '../.claude/hooks/kit-config.mjs';
import { OWN_PORT, slotKey } from './agent-slot-plan.mjs';

const { slot: slotConfig } = readKitConfig();

/** The block's lines. `slot`: `{ name, worktree, branch, base, port }`. */
export function slotBrief({ name, worktree, branch, base, port }) {
  const values = { name, key: slotKey(name), worktree, branch, port };
  const fill = (line) =>
    line.replace(/\{(name|key|worktree|branch|port)\}/g, (_, k) => values[k]);
  return [
    `----- slot brief: paste into the agent's prompt -----`,
    `Your slot "${name}" (made by node scripts/agent-slot.mjs create):`,
    `- Worktree: ${worktree}. Every Bash call starts in the main checkout: cd ${worktree} && …`,
    `- Branch: ${branch}, from ${base}; the PR targets ${base.replace(/^origin\//, '')}. Push only it: git push -u origin ${branch}`,
    `- PORT: ${port}, set in ${worktree}/.env.local (never ${OWN_PORT}, the person's own).`,
    ...slotConfig.brief.map(fill),
    '- Checks: pnpm check:changed while working, pnpm check before the PR.',
    '- Reviews: pnpm review:diff, then point /code-review and /security-review at the file it names.',
    '----- end of slot brief -----',
  ];
}
