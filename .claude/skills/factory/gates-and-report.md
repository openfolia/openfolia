# Gates, the report and notifications

## Gates

Gate issues come from `requirements-to-backlog`: typically gate 1 (questions answered or
defaults accepted, sprint plan agreed) opens sprint 1, and gate 2 of sprint n (cleanup review
done and its critical and major findings merged, the sprint's outcome checked, report read)
opens sprint n+1. **Only a person closes one.** Closing is the go-ahead; reopening stops new
work behind it, while running agents finish.

A gate is **reached** when everything before it is merged (for the end of a sprint, the
cleanup review too): notify, and put the gate at the top of the report.

## The report

One issue per sprint, `Factory · Sprint <n>`, found by its key
(`<!-- backlog:key report.sprint-<n> -->`) in a full listing
(`gh issue list --state all --limit 1000`), made only when missing. Rewrite its body every
wake-up:

- a reached gate and the cleanup summary, on top;
- what needs the person: stops, open product questions, a red base, setup still open;
- running agents; merged PRs with their review rounds and security-review outcome;
- escalations; stops with their reason; `Touches` corrections;
- the defaults chosen for open questions; minor cleanup findings for the sprint's gate;
- the notifications sent (so a restart doesn't send them again).

The report is on GitHub: no organisation, client or person names in it.

## Notifications

Only when a person is needed, through **PushNotification**, one short line with a link: a gate
reached, an issue stopped, a question only a person can answer, a red base. Nothing else
notifies.

## Friction

After a merge, follow the board skill's "After a merge" section: a kind of finding or friction
that keeps coming back across issues becomes a proposal in
`docs/internal/workflow-improvements.md` (a rule, a check, a prompt line).
