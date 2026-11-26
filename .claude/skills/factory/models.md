# Which model does what

The factory's one model table. A new model generation is a change to the `Agent model` column
only. The lead reads it and passes the model in each Agent call.

## Roles

| Role                                             | Model  | Agent model |
| ------------------------------------------------ | ------ | ----------- |
| Lead session (orchestrator)                      | Opus   | opus        |
| Planner: briefs, plans                           | Opus   | opus        |
| Implementer of a normal issue                    | Sonnet | sonnet      |
| Implementer of a **critical or difficult** issue | Opus   | opus        |
| Cleanup reviewers (`cleanup.md`)                 | Opus   | opus        |

There is no separate reviewer role: the `implement` agent runs its own `/code-review` loop
(`docs/agent-rules.md`, "Review loop"), on whatever model it was started with. An `implement`
agent runs on the issue's **Model** field (below).

## The board's Model field

| Model field | Agent model |
| ----------- | ----------- |
| Opus        | opus        |
| Sonnet      | sonnet      |

The planner sets the field when it writes the brief. An issue is **Opus** when any of these
holds:

- priority P0, or size L or XL;
- it touches a security-sensitive area (`docs/agent-rules.md`, "Security-sensitive areas");
- a migration that changes an existing table;
- the guard hooks (`.claude/hooks/`) or the coordinator scripts (`merge:pr`, `sync:main`,
  `slot`).

Everything else is **Sonnet**. A Sonnet issue's `implement` agent escalates itself (stops with
`factory: blocked escalate <why>` instead of continuing) when its diff touches one of those
areas, when its checks fail on the same step twice, or when its own `/code-review` loop still
has critical or major findings after three rounds; the lead starts the next agent on Opus, on
the same branch. Never lowered.
