# Rules for parallel build agents

When a coordinating session hands issues to several build agents working at the same time,
start each as the `build-agent` agent type (`.claude/agents/build-agent.md`: it holds the
standing rules once and points here), with a brief of only:

- its issue list (in order) and the issues the parallel agents are working on;
- the **slot brief** that `pnpm slot create <name>` (below) printed.

Keep the slots in a handover file (see [handover-template.md](handover-template.md)) so a
new coordinator session can pick up where the last one stopped.

For the person following the run, start the working board (`/board`, `.claude/skills/board/`): a
local page with what needs them, their questions, the lanes, progress, timings and review
findings, where they answer and send requests. Ask each agent to end its report with its review
findings, one line each (`severity | kind | outcome | round | summary`), and record them on the
board, so a kind that keeps coming back becomes a rule, a check or a prompt line (proposed
in `docs/internal/workflow-improvements.md`, the board skill's "After a merge").

## Read first

- `CLAUDE.md`: all of it, then the `README.md` of every project the issue touches
  (`backend/api/README.md` for the API: its JSON:API conventions and its hexagonal layout;
  `packages/*/README.md` where they exist).
- The skills for the task (`.claude/skills/`): always `verify-before-done` and
  `project-workflow`.
- Each issue with its comments (`gh issue view N --comments`). **The issue and its comments
  are the spec; decisions recorded in comments are binding.** Open questions go where the
  project collects them (an open-questions issue), not only into the PR.
- While the project has no production deployment holding real data: no back-fills or "data from
  before this change" handling, and review findings that only matter for pre-existing data are
  declined with that reason.
- Organisation-specific material lives only in `docs/internal/` (git-ignored). Read it when
  the issue points there; never copy organisation, client or person names from it into code,
  tests, commits, issues or PRs, and never commit it.

## Setup

- **Base branch:** check the issue's milestone and branch off the branch that milestone
  targets (`origin/main` unless the project says otherwise); the PR targets the same branch.
- **The slot:** from the main checkout, `pnpm slot create <name>` (`node scripts/agent-slot.mjs`;
  `--base <ref>` or `BASE_BRANCH` for another base). It makes the worktree
  `.claude/worktrees/<name>` on `agent/<name>` (from the branch on GitHub when it is already
  there, else from the base), runs `pnpm install`, makes the worktree's own `.env.local` and
  `.local/sample-content.git` (`backend/api/scripts/setup-local.ts`) with its own `PORT` (3101 and
  up; 3100 is the person's) and `NX_DAEMON=false` (#615: in a worktree the Nx daemon sees no
  edit, so it would hash tasks as the files were when it started; `pnpm check` turns it off in
  any worktree too), records the slot in `.claude/stacks/<name>/slot.json` and prints a
  **slot brief**, a block the coordinator pastes into the agent's prompt (worktree, branch,
  base, `PORT`, the commands). It warns (never refuses) when the machine is already loaded.
  `pnpm slot list` shows the slots; `pnpm slot remove <name>` stops only what listens on that
  slot's `PORT`, drops the slot's own databases (below) and removes the worktree
  (`--dry-run` says which databases it would drop and changes nothing). After merging a base
  that changed the lockfile, run `pnpm install` in the worktree.
- **No database stack per slot.** Tests that need a database run on in-memory Postgres
  (PGlite) inside the test process: nothing to start, nothing shared between slots. Only
  `serve-local` needs Postgres: the shared compose one (`docker compose up -d`, started by the
  person), in which `setup-local` makes the slot its own database (`ccms_<slot>`, the slot's
  name with each run of `-` turned into `_`); run `pnpm nx run api:setup-local` again if Postgres was down
  when the slot was made.
- **Throwaway databases are dropped by whoever made them.** A test that makes a database on a
  real Postgres drops it itself (a unique name of its own, never another's); a perf benchmark
  run drops its profile's database when it ends (`--keep` keeps it); `pnpm slot remove` drops
  the slot's own (`ccms_<slot>`, `ccms_perf_<slot>_<profile>`: exactly the names derived from
  that slot's name, never `ccms`, `postgres`, a template or another live slot's). A database
  with open connections is never forced: it stays, with a note. Leftovers of slots that are
  gone: `pnpm slot prune-databases` lists them, `--yes` drops those this checkout's tooling
  marked as its own (a comment on the database); others of the same shape (older, made by hand,
  another clone's) are only listed.
- **The API:** `pnpm nx run api:serve-local` from the worktree (it builds and reads the
  worktree's `.env.local`, so it listens on the slot's `PORT`). Never port 3100 or the
  person's own server. Stop servers only by port (`kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`),
  never `pkill -f`; stop yours once the PR is open.
- **Secrets:** never read or write `.env` or `.env.local` by hand (the guard refuses it): the
  slot made yours, and the API reads it. A value a task needs (a real token, a real content
  repository) is read at run time, never written into a file.

## How to work

- **The architecture** (`backend/api/README.md`, "Structure"): `api/` holds controllers and
  JSON:API resources, `core/` the actions (one use case each, a `handle()` method), the ports
  (abstract classes) and the domain errors, `repos/` the adapters, `base/` what is shared.
  New behaviour is a new action with its unit test against an in-memory fake; `core/` never
  imports HTTP, Nest's HTTP exceptions, configuration, Git, the renderer or the database (a
  lint rule holds it). A route gets its end-to-end test (supertest, against the full app).
- **JSON:API:** the media type exact (`application/vnd.api+json`); attributes in camelCase;
  every list paged with `page[number]`/`page[size]` and `meta.page` plus `links`, even a short
  one; errors as JSON:API error objects with a stable `code` (kebab-case, never a message
  text), mapped from domain errors in one place. A response is a Zod schema in its resource:
  it documents the route in the generated OpenAPI and the tests check every response against
  it.
- **Environment variables:** every new `process.env.*` read (or entry in a configuration
  schema) also goes into `.env.example` in the same change, with a comment: what it is for, its
  format, range and default.
- **Texts in a UI:** every text a person reads is a translation key from the start, in English
  and German (`frontend/ui/README.md`, "Internationalisation"): templates use the `transloco`
  pipe, code `injectTranslate()` or `translated()`, toasts and API errors included. Dates and
  numbers go through `Intl`. Lint and the translation tests refuse literal text, a key missing
  in a language and an unused key.
- **The editor's browser flows** (`frontend/editor-e2e/`, its README): Playwright on the built
  editor against the real API, in `pnpm check` (and the flows a change touches in
  `pnpm check:changed`). Every new or changed screen feature adds or extends a flow there (its
  main path and an error path, tagged with the editor areas and API components it covers).
  Every editor bug fix starts with an e2e flow or a spec test that **fails before the fix**,
  and the PR says which. The PR names the flows it added or changed. A bug the flows find
  outside your issue is filed, and its flow is marked `test.fail(true, '#<issue>: …')` until
  the fix lands.
- **Lists in a UI** (once there is one): rows scroll inside their own container, capped to the
  remaining viewport height, with the pagination outside that container and always visible;
  long values wrap instead of widening the page.
- **The database** (once it arrives): Drizzle, with drizzle-kit migrations committed. One issue,
  one migration; never edit a merged one. When the base gained a migration after you
  generated yours, merge the base, delete your unmerged migration (and its snapshot and
  journal entry) and generate it again on top, so the migration chain stays linear. Tests run
  on PGlite. A migration that changes an existing table is Opus work.
- **Shared value lists** (enums, error codes, audit actions, workflow states): after merging
  the base, keep the union of the base's values and yours, in every place that lists them.
- **The docs inventory** (`docs/features.md`): a change that adds or changes something a person,
  an operator or an integrator would need explained adds or updates its line there, in its
  area's section. Write the feature in plain words, then its audience, the PR or issue number,
  and the guide page it belongs on. Mark a line `(generated)` when a generated reference (the
  API, the settings, the permissions, the shortcuts) covers it fully. The PR's "Docs" section
  names the line, or says "none" and why.
- **One PR per issue**, from the latest base branch, in the given order. Stack on your
  previous branch only if the issue depends on it, and say so in the PR.
- **The machine is shared:** run the affected projects' tests while iterating
  (`pnpm check:changed`, or `pnpm nx test <project>`) and the full `pnpm check` once per PR, at
  the end.
- **Bugs outside your issue:** file them as issues in the current milestone and carry on;
  don't widen the PR.

## Review loop (required)

- **You run this loop yourself** (Sonnet and Opus agents alike), not the coordinator: that's
  what lets several agents build and review in parallel without queuing on the coordinator's
  own `/code-review` calls. The coordinator still does the plan review (before you write code)
  and reads your final diff before merging.
- Run a code review (`/code-review`, or a reviewer agent on the diff file below) until one
  round has **no critical or major** findings; after fixing a critical or major one there is
  always another round, and later rounds review only the diff since the last
  (`verify-before-done` skill, which also lists the risky areas to self-check before round 1).
- **At most 3 rounds.** A major finding still open after round 3 becomes an issue in the
  current milestone and is named in the PR ("Known major points"), so later rounds don't polish
  code that is already good enough. Blocking kinds are the exception: security, access or
  permission mistakes, data loss (a lost or overwritten Git write, a broken migration) are fixed
  and reviewed again however many rounds it takes. `/security-review` is never capped.
- **Default: a reviewer agent on the diff file.** In a slot, the `/code-review` and
  `/security-review` skills have repeatedly resolved against the main checkout and reviewed an
  empty or unrelated diff. So by default, run `pnpm review:diff`, then start a reviewer
  subagent (the Agent tool) with the path of `.review/diff.patch` (or, for later rounds, a
  file holding `git diff <last reviewed head>..HEAD`), the review level, the risky areas below
  and, for the security pass, "Security-sensitive areas". Use a skill only if its summary
  names your files.
- **Name your target explicitly:** run `pnpm review:diff` in your worktree and point the
  review at the file it writes (`.review/diff.patch`, git-ignored: the branch's diff against
  the merge-base with its base, plus untracked new files), or pass your branch
  (`/code-review agent/<name>`) or an explicit
  `git -C <your worktree> diff origin/main...HEAD`. An unscoped `/code-review` run from a
  worktree can resolve against the wrong checkout and silently review an empty or unrelated
  diff (a "clean" round that reviewed nothing is worse than no round at all); always check the
  round's own summary names the commits or files you expect before trusting a clean result.
- **Review levels:** `xhigh` for round 1 only when the change is load-bearing (an area from
  "Security-sensitive areas" below, the hooks or the coordinator scripts, a large new module);
  `high` for round 1 otherwise; `medium` on the fix diff in later rounds regardless. Don't
  default to `xhigh`: it's the costly level, reserved for where a missed finding is
  irreversible or silent.
- **Stop at the first round with no critical or major findings.** Minor findings aren't fixed
  in the loop and don't start another round: list them in the PR under "Known minor points"
  (a trivial typo or comment fix is fine).

### Security-sensitive areas

Authentication and tokens (anything that reads, stores, compares or logs one); roles,
permissions and policies; Git write paths (refs, commits, compare-and-swap on a ref); workflow
transitions and approvals; the audit log; migrations that change existing tables; template and
PDF sandboxing (what a Typst template can read or fetch). A change here gets `xhigh` in
round 1, is Opus work (`.claude/skills/factory/models.md`) and gets particular scrutiny in the
security review.

## Security review (required, every feature)

- Run a security review on your own diff before opening the PR, not just a code review: a
  reviewer agent on `.review/diff.patch` with "Security-sensitive areas" as its brief (see
  "Default: a reviewer agent on the diff file" above), or `/security-review` if its summary
  names your files. A
  background security-review hook, where one is set up, scans commits and pushes, but it is
  advisory and asynchronous: it can report well after a PR is already merged, which is too
  late. Your own synchronous run is the real gate.
- **Where a background hook reports:** into the coordinator's Claude session, as a
  notification after a commit or push, not on the PR. So `pnpm merge:pr`'s hold on PR
  comments (below) never sees it. The coordinator answers each such notification in its
  session before merging the PR it concerns: fixed (the agent's fix pushed and checked), or why
  it doesn't apply, said in the session and in the PR body. A notification still open holds
  the merge like an open PR finding.
- **`/security-review` has the same unscoped-run risk as `/code-review`:** its own
  context-gathering can resolve against the main checkout instead of the invoking worktree,
  even when called from inside the worktree. So run `pnpm review:diff` in your worktree first
  and tell `/security-review` to review only the file it writes (`.review/diff.patch`; the
  command prints the exact wording and the files to expect). If its summary still doesn't name
  those files, don't trust a "clean" result: fall back to a manual review of that file against
  the risky shapes below, note in the PR that you did so, and say so in your report so the
  coordinator knows the automated gate didn't run.
- Findings left on the PR (a review thread or a comment, by a person or another reviewer) are
  yours to answer too: fix, or reply exactly why one doesn't apply and resolve the thread;
  answer a comment with a PR comment that links it by its URL (GitHub's "Copy link").
  `pnpm merge:pr` holds a PR fail-closed by who wrote what, not by a word list: an unresolved
  thread holds; a comment or review summary by anyone but gh's own login (the shared login the
  agents post under) and the PR's author holds unless it is wholly an all-clear (a "no
  findings", or a short approval: "LGTM", "looks good", "approved", 👍; "LGTM, but …" is no
  all-clear); your own comments hold only when they read like a finding (security and access
  words: policy, bypass, IDOR, leak, token, traversal, race/TOCTOU, DoS, rate limit,
  enumeration, CORS, SSRF, deserialization, sandbox, escape, unsafe, …; or a finding's shape: a
  severity label from Low to Critical, "anyone", "never checks", a missing role check, "do not
  merge", "blocker", data loss). A held comment is answered by a later comment from another
  author that links its URL and says it is fixed or doesn't apply, in one of these words:
  "fixed in <sha>", "resolved in <sha>" (a 7–40 character hex SHA with a letter in it), "fixed
  by <sha | #PR | URL>", "not applicable", "doesn't apply", "false positive" or "by design"
  ("<url> fixed in 3f9e2a1c", "<url> false positive: the route is behind the token guard"); a
  held review by one that names its id the same way. Anything else answers nothing: an
  acknowledgement ("good catch, will fix", "+1", "fix pending", "won't fix"), a reply that
  quotes it, says it is still open ("not fixed", "still", "also", "but", "separately"), or has a
  finding's shape itself; the last linking reply decides. A review requesting changes holds
  until its author approves. merge:pr reads all of it again right before it merges. Keep your
  own PR comments free of findings and your replies free of finding words: a security note you
  post yourself holds the merge too.
- Fix every finding it raises, or state in the PR exactly why it doesn't apply (a design
  decision it missed, a control that already exists elsewhere: name it). Never silently drop
  a finding.
- Shapes that slip past a diff-scoped `/code-review` and have caused real, merged bugs before:
  a non-idempotent external write retried on a transient failure; a credential check that
  can't tell a transient error (network, database, Git lock) from a genuine refusal; an
  unattended background sweep with no rate-limit or timeout plan; a Git ref moved without
  compare-and-swap; a path from a request reaching the file system or a template unchecked.
  Code that makes an outside call, holds a credential, retries, writes to Git or runs
  unattended gets particular scrutiny here.

## Finish

- Prettier only on files you created or changed (`pnpm prettier --write <files>`). Stage files
  explicitly (never `git add -A`).
- On the final head, after merging the base branch: `pnpm check` (test, lint, typecheck and
  build of every project, then the editor's browser flows and the speed criteria). Say what
  couldn't run, and for the browser flows their run time and the load average the summary
  printed.
- Commit messages and the PR body end with the attribution lines the session gives you. PR
  body: "Closes #N", what changed, the defaults chosen, what ran and what didn't (with a line
  naming `pnpm check` and the SHA it ran on: `merge:pr` lists what changed after it), the
  browser flows added or changed, the review rounds, known minor points; images where they help (a rendered PDF page, a UI
  screenshot): once the PR is open, `pnpm pr:assets <PR> <files>` (`--dry-run` first)
  uploads them to the `pr-assets` branch and prints the Markdown for the body
  (`verify-before-done`).
- **Fixes on a reported PR come first.** You may start your next issue after reporting, but
  the moment the coordinator sends a PR back (a clash, a conflict, a missing piece), pause and
  finish that PR first.
- **Stop your server once the PR is open** (by its port). A stopped server and a clean
  worktree at your PR head also mark your slot as idle for the coordinator's merge queue
  (`project-workflow`, "Merging"): after another PR merges, it may merge the base into your
  branch in your worktree (local only, never pushed) and run `pnpm check` there. Its note then
  tells you to review that merge diff, read the check's result, then push and name the checked
  SHA in the PR body. Don't start your own run meanwhile.
- **Don't merge.** Report to the coordinator: PR number, the migration (if any), checks and
  their results, the code-review outcome, **and the security-review outcome**. The coordinator
  merges only once both review outcomes are in and clean (or their findings addressed or
  acknowledged), never on the code-review result alone. Then you continue. In a factory run
  agents never merge either: **the lead merges**, one PR at a time, holding the same gate.

## What the guard holds for every subagent

On top of the rules above, the PreToolUse guard (`.claude/hooks/`, registered in
`.claude/settings.json`) holds these rules for **every** subagent (a call whose hook input
names an `agent_id`). That covers build agents in their own worktree (the factory's and a
coordinator's) and helper subagents wherever they run (forks, `/code-review` finders and
verifiers, Explore). The coordinator's own session and a person's are not affected. "In a
worktree" means the directory the command's `cd` (or `git -C`) lands in is under
`.claude/worktrees/<name>`.

- **Push** only from inside a worktree, only the branch checked out there, by name:
  `cd <your worktree> && git push [-u] origin <your branch>`. Refused: another branch, `HEAD`,
  a bare `git push`, a `src:dest` refspec, `+ref`, `-f`, `--force*`, `--delete`, and a base
  branch (`main`, a sprint branch) even when the worktree has it checked out. Outside a
  worktree every push is refused.
- **Never merge.** `gh pr merge`, a `gh api` write on a `/merge` path and the merge GraphQL
  mutations are refused. The coordinator (in a factory run, the lead) merges, one PR at a time,
  after the review loop.
- **No coordinator scripts:** `pnpm merge:pr` and `pnpm sync:main` (however they are run) are
  refused.
- **The main checkout's git:** outside a worktree, git only reads (`status`, `log`, `show`,
  `diff`, `rev-parse`, `fetch`, a `branch` list, `worktree list`, …). Everything that changes
  the working tree, the index or a ref (`commit`, `add`, `reset`, `rebase`, `checkout`,
  `restore`, `cherry-pick`, `worktree add`, …) is refused: `cd <your worktree> && …`, or
  `git -C <your worktree> …` with a literal path.
- **No `git stash`:** the stash is shared by every worktree; commit work in progress instead.
- **No `.env` or `.env.local`** read or written, in any checkout.
- **No `pkill -f`** (or `killall`): stop a server by its port.
- **No here-document bodies** for PRs, issues or comments: write the body with the Write tool
  to `<your worktree>/.factory-tmp/<file>.md` (git-ignored) and pass it with `--body-file`.

**One write past the push rule, on purpose:** `pnpm pr:assets` adds a PR's images to the
`pr-assets` branch of the current repository through GitHub's API, never with git, from
anywhere. It writes only that one ref, never force, only image files it recognised by their
first bytes; that branch holds nothing but PR images, so no subagent can move a branch with code
on it this way.

**Threat model.** The guard prevents mistakes agents make in good faith and catches the
obvious tricks: a wrapper in front (`timeout 600 …`, `env -i …`), a string handed to a shell
(`bash -c`, nested), a glob naming a coordinator script. It is not a sandbox against a
determined adversary: a script file that runs another, a name built at run time, a command
assembled from fragments or a file written now and run in a later call get around it, and the
real layers are auto mode's classifier (or the person's prompts) and the review loop. Within
that, when the guard can't tell what a command does it reads more or blocks, never allows.

## In a factory session

A factory run is a coordinator session without the person:

- The lead session (`/factory run`, the `factory` skill in `.claude/skills/factory/`) runs in
  **auto mode** with the project's normal `.claude/settings.json` and hooks, as a manual
  coordinator does.
- It makes each agent's slot, then starts the agent with the Agent tool, naming the slot's
  worktree, branch and `PORT`. Agents inherit the same settings and hooks.
- It merges, one PR at a time, by the skill's `merging.md`.
- Auto mode stands in for the person approving prompts. The project hooks block the dangerous
  things, and the process does the rest (plan stop, checks, review rounds, merge).

In a factory session also:

- **Your slot:** the one the lead made and named. Only if it is missing, create it from the
  main checkout: `pnpm slot create factory-<issue>`. Then work only there
  (`cd <your worktree> && …`: each Bash call starts in the main checkout).
- **Never:** `.env` or `.env.local`, a deployment, `pkill -f`, `git stash`, anything outside
  your slot.
- **A refused call:** one caused only by a missing `cd <your worktree> &&` is not a block: run
  the call again from the worktree. For any other refusal don't look for another way. Comment on
  your issue what you needed and why, then end with the status line
  `factory: blocked <what it needed>`. The lead stops the issue for a person.
- **No subagents** of your own: do the work in your own session.
- **No questions to a person:** a product question goes into the open-questions issue with the
  default you built, and the PR says so; a judgement call is decided and recorded in the PR.
- **Review levels:** the same rule as the "Review loop" section above. The gate stays: no
  critical or major findings before merging, except majors filed as issues after round 3
  (never a blocking kind).
- **The superpowers skills** (a plugin, not editable here) take their non-interactive path:
  - brainstorming isn't used between gates;
  - writing-plans' execution handoff picks executing-plans and goes on (no plan review stop
    unless your prompt asks for one);
  - executing-plans' "stop and ask" cases end with the blocked status line;
  - test-driven-development's "ask your human partner" exceptions are decided and named in
    the PR;
  - receiving-code-review's clarifications are read from the issue and recorded in the PR;
  - finishing-a-development-branch isn't used: push the branch and open the PR as your prompt
    says.

## Never the main checkout

The main checkout is the person's own: their server runs from it. Never run `git checkout`,
`git switch`, `git merge`, `git pull`, `pnpm install`, servers or tests there (the guard blocks
the git ones). The coordinator brings it up to date only with `pnpm sync:main` (a
fast-forward, refusing local changes, then `pnpm check:changed`), which the guard refuses to
every subagent, like `pnpm merge:pr`. Work only in your worktree; if it's gone, make a new
slot, never fall back to the main checkout.
