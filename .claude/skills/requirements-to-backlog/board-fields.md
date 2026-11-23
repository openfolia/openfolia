# Board fields

The project board (`GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER`; `gh` needs the `project` scope:
`gh auth refresh -s project`) carries what the lead reads to run work.

- **Status** (Backlog, Ready, In progress, In review, Done): `Backlog` when the issue first
  goes on the board; after that only the lead or a person moves it
  (`scripts/set-project-status.sh`).
- **Priority** (P0, P1, P2) and **Size** (XS, S, M, L, XL): on every work issue. L and XL are
  a hint to split.
- **Model** (Opus, Sonnet): the values of "The board's Model field" in
  `.claude/skills/factory/models.md`, on every work issue, by its rules. Never lower Opus to
  Sonnet on an issue labelled `triage:escalated`.
- **Review rounds** (a number) and **Stopped** (text, the reason): the lead writes them.
- Gates, epics and `Open questions` get only Status: no agent works them.
- **The board itself:** `pnpm setup:board` (`scripts/setup-board.mjs`, `--dry-run` first)
  makes the project linked to the repo, or finds it, and adds what it lacks: the five Status
  options and the other fields with their options, keeping every option and value already
  there. It writes `GH_PROJECT_OWNER`/`GH_PROJECT_NUMBER` into `.claude/settings.local.json`.
  Re-run it whenever a field or option is missing; a field of the wrong type it reports, for
  the person to fix on the board.
- **Values on issues:** `pnpm backlog:create` sets them from the backlog file's `fields`; one
  issue's Status later: `scripts/set-project-status.sh`. One value by hand (the lead's Review
  rounds, Stopped): the ids from `gh project field-list <n> --owner <owner> --format json` and
  `gh project item-add <n> --owner <owner> --url <issue url> --format json --jq .id`, then
  `gh project item-edit --id <item> --project-id <project id> --field-id <field>` with
  `--number`, `--text` or `--single-select-option-id`.
- **Only empty fields are set**, on every pass (the script does this): a value someone set
  stays, even when the backlog file now says otherwise. An escalated Model is never lowered.
