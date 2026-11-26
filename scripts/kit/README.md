# The agent kit

The tooling for building with several AI agents at once: parallel agent slots, a guard that
holds every subagent to the rules, a review diff, the coordinator's merge and sync commands, the
GitHub board and backlog scripts, and the skills and agent type the sessions follow. One install,
one config file (`kit.config.json`).

| Part               | Files                                                                                     | Command                                   |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| The guard          | `.claude/hooks/`, registered in `.claude/settings.json`                                   | (runs on every tool call)                 |
| Agent slots        | `scripts/agent-slot*.mjs`, `slot-file.mjs`, `registry-lock.mjs`                           | `pnpm slot create\|remove\|list`          |
| Review diff        | `scripts/review-diff*.mjs`                                                                | `pnpm review:diff`                        |
| Merge and sync     | `scripts/merge-pr*.mjs`, `sync-main*.mjs`, `check-triage.mjs`                             | `pnpm merge:pr`, `pnpm sync:main`         |
| Checks             | `scripts/check.mjs`, `.githooks/post-merge`, `setup-git-hooks.mjs`                        | `pnpm check`, `pnpm check:changed`        |
| Board and backlog  | `scripts/board-*.mjs`, `backlog-*.mjs`, `project-status.mjs`, …                           | `pnpm setup:board`, `pnpm backlog:create` |
| PR images          | `scripts/pr-assets*.mjs`                                                                  | `pnpm pr:assets <PR> <files>`             |
| Skills, agent type | `.claude/skills/{project-workflow,verify-before-done,…}`, `.claude/agents/build-agent.md` | (read by the sessions)                    |

The full list is `scripts/kit/files.mjs`. The kit needs Node 24, pnpm, git, the GitHub CLI
(`gh`, signed in) and an Nx workspace; it adds no package dependency.

## Why copied files and one config file

The kit is plain files copied into a repository, plus one config file that repository owns. The
repository the kit comes from runs on the very same files in place, with its own
`kit.config.json`, so the two can't drift: there is no second copy to keep in step, and that
repository's tests (the guard's included) are the kit's tests. A package installed into
`node_modules` would put the guard behind an install step: a fresh clone, or a broken install,
would leave the hooks unable to load, and a hook that can't load lets every call through. Copied
into `.claude/hooks/`, the guard is there with the first checkout.

The source repository keeps itself honest with two checks: `scripts/__tests__/kit.test.ts`
(every listed file exists, the kit's files import only each other, they name nothing of that
project, its package.json scripts and .gitignore are the kit's) and the smoke test (below).

## Install

From a checkout of the kit's repository:

```sh
node <kit checkout>/scripts/kit/install.mjs <your repository>
```

It copies the kit's files over your repository's copies, writes `kit.config.json` with every
default when there is none (never overwrites it), merges the guard's hooks and the kit's
permissions into `.claude/settings.json` (your own hooks and settings stay), adds the kit's
package.json scripts you lack (it names any you have with another command and leaves them), adds
the `.gitignore` lines the kit's local state needs, and writes a starter `docs/agent-rules.md`
when there is none. Then fill in the config file, fill in `docs/agent-rules.md`, review the diff
and commit. To update, run it again: it changes only the kit's own files.

`pnpm setup:git-hooks` (once per clone) installs the post-merge check; `pnpm setup:board`
(once) makes the GitHub project board.

## The config file

`kit.config.json` at the repository root. A key left out takes its default; an unknown key or a
value of the wrong shape stops the scripts with what is wrong. The guard hooks read it too, and
fall back to the defaults when it can't be used, so a typo never switches the guard off.

| Key                    | Default                              | What reads it                                                                                                                                           |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mainBranch`           | `"main"`                             | The guard (no subagent pushes it, nor any `sprint-*`), the default base of slots, `review:diff` and `sync:main`.                                        |
| `ownPort`              | `3100`                               | The person's own server's port: slots never take it and get the 100 after it.                                                                           |
| `check`                | one run: `test lint typecheck build` | `pnpm check` / `check:changed`: the Nx runs, in order (below).                                                                                          |
| `slot.setup`           | `null`                               | A command (a list of words) `slot create` runs in the new worktree after the install: its `.env.local`, sample data.                                    |
| `slot.brief`           | `[]`                                 | Lines added to the slot brief (how to start the project's server, its databases), with `{name}`, `{key}`, `{worktree}`, `{branch}`, `{port}` filled in. |
| `slot.bucketScript`    | `null`                               | A script `slot remove` runs as `node <script> drop <worktree>` to delete the slot's storage bucket.                                                     |
| `slot.databasesScript` | `null`                               | A script `slot remove` runs as `node <script> drop <name> --settings <worktree>/.env.local` (and `slot prune-databases` as `… prune [--yes]`).          |

A `check` run is `{ "targets": [...], "output": "static-failures-only" | "static", "affectedEnv":
"<PREFIX>" }`: `nx run-many|affected -t <targets>` with that output style; in affected mode a run
with `affectedEnv` also gets `<PREFIX>_SELECT=affected`, `<PREFIX>_BASE` and `<PREFIX>_HEAD`, for
a runner that picks its own cases (browser flows) by the change. For example:

```json
{
  "mainBranch": "main",
  "check": [
    {
      "targets": ["test", "lint", "typecheck", "build"],
      "output": "static-failures-only"
    },
    { "targets": ["e2e"], "output": "static", "affectedEnv": "E2E" }
  ],
  "slot": {
    "setup": ["pnpm", "nx", "run", "app:setup-local"],
    "brief": [
      "- Server: cd {worktree} && pnpm nx run app:serve (http://127.0.0.1:{port})."
    ]
  }
}
```

What stays fixed, since the scripts and skills read it by name: the worktrees under
`.claude/worktrees/<name>` on `agent/<name>`, the slot records in `.claude/stacks/`, the
handover file `.claude/handover/handover.md`, the board's fields and options (Status: Backlog,
Ready, In progress, In review, Done; Priority P0–P2; Size XS–XL; Model Opus and Sonnet, with
the model per size in `.claude/skills/factory/models.md`), the `triage:*` labels, and the
`pr-assets` branch (the one ref a subagent may write past the push rule, so no config file a
worktree holds can point it elsewhere).

## The coordinator's flow

1. **Plan:** the backlog file (the `requirements-to-backlog` skill), then
   `pnpm backlog:create <file>`: milestones, labels, issues and their board fields.
2. **Start an agent:** `pnpm slot create <name>` from the main checkout, then the Agent tool
   with the `build-agent` type and a brief of its issue, the slot brief the command printed and
   notes on the parallel agents. Set the issue to In progress on the board in the same step.
3. **The agent** works only in its slot, runs its own review loop on `pnpm review:diff`'s file,
   runs `pnpm check`, opens the PR naming the SHA it checked, and reports.
4. **Merge:** `pnpm merge:pr <N> --reviewed <SHA> --dry-run`, then without `--dry-run`. It holds
   a PR with open review findings or a head that isn't the reviewed one, merges, deletes the
   branch, sets the board, removes the slot and runs `pnpm sync:main`; it prints the note for
   the running agents and the handover line. `--next auto` prepares the next PR's idle slot.
5. **Keep state** in the handover file (`docs/handover-template.md`), so a new session picks up
   where the last stopped; the session-start hook points every new session at it.

A factory run (`.claude/skills/factory/`) does the same without the person between the gates.

## The agent rules

The project's own rulebook is `docs/agent-rules.md` (its conventions, its "Security-sensitive
areas", its "Project checks"); the kit's skills and `build-agent` read it. The kit's rules, which
the guard holds for every subagent where it can:

- **One slot each.** Every Bash call starts with `cd <worktree> && …`; never work in, or
  change, the main checkout. A server only on the slot's `PORT`, stopped by its port, never
  `pkill -f`.
- **Push only your own branch, by name**, from inside your worktree: never another branch, the
  main branch or a `sprint-*`, never force, never delete.
- **Never merge,** never `merge:pr` or `sync:main`: the coordinator does.
- **No secrets:** never read or write `.env` / `.env.local`; a new variable goes into
  `.env.example`.
- **No `git stash`** (shared by every worktree); no here-document bodies for PRs or comments
  (write the body to `<worktree>/.factory-tmp/<file>.md`, pass `--body-file`).
- **The review loop is yours:** `pnpm review:diff`, then a code review and a security review on
  `.review/diff.patch` until a round has no critical or major finding (at most 3 rounds for
  code, the security review never capped); minors listed in the PR.
- **Finish:** `pnpm check` on the final head after merging the base, a PR that says
  `Closes #N`, what ran, the review outcomes and a line naming `pnpm check` with the SHA it ran
  on (`merge:pr` reads it).

The guard is a guard-rail against mistakes made in good faith, not a sandbox: what it can't
tell, it refuses.

## The smoke test

`scripts/kit/smoke.mjs` (`pnpm nx run workflow:kit-smoke`, and part of `nx test workflow` in the
kit's repository) installs the kit into an empty Nx + pnpm repository in a temporary folder with
a local `origin`, runs `pnpm slot create`, `pnpm review:diff` and `pnpm merge:pr --dry-run`
against a stub `gh`, then runs the guard's own tests on the installed copy of the hooks. It needs
no network.
