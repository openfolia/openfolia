---
name: requirements-to-backlog
description: Use when turning a spec, requirements document, brief, meeting notes or feature list into GitHub milestones, epics and issues, when starting a project's planning, when a new entity, resource or flow appears in the requirements, when making or updating the backlog (milestones, gates, issues, board fields), or when an open product question comes up during a build.
---

# Requirements to backlog

Scope that is vague at the start turns into rework later: a missing attribute shows up only
when a route or a screen needs it. Plan in this order; then write the plan as a backlog file
(`scripts/backlog.schema.json`) and make it with `pnpm backlog:create <file>` (milestones,
labels, issues, sub-issues, dependencies, board fields; `--dry-run` shows the plan, a re-run
makes only what is missing, matched by each item's `<!-- backlog:key <key> -->` marker), not
issue by issue. The board first: `pnpm setup:board`; its fields are in
[board-fields.md](board-fields.md). Ask the person before creating anything on GitHub the
first time; show the dry run first.

In a factory session nothing here waits for a person: the lead's backlog and its gate issues
are the person's go-ahead, and an open question that comes up during a build goes into the
open-questions issue with the default you built (section 2) while the work goes on.

## Where the spec is, and what stays out of GitHub

- **Read the spec from wherever the person points**, often `docs/internal/` (git-ignored,
  organisation-specific, never committed).
- **What goes to GitHub or into the repository stays generic.** Issues, milestones, labels,
  comments, PRs and committed files carry no organisation, client, person, product or vendor
  name and no quote from the internal spec: name the capability ("approval needs two roles"),
  not who asked for it. The **Source** of an issue names the spec's section, not its owner.
- **Backlog files live in a git-ignored place** (`docs/internal/backlog/<name>.json`), since
  they are written from the internal spec; commit one only when it is wholly generic.
- Examples, fixtures and sample content use invented, neutral names.

## Shape it for `/factory run`

The backlog decides who coordinates. Shaped this way, `/factory run` (the `factory` skill)
starts the agents, reviews and merges between the gates, and a person only closes gates and
answers questions; shaped as a pile of hand-sized issues, a person ends up coordinating.

- **Every issue stands on its own:** Model, Size, `Done when`, `Touches` (the lead keeps two
  issues touching the same file, resource, table or shared list from running at once) and the
  defaults for its open questions: an agent in a factory run asks no one.
- **Foundations first, then parallel work:** a shared piece (a port, a base helper, the first
  migration, an error shape) is one issue that the others wait for, so parallel agents don't
  each invent it.
- **Order, not luck:** two issues that change the same shared file or list wait for one
  another (`waitsFor`); a gate is an issue; the open questions are one issue with defaults.

## 1. Read the spec for its parts

- [ ] List the **flows** (end-to-end things a person or a system does: write a module, branch
      a draft, request a review, approve, publish, render a PDF …), the **resources** each flow
      touches, the **roles**, the **integrations** and the **screens** (if any).
- [ ] **Read every flow for data it silently assumes**: an approval needs who approved and
      when; a lock needs an owner and an expiry; a "publish" needs a target ref; a list needs
      its filters and sort order.
- [ ] Note each **third-party behaviour** the design depends on (identity provider, Git
      hosting, the renderer, e-mail) and plan a spike for it before the sprint that relies on
      it.

## 2. Sprint 0 · Discovery milestone (open questions)

- [ ] A milestone "Sprint 0 · Discovery" ("answers to open questions, flows signed off").
- [ ] **One open-questions issue per flow**, plus one each for the data model, roles and
      permissions, integrations, screens/design, and other cross-cutting questions. Label
      them `open-question` and their area (`flow-<n>`, `data-model`, `roles`,
      `integrations`, `design`).
- [ ] **One concrete question per attribute or rule**, as a checkbox, never bundled: "Can a
      module be approved by its own author?", "Does a lock expire, and after how long?", "Is a
      variant attribute single- or multi-valued?". A bundled question ("details on approvals:
      roles, order, expiry?") gets a vague answer or none.
- [ ] **Each question carries the default that gets built if it stays unanswered**, so
      building never waits: `- [ ] <question> — Default: <what we build>`.
- [ ] When a build ships on a guessed default, add to that issue a table
      `| Question | Default built in #N | Where to change it |` (the action, constant or
      configuration key), so the answer later is a small, findable change.
- [ ] A question that comes up during a build goes into its flow's open-questions issue in the
      same change (and is referenced from the PR), never only into a PR or a report.
- [ ] The day an answer comes in, it becomes its own issue (or updates the built default).

## 3. Milestones, epics, issues

- [ ] **One milestone per sprint** (what is accepted as one delivery), each with a one-line
      description of its outcome.
- [ ] **One epic per flow or area** inside its sprint: "Epic: <area>", its body a checklist of
      sub-issues (`parent` in the backlog file), "no code is scoped against this issue".
- [ ] **Issues small enough for one PR** (one migration at most). Each body has these
      headings:
  - **Goal**: one or two sentences, the outcome for the person or client using it.
  - **Source**: the spec section it comes from (by section, no organisation name).
  - **Scope** (what to build: actions, routes, resources, ports) and **Out of scope**.
  - **Acceptance criteria**: checkboxes a tester can verify (a route's statuses and error
    `code`s, a list's paging, what the unit and e2e tests show).
  - **Defaults while unanswered**, pointing at the open-questions issue.
  - **Done when** and **Touches** (files, resources, tables and shared lists it changes, so
    parallel work can see collisions); dependencies go into `waitsFor`.
  - **Placement** for UI without a design (once there is a UI): own page, tab or section,
    decided here, never "add it to the nearest page".
- [ ] **Labels:** area (`flow-<n>`, `data-model`, `roles`, `integrations`, `design`, `infra`),
      kind (`feature`, `bug`), state (`open-question`, `blocked`). **Size** and the other
      board fields: [board-fields.md](board-fields.md).
- [ ] Order inside a sprint: foundations first (ports, schema, roles, shared helpers), then
      flows in dependency order; mark what can run in parallel (nothing in `Touches` shared).

## 4. Check the plan

- [ ] Every flow step maps to an issue; every attribute to a question or a field; every screen
      to a placement; every external dependency to a spike or an integration issue.
- [ ] Nothing in a sprint depends on an unanswered question without a default.
- [ ] No organisation-specific name or quote in a title, body or label (grep the file).
- [ ] Make it: `pnpm backlog:create <file> --dry-run`, then without; then the
      `project-workflow` skill keeps the board.
