# Merging

Only you merge; a subagent's merge is refused by the guard. One PR at a time, after a clean
round, every step run by you in the PR's slot. You never change the PR's code: anything that
needs a change goes back to a new `implement` agent on the same branch, with the output; fixing
it and re-running its own `/code-review` loop on the fix diff counts as another round (same
escalation thresholds as `models.md` and `prompts/implement.md`).

## Steps

0. **Security-hook notifications:** a background security-review hook, where one is set up,
   reports into your session after a commit or push, not on the PR, so `merge:pr` can't see
   it. A notification names a commit: it is this PR's when it is on the branch and not on the
   base, read in the PR's slot after a fetch
   (`git fetch origin && git log --format=%H origin/<base>..HEAD`). Each one about this PR's
   commits is answered first: fixed (back to `implement`) or why it doesn't apply, written in
   the PR body. An unanswered one holds the merge (`docs/agent-rules.md`, "Security review").
   The PR body must also name the agent's own `/security-review` outcome.
1. **The reviewed head:** the slot's `HEAD`, the PR's `headRefOid` and the SHA its last clean
   round reviewed (read from the PR body) are one commit. If not, back to `implement` to review
   again before merging.
2. **Merge the base** into the branch (`git fetch origin && git merge origin/<base>`), then
   `pnpm install` when the lockfile changed. Once there is a database: when the base gained a
   migration, the branch's own must be regenerated on top (`docs/agent-rules.md`, "The
   database"); that is a change, so back to `implement`.
3. **Check:** `pnpm check`. Red (a conflict, a failed check): back to `implement`, as above.
4. **Merge:** only the reviewed head plus a clean merge of the freshly fetched base (no conflict
   resolved by hand) may merge; a conflict that needs resolving goes back to `implement`, which
   fixes it and reviews the fix diff itself before you merge. Push the merged head, then
   `pnpm merge:pr <pr> --reviewed <that SHA>` (`--dry-run` first): it repeats the checks
   above that only read, then `gh pr merge --merge --match-head-commit`, deletes the branch on
   GitHub, sets the board, removes the slot (`pnpm slot remove factory-<issue>`) and prints
   the note for the running agents.

## After every merge

In `factory-main`, on the merged PR's own base:
`git fetch origin && git switch --detach origin/<base>`, then `pnpm install` when the lockfile
changed and **run `pnpm check` yourself** and read it to the end. Don't rely on the post-merge
hook.

**A red base stops all merging.** Notify, and file one P0, Opus issue with the output and the
two PRs that collided; its PR is the only one that may merge until the base is green again.

## Deployment

The factory deploys nothing. If the project has a pipeline that deploys on a merge, read its
status read-only for the report; without a way to read it, the report says "deployment not
confirmed".
