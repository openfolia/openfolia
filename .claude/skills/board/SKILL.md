---
name: board
description: Use when the person asks for the board (`/board`), or when a coordinator/lead run with several lanes starts and they want to follow it outside the console. Starts the local working board (a page on 127.0.0.1 with what needs them, their questions, the lanes, what was done and issue timings), watches its inbox for their answers and requests, and keeps it current.
---

# The working board

A local page beside a long run: what needs the person, questions for them, what waits on the
client, the lanes, what was done (with times) and per-issue timings and friction. The person
ticks things off, answers and sends new requests **from the page**; each lands in an inbox this
session watches and handles as if typed in the terminal.

GitHub stays the truth for issues, PRs and the project board. The board is the person's view,
their inbox and a log; never let it disagree with GitHub, and nothing on it goes to GitHub or the
client by itself.

## Files

`BOARD_DIR`, default `<git toplevel>/.claude/board/` (gitignored: it holds decisions and client
details). One writer each; everything below goes through `board.mjs`, never the Write tool.

| File           | Writer                                                                              | What                                                                                |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `state.json`   | this session (`board.mjs set/remove/reply`)                                         | `project`, `needsYou[]`, `questions[]`, `waitingOnClient[]`, `lanes[]`, `replies[]` |
| `log.jsonl`    | this session (`board.mjs log`)                                                      | one line per thing done                                                             |
| `timings.json` | this session (`board.mjs status/round/finding/friction/worked/assign/pause/resume`) | per issue: events, merge, pauses, rounds, findings, friction, work, assignments     |
| `inbox.jsonl`  | the server                                                                          | what the person sends: `{ id, at, kind: answer\|done\|request, ref?, text }`        |
| `inbox.cursor` | this session (`board.mjs handled`)                                                  | the last inbox id handled                                                           |

`B` below is `node .claude/skills/board/board.mjs` (with `BOARD_DIR=…` in front when the board
lives elsewhere, e.g. a worktree session writing the main checkout's board).

## Start (`/board`)

1. Start the server in the background (Bash, `run_in_background: true`):
   `node .claude/skills/board/server.mjs`. It prints `board: listening on http://127.0.0.1:<port>/`
   (port `BOARD_PORT`, default 4777; if something else holds it, the next free one of the next
   ten), or `board: already running at …` and exits when a board for the same directory is
   already up: reuse that one. Give the person the URL.
2. Start a **Monitor** on the inbox, `timeout_ms` 1800000:
   `node .claude/skills/board/board.mjs watch` (description: "board inbox"). It prints every item
   after `inbox.cursor`, then each new one, one JSON line per item. When it expires, re-arm it;
   it then replays only what is still unhandled.
3. Fill the board: `B set project "Acme · Sprint 3"` and `B set client "Acme"` (the page then says "Waiting on Acme"), then
   the sections below. `B demo` writes example data, into an empty board only.

## On an inbox item

Within the same turn, in this order:

1. **Acknowledge**: `B reply <inboxId> "<what you'll do>"`, e.g. "Got it: filed as #920, lane C
   after #900". The page shows the reply under what they sent.
2. **Act**:
   - `answer` (with `ref` = a question's id) and `request`: the person's own words, exactly as if
     typed in the terminal. A question answered: `B remove <questionId>`.
   - `done` (with `ref` = a needs-you id): they ticked it off. Check it if you can (e.g. the env
     var is set), then `B remove <id>`.
3. **Advance**: `B handled <inboxId>` (it needs the reply first). The cursor moves past every
   replied item in a row and stops at the first one without a reply, so handling out of order
   never skips one. `B inbox` lists what is still to handle (after the cursor, no reply), e.g.
   after a restart; the page shows the same items as "Waiting for the session".

A question can get more than one answer (the person picked an option, then typed a correction):
the latest one wins. Reply to each.

## Keep it current

- **state.json**, whenever something for the person changes, one section at a time (a JSON
  array, or `-` to read it from stdin):
  - `B set needsYou '[{"id":"n-approve-910","text":"Approve PR #910","detail":"…","link":"https://…"}]'`
  - `B set questions '[{"id":"q-vat","text":"…?","options":["A","B"],"context":"…"}]'`: a question
    for the person goes here (and in your reply); a PushNotification still goes out when a person
    is needed.
  - `B set waitingOnClient '[{"id":"c-terms","text":"…","since":"<iso>"}]'`
  - `B set lanes '[{"id":"lane-a","name":"Lane A","issue":912,"title":"…","status":"Review round 2","next":"#915"}]'`
    The page shows each lane's phase as a pill (`phase`: `building`, `review`, `merging`,
    `waiting` or `idle`; read from `status` when left out), its review rounds as a meter and its
    active time, both from the issue's timings.
  - Ids are stable: the page posts them back. Keep an item's id as long as it is the same item.
- **log.jsonl**, whenever something is done: `B log "Merged #908 (credit notes)" --issue 908`.
- **timings.json**:
  - `B status <issue> "<status>" --title "<title>"` beside every project-board move
    (`In progress`, `In review` when the PR opens, `Done`). For `Done` pass the merge time:
    `--at "$(gh pr view <pr> --json mergedAt -q .mergedAt)"`.
  - `B assign <issue> <lane id>` whenever a lane starts an issue (and when one moves to another
    lane). It feeds "Lanes over time": the span runs until the lane's next assignment, the
    issue's next one, or the merge; status events split it into building and review.
  - `B worked <issue> <minutes> --lane <lane id>` after **every** agent report or notification:
    the minutes are the delta of that agent's `duration_ms` since its last report (divide by
    60000; fractions are fine), on the issue it worked on. Entries add up. This is the primary
    measure: wall and active time also count nights and the waits for your review or merge, when
    no agent works. The lanes show it, and the pace uses it once 3 done issues have it.
  - `B round <issue> <critical> <major> <minor>` after each review round.
  - `B finding <issue> <severity> <kind> "<summary>" [--source …] [--outcome …] [--file path:line]
[--round n]` for **each** critical and major finding (and minors when the report lists them),
    or several at once: `B findings <issue> -` with a JSON array on stdin. Kinds: `concurrency`,
    `authorization`, `security`, `money`, `data-integrity`, `validation`, `error-handling`,
    `migration`, `performance`, `i18n`, `ui-convention`, `test-gap`, `spec-mismatch`,
    `duplication`, `other`. Sources: `agent-review` (the agent's own rounds, the default),
    `coordinator-review` (yours), `security-review` (the security hook). Outcomes: `fixed` (the
    default), `declined`, `deferred`, `open`. The page's "Review findings" counts them per kind,
    most serious first, so a kind that keeps coming back points at a prompt, a rule or a check to
    add. Ask every build agent to end its report with its findings, one line each:
    `severity | kind | outcome | round | summary`.
  - `B friction <issue> <category> "<note>" [--minutes <n>]` when something slows the issue
    down. Categories: `review-finding`, `merge-conflict`, `migration-renumber`, `flaky-test`,
    `tooling` (stack, ports, browsers, CI), `spec-gap` (a question for the client or the
    person), `dependency` (waited on another issue), `limit` (usage or rate limit), `other`.
    `--minutes` is your estimate of the time it cost; the summary sorts by it.
  - `B pause "<reason>"` / `B resume` for every open issue at once: overnight, a usage limit,
    waiting on the person. It is the fallback that keeps active time honest where an agent's
    working time is missing.

- **Groups** (what's left in a sprint, or any set of issues): `B sync-group "Sprint 3" --milestone
"Sprint 3 · Invoicing"` reads the milestone's issues with `gh` (open/closed and
  the project-board Status; `--project "<board title>"` picks one board when an issue is on
  several, `--repo owner/name` another repository) into state.json's `groups`. Re-run it after
  every status move and merge, beside `B status`. `B remove-group "<name>"` drops one. The page
  shows each group's progress, what's left by status with the lane letter on each issue, done
  folded, and a rough pace: the median agent working time of its done issues × open issues ÷ busy
  lanes, in 8-hour working days, once 3 done issues have working time; with fewer, it falls back
  to active time (and says so) once 3 have that.

Times are estimates for planning, not billing.

## After a merge: friction into workflow improvements

Look at the merged issue's friction on the board's Timings section, and its findings under
"Review findings": a kind that several issues' reviews keep finding (deadlocks, a missed
authorization check) is a rule for CLAUDE.md, the agents' prompt or a lint/test, proposed the same way. When a category repeats
across issues (the friction summary shows it, most expensive first), add a proposal to
`docs/internal/workflow-improvements.md`: the pattern, the issues it hit, the time it cost, and
what would prevent it (a rule, a script, a check). Mention it on the board with `B log`.

## Rules

- Local only: the server listens on 127.0.0.1 and refuses a foreign `Host` and a POST from any
  other origin. Never expose it (no tunnels, no `0.0.0.0`).
- Stop it by its port when done: `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill` (never
  `pkill -f`). The files stay; the next `/board` picks up where this one ended.
- Never put the board's content in anything the client sees.
