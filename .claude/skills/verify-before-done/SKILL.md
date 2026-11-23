---
name: verify-before-done
description: Use when about to say a change is done, fixed or ready, before committing or opening a PR, and whenever a code review is run on your work. Covers the checks to run, the self-check of risky areas, the review loop and its stop rule, and what to report.
---

# Verify before done

Evidence before claims: never say "done", "passes" or "ready" without the command output from
this session.

**The review loop (section 4) is yours to run**, whether you're a factory agent or a build
agent in a manual coordinator session: run `/code-review` yourself and iterate until a round is
clean, rather than stopping for the coordinator to run it. That's what lets several agents
build and review at once without queuing on the coordinator.

**In a factory session** (`docs/agent-rules.md`, "In a factory session") every other step below
also finishes without a person: the report (section 5) is the PR body plus a comment on the
issue ending in the status line the factory prompts define (`factory: done #<pr>`,
`factory: blocked <what it needed>` when something was refused, or `factory: failed <step>`).

## 1. Completeness (before running anything)

- [ ] Every new `process.env.*` read (or configuration schema entry) is in `.env.example` with
      a comment: what it is for, its format, range and default.
- [ ] New behaviour is an action in `core/actions/` with its unit test against an in-memory
      fake; a new or changed route has its end-to-end test.
- [ ] Every new response has its Zod schema in the resource (so it is in the generated OpenAPI
      and the tests check responses against it); every new error has a stable `code` and is
      mapped from a domain error.
- [ ] Every list you added or touched is paged (`page[number]`/`page[size]`, `meta.page`,
      `links`), even a short one. In a UI: rows scroll inside their own container, pagination
      outside it, long values wrap; fix an existing list you touch in this change.
- [ ] **The editor's browser flows** (`frontend/editor-e2e/README.md`): a new or changed
      screen feature adds or extends a flow in `frontend/editor-e2e/specs/` (its main path and
      an error path, tagged with the areas and API components it covers); an editor bug fix
      starts with an e2e flow or a spec test that fails before the fix. The PR names the flows
      it added or changed.
- [ ] Once there is a database: a schema change has its drizzle-kit migration committed, one
      per issue, on top of the base's newest.
- [ ] Nothing organisation-specific (names of an organisation, client or person) in code,
      tests, fixtures, commits or the PR.
- [ ] Images for the PR where they help (a rendered PDF page for a template or renderer
      change, a screenshot for a UI change): once the PR is open (after the review loop),
      `pnpm pr:assets <PR> <files>` (or `--dir <dir>`; `--dry-run` first) uploads them to the
      `pr-assets` branch as one commit through GitHub's API (no git push, so a build agent may
      run it; that one ref only, never force, images only) and prints the Markdown image links
      for the PR body, pinned to that commit.

## 2. Self-check the risky areas (before review round 1)

Read your own diff for these first; they cause most review rounds:

- [ ] **The `core/` boundary:** no HTTP, Nest HTTP exceptions, configuration, Git, renderer or
      database import in `core/` (lint holds it; don't silence the rule); the action throws a
      domain error, the API maps it.
- [ ] **JSON:API shape:** media type exact, camelCase attributes, `id`/`type` not reused as
      attribute names, an unsupported query parameter a 400, errors as error objects on every
      route including binary ones.
- [ ] **Git and refs:** reads pinned to the commit they resolved (`X-Ccms-Commit`); a write
      moves a ref only by compare-and-swap; a path from a request never leaves the repository.
- [ ] **Concurrency and shutdown:** a job with a deadline, a queue with a bound, nothing that
      blocks the event loop; resources released on failure and on shutdown.
- [ ] **Tests that assume a clean state:** each test makes and asserts on its own fixtures
      (its own sample repository, its own PGlite database); no order between test files.
- [ ] Security: no token or personal data in logs, errors or the audit log; every new route
      behind the token guard unless it is deliberately public; the areas listed in
      `docs/agent-rules.md`, "Security-sensitive areas".

## 3. Run the checks

- [ ] Fix-and-retry rounds (after a failing check or a review's findings):
      `pnpm check:changed` (`nx affected -t test lint typecheck build`, then `-t e2e` with only the
      browser flows the change touches, then `-t perf`: only the projects the
      branch changed and those depending on them), or a single target
      (`pnpm nx test api`, `pnpm nx lint api`). It never replaces the full run below before the
      PR.
- [ ] `pnpm check` (`nx run-many -t test lint typecheck build`, then `-t e2e`, every browser
      flow, then `-t perf`: every project) on the final
      head, after merging the base. Prettier on the files you changed:
      `pnpm prettier --check <files>`.
- [ ] One flow while you work: `pnpm nx run editor-e2e:e2e -- specs/<area>.spec.ts`; a
      failure's trace, screenshot and console are under `.local/editor-e2e/results/`.
- [ ] Trying the API by hand: `pnpm nx run api:serve-local` from your worktree, on your slot's
      `PORT`; stop it by its port, never `pkill -f`.

## 4. Review loop

- [ ] Run `/code-review` on the branch's diff against its base, yourself (see above), pointed
      at the file `pnpm review:diff` writes. Review level for round 1: `xhigh` only when the
      change is load-bearing (`docs/agent-rules.md`, "Security-sensitive areas", the hooks or
      coordinator scripts, a large new module); `high` otherwise. Later rounds on the fix diff:
      `medium`.
- [ ] Fix every **critical** and **major** finding, re-run the checks, review again.
- [ ] **Stop at the first round with no critical or major findings.** After any critical or
      major fix there is always one more round. Later rounds review only the diff since the
      previous round.
- [ ] **At most 3 rounds.** A major still open after round 3 becomes an issue in the current
      milestone, listed in the PR under "Known major points". Except the blocking kinds,
      which are fixed whatever the round count: security, access or permission mistakes, data
      loss and a broken migration. Criticals are always blocking. `/security-review` is not
      capped.
- [ ] Minor findings are not fixed in the loop and start no new round: list them in the PR
      under "Known minor points" (or file an issue). A trivial typo or comment fix is fine.
- [ ] Decline a finding that only matters for pre-existing data while the project has no
      production deployment holding real data, and say why.
- [ ] A bug outside the change is filed as an issue in the current milestone, not fixed here.
- [ ] `/security-review` on the same diff file before opening the PR (`docs/agent-rules.md`,
      "Security review").

## 5. Report

- [ ] The browser flows the change added or changed (by spec file and test name).
- [ ] Which checks ran and their result (with the SHA `pnpm check` ran on), which didn't run
      and why, the review rounds and their outcome, the security review's outcome, known minor
      points, defaults chosen for open questions (and the open-questions issue they were added
      to).
