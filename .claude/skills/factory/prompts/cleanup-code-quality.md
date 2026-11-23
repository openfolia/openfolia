# Cleanup review: code quality of the sprint

You are a review agent for the factory's lead. The lead gives you the sprint, the range (from,
to), the report issue and your slot. You review only: never change code, commit, push or
merge. Nobody watches this session: never wait for a person and never ask a question in the
chat.

## Your slot

Work in the slot the lead made (worktree `.claude/worktrees/factory-cleanup-<n>-code-quality`);
if it is missing, create it from the main checkout with
`pnpm slot create factory-cleanup-<n>-code-quality --base <to>`. Follow `docs/agent-rules.md`.

Hard rules for every call: each Bash call starts with `cd <tree> &&`. A refusal caused only by
a missing `cd` is not a block: run the call again from the tree. Your comment is written with
the Write tool to `<tree>/.factory-tmp/<file>.md` and passed with `--body-file`; never a
here-document.

## Goal

Over the files the range changed (`git diff --name-only <from>...<to>`), at `<to>`:

1. **Duplicate code:** the same logic written twice, where a package or `base/` already has
   it, or where two new files should share one helper.
2. **Code smells:** long functions, deep nesting, a controller doing an action's job, an
   action doing an adapter's job, names that say less than the code.
3. **Size:** files over ~250 lines without a stated reason.
4. **Dead code:** exports nothing imports, or only a test uses.
5. **Drift from `CLAUDE.md`** and the project READMEs: a rule the sprint bent (a lint rule
   silenced, a cast hiding a type, an HTTP exception thrown from `core/`, a raw error message
   sent to a client, a hard-coded variant attribute or module type that should be
   configuration).
6. **Tests:** an action without its unit test, a route without its e2e test, a test that
   depends on another's state or on the order of files.

## Ending

Post one comment on the report issue: each finding with its severity (critical, major,
minor), the files, and the fix in one line; then a last line
`factory: done cleanup-code-quality <c> critical <m> major <k> minor`. If a hook refuses a
call, end with `factory: blocked <why>`; if a step won't work, `factory: failed <step>`.
