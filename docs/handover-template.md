# Handover template

A coordinating session that runs several build agents keeps its state in a handover file, so
a new session (after a crash, a reboot or a full context) can pick up where it stopped. Keep
it **outside git and outside the session's scratchpad**, which is wiped:
`.claude/handover/handover.md` (`.claude/handover/` is git-ignored). A new session reads it
first.

Copy the headings below into the file; each line says what goes under it. Update it every
time something on it changes, not at the end.

```markdown
# Handover: <project> coordinator session (written <date>)

## Standing rules from the person

<!-- Decisions the person made that hold for every session: what may be merged without asking,
     how many agents at once, which issues are out of scope. -->

## State of the base branch

<!-- Its head commit, the newest migration (once there is a database), and whether
     `pnpm check` passed on it after the last merge. -->

## Running agents

<!-- One row per agent: name, issue(s), worktree dir, PORT, PR number once open, current step. -->

| Agent | Issues | Worktree | PORT | PR  | Step |
| ----- | ------ | -------- | ---- | --- | ---- |

## Next up

<!-- The queue, in dependency order, with the slot each will get. -->

## Decisions made

<!-- Each with the issue or PR it is recorded on. -->

## Open problems

<!-- Anything blocked or broken that the next session must know before it continues. -->
```

## Project board status

`scripts/set-project-status.sh` moves issues on a GitHub project board
(`scripts/set-project-status.sh "In progress" 12 14`), so the board shows what is being worked
on now, what is ready next, and what is in review. It needs `GH_PROJECT_OWNER` and
`GH_PROJECT_NUMBER` (`pnpm setup:board` writes them into `.claude/settings.local.json`) and
reads the repository from `gh repo view`; the status field and its options are looked up by
name.
