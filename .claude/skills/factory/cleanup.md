# The cleanup review per sprint

Single PRs are reviewed one at a time; only a review of the whole sprint sees what they add up
to. The sprint's closing gate isn't reached before it is done.

- **When:** every work issue in sprint n's milestone is merged. Once per sprint.
- **The range:** from the tag `sprint-<n-1>-accepted` (sprint 1: the repository's root commit)
  to the base's head when the cleanup starts. When you see sprint n's closing gate closed, tag
  the base's head `sprint-<n>-accepted` and push the tag.
- **Three Opus agents, research only**, each in its own slot made at the range's end, counted
  in the limit: `prompts/cleanup-code-review.md`, `prompts/cleanup-code-quality.md`,
  `prompts/cleanup-performance.md`. Give each the sprint, the range (from, to SHAs) and the
  report issue. Each posts its findings as one comment on the report. (Once the project has a
  UI, add a UI review agent with the same shape: every changed screen at desktop and phone
  width, light and dark, keyboard and focus, and lists that scroll inside their own container
  with the pagination outside it.)
- **Findings:** you file each critical and major one as an issue in sprint n's milestone, with
  severity, Model, `Touches`, the label `triage:cleanup` and a key
  (`<!-- backlog:key cleanup.sprint-<n>.<kind>.<slug> -->`). Look the key up in a full listing
  first, closed issues included, so nothing is filed twice. They are built like any issue
  before the gate. Minor ones go in the report for the person at the gate.
- **The summary** goes at the top of the report: the range, each agent's counts, the issues
  filed and their state.
