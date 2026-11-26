---
name: project-workflow
description: Use when picking up, starting, handing off or finishing a GitHub issue, opening or merging a PR, moving issues on the project board, coordinating several agents or worktrees, cutting a sprint branch, force-pushing, or resuming after a crash or a new session.
---

# Project workflow (GitHub Projects + milestones)

**In a factory run** the lead session keeps the board, notifies the person and merges;
agents work as `docs/agent-rules.md` ("In a factory session") says: their own slot only, no
questions to a person, and a refused action ends with `factory: blocked <what it needed>`.

## Board status (keep it current every turn)

`scripts/set-project-status.sh "<Status>" <issue…>` (needs `GH_PROJECT_OWNER`,
`GH_PROJECT_NUMBER`; adds the issue to the project if missing). `pnpm setup:board` makes the
board once (or fills in a field or option it lacks) and writes those two into
`.claude/settings.local.json`'s `env` (git-ignored), **never** the committed
`.claude/settings.json`. The person follows progress on the board without asking:

- **In progress:** the issue someone (you or an agent) is working on **right now**.
- **Ready:** only each agent's **next** issue, one per agent, not the whole queue.
- **In review:** its PR is open.
- **Backlog:** everything else. **Done:** merged or closed.
- [ ] Update it in the same turn as the change: an agent starts, a PR opens, a PR merges.
      **Launching an agent and setting its issue to In progress are one step, not two**: run
      `set-project-status.sh` immediately after the launch call, before anything else, every
      time; don't defer it to "after the plan comes back".

## One issue, one branch, one PR

- [ ] Read the issue and its comments (`gh issue view N --comments`): they are the spec;
      decisions in comments are binding. Check its milestone for the base branch.
- [ ] Branch from the latest base (`git fetch`), in a worktree when several sessions work at
      once (`docs/agent-rules.md`). Only an urgent hotfix without an issue goes straight to
      the main branch.
- [ ] Stage files explicitly (never `git add -A`).
- [ ] PR: `Closes #N`, what changed, defaults chosen (and the open-questions issue they were
      added to), what ran and what didn't, the review rounds, known minor points, images where
      they help (a rendered PDF page, a UI screenshot), visible on GitHub:
      `pnpm pr:assets <PR> <files>` puts them on the `pr-assets` branch and prints the
      Markdown for the body.
- [ ] Before review: `verify-before-done` skill (checks, self-check, `/code-review` until a
      round has no critical or major findings, at most 3 rounds (a non-blocking major left
      after round 3 becomes an issue named in the PR); minors listed in the PR, not fixed and
      re-reviewed). **The build agent runs its own review loop**: the coordinator doesn't run
      `/code-review` for it, so several agents can build and review at once without queuing on
      the coordinator.
- [ ] Bugs found along the way become issues in the current milestone (labels, project),
      never a silent extra in the PR.
- [ ] Issues, PRs, commits and comments stay free of organisation, client and person names;
      organisation-specific material stays in `docs/internal/` (git-ignored).

## Sprint branches (only when work is accepted per sprint)

- [ ] `main` is the current sprint's branch until that sprint is accepted. Then cut
      `sprint-<n+1>` from it: next-sprint issues branch off it and their PRs target it
      (`gh pr create --base sprint-<n+1>`; slots with
      `pnpm slot create <name> --base origin/sprint-<n+1>`); `main` only takes fixes for the
      accepted sprint, merged into the sprint branch afterwards (`git merge main` there), never the other way.
- [ ] Don't start a later sprint's issue early.
- [ ] Before a sprint branch goes into `main`, merge `main` into it and run `pnpm check`;
      once there is a database, check its migrations still sit on top of `main`'s
      (`docs/agent-rules.md`, "The database").

## Merging

In a factory run only the lead merges, one PR at a time, by
`.claude/skills/factory/merging.md`, which applies the steps below; a subagent's
`gh pr merge` is refused by the guard.

- [ ] Merge only a PR verified ready: last review round clean of critical/major and after the
      last such fix, the security review's outcome in, checks run on its final head (after
      merging the base), no conflicts, a migration (if any) on top of the base's newest.
- [ ] **A background security-review hook reports into the coordinator's session**, as a
      notification after a commit or push, not on the PR, so merge:pr's comment hold below
      can't see it. Answer every such notification in the session before merging the PR it
      concerns: fixed (pushed, checked) or why it doesn't apply, the latter also in the PR body
      (`docs/agent-rules.md`, "Security review").
- [ ] **One command does it:** `pnpm merge:pr <N> --reviewed <SHA>` (`--dry-run` first: it
      runs every check that only reads, lists what changed since the SHA the PR body names for
      `pnpm check`, and prints the steps). It stops at the first problem with what to do: the
      PR not open, a draft, conflicting, or its head not the reviewed one; open review findings,
      held by who wrote what (`docs/agent-rules.md`, "Security review", has the rules: an
      unresolved thread, another author's comment that isn't wholly an all-clear, your own
      that reads like a finding, each until a later comment by another author links it by its
      URL and says "fixed in <sha>", "not applicable", "false positive", …; a review
      requesting changes until its author approves; read again right before the merge); the
      latest base not in the head; a dirty slot. Then
      `gh pr merge --merge --match-head-commit`, the branch deleted on GitHub (unless it is
      `main` or a sprint branch), the board set to Done, the slot removed and
      `pnpm sync:main`. It ends with a note for the running agents (shared files changed;
      ready to paste), the line for the handover and the leftover worktrees. The guard refuses
      it to every subagent.
- [ ] **The local merge queue:** with `--next <M|auto>` (auto: the oldest open, non-draft PR
      on the same base with a slot here), merge:pr then prepares that PR's slot, only when it
      is idle (on the PR's branch at its head, clean, no server on its `PORT`): it merges
      `origin/<base>` into the branch there (local only; a conflict is aborted and the slot
      left as it was) and runs `pnpm check` in the background, logging to the slot's folder in
      `.claude/stacks/<name>/`. It never pushes: paste the note it prints to that agent, which
      reviews the merge diff, reads the log and pushes. A busy slot is skipped with the reason.
- [ ] After every merge (and after merging `main` into a sprint branch),
      `pnpm check:changed` runs on the updated checkout by itself once `pnpm setup:git-hooks`
      installed the post-merge hook (in the repository's own git hooks folder, shared by
      worktrees; never `core.hooksPath` on a tracked folder, which a checked-out branch could
      fill). Textually clean merges can still break the build: read its summary and hotfix at
      once if it fails, naming the two PRs that collided. A merge made on GitHub runs no local
      hook: `pnpm sync:main` fast-forwards the main checkout to it and runs the same check
      (refusing local changes or another branch), or run `pnpm check` in a worktree of the
      base yourself.
- [ ] Then check every other open PR is still conflict-free.
- [ ] Notify the person per ready (or merged) PR and per "needs attention" (conflict,
      decision); a factory run notifies only when a person is needed, through
      PushNotification. On macOS:
      `osascript -e 'display notification "PR #N: <what> is ready" with title "<project>" sound name "Glass"'`.

## Rebases and force-pushes

- [ ] A factory agent never force-pushes (the guard refuses it): it merges the base into its
      branch instead, or ends with `factory: blocked <what it needed>`.
- [ ] Before any force-push (after a rebase or an amend):
      `git branch -a --contains <old head>`: if another branch was built on it, merge the base
      in instead of rebasing, or repair that branch right after (below).
- [ ] To repair a dependent branch after a rebase: replay only its own commits,
      `git rebase --onto origin/<base> <last shared old commit>`, in a temporary worktree, and
      push with `--force-with-lease=<branch>:<old sha>`.

## Several agents at once

- [ ] At most 3–4 background agents at a time on one laptop (each runs its own installs,
      builds, test suites and API); queue the rest. Test-flake fixes go last.
- [ ] Make each agent's slot from the main checkout: `pnpm slot create <name>` (worktree on
      `agent/<name>`, `pnpm install`, the project's setup from `kit.config.json` `slot.setup`,
      its own `.env.local` and `PORT`); `pnpm slot list` shows them, `pnpm slot remove <name>`
      stops what listens on that `PORT` only, drops the slot's own databases where the
      project has them and removes the worktree (`pnpm slot prune-databases` lists those of
      slots already gone; `--yes` drops them).
      Note each slot in the handover.
- [ ] Start each agent as the `build-agent` agent type (`.claude/agents/build-agent.md`, which
      holds the standing rules and points at `docs/agent-rules.md`): the brief is its issue
      list, the slot brief `pnpm slot create` printed and notes on the parallel agents. Never
      the main checkout: the guard blocks git checkout/switch/merge/pull there for subagents
      (`pnpm sync:main` updates it); check a base branch in a worktree of it.
- [ ] Stop servers only by port (`kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`), never
      `pkill -f`; never touch the person's own server (`ownPort` in `kit.config.json`).

## Sessions and handover

- [ ] Coordinator state lives in `.claude/handover/handover.md` (git-ignored, survives crashes,
      unlike a session scratchpad), shaped like `docs/handover-template.md`. Read it first in a
      new session; update it whenever its content changes.
- [ ] Before saying something doesn't exist in the project, look (`ls`, `git log`, grep): a spec
      describes intent, not what is built.
