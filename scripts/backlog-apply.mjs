// Applies a backlog file to GitHub (scripts/backlog-plan.mjs decides, scripts/backlog-github.mjs
// reads and writes): milestones, labels, issues in dependency order, sub-issue and blocked-by
// links, and the empty board fields. A dry run reads only and logs what it would do, naming an
// issue that doesn't exist yet `#<key>`.
import {
  backlogWriter,
  fieldValueInput,
  readRepoBacklog,
} from './backlog-github.mjs';
import {
  marker,
  missingFieldValues,
  missingLabels,
  missingLinks,
  planIssues,
  planMilestones,
  renderIssueBody,
  renderMilestoneDescription,
} from './backlog-plan.mjs';
import { creationOrder, validateBacklog } from './backlog-validate.mjs';

/**
 * Makes what is missing. `project` is the board as scripts/board-github.mjs reads it. Returns
 * the notes for the report; throws on a file mistake or a conflict a person has to decide.
 */
export function applyBacklog({ gh, repo, project, backlog, dryRun, log }) {
  const errors = validateBacklog(backlog);
  if (errors.length)
    throw new Error(`the backlog file:\n  ${errors.join('\n  ')}`);
  const fieldByName = new Map(project.fields.map((f) => [f.name, f]));
  const needed = new Set(
    backlog.issues.flatMap((i) => ['Status', ...Object.keys(i.fields ?? {})]),
  );
  const absent = [...needed].filter((name) => !fieldByName.has(name));
  if (absent.length) {
    throw new Error(
      `the board has no ${absent.join(', ')} field: run pnpm setup:board`,
    );
  }

  const write = backlogWriter(gh, repo, project);
  const doing = (line) => log(`${dryRun ? 'would ' : ''}${line}`);
  const existing = readRepoBacklog(gh, repo, project.id);
  const notes = [];

  const milestones = planMilestones(
    backlog.milestones ?? [],
    existing.milestones,
  );
  const milestoneOf = new Map(
    milestones.plan
      .filter((step) => step.existing)
      .map((step) => [step.key, step.existing]),
  );
  const issues = planIssues(
    backlog.issues,
    existing.issues,
    (key) => milestoneOf.get(key)?.number ?? null,
  );
  const problems = [...milestones.problems, ...issues.problems];
  if (problems.length) throw new Error(problems.join('\n'));

  // Milestones: an unmarked one with the same title start is adopted by adding the marker.
  for (const step of milestones.plan) {
    const m = backlog.milestones.find((x) => x.key === step.key);
    if (step.action === 'adopt') {
      doing(`mark the milestone "${step.existing.title}" as ${step.key}`);
      const description = [
        step.existing.description?.trim(),
        marker(step.key),
      ].filter(Boolean);
      if (!dryRun)
        write.setMilestoneDescription(
          step.existing.number,
          description.join('\n\n'),
        );
    }
    if (step.action === 'create') {
      doing(`create the milestone "${m.title}"`);
      const made = dryRun
        ? { id: null, number: null }
        : write.createMilestone(m.title, renderMilestoneDescription(m));
      milestoneOf.set(step.key, made);
    }
  }
  notes.push(...issues.notes);

  const labelIds = new Map(
    existing.labels.map((l) => [l.name.toLowerCase(), l.id]),
  );
  for (const label of missingLabels(
    backlog,
    existing.labels.map((l) => l.name),
  )) {
    doing(`create the label ${label.name}`);
    labelIds.set(
      label.name.toLowerCase(),
      dryRun ? null : write.createLabel(label),
    );
  }

  // Issues, in dependency order, so a "Waits for" line names real numbers.
  const state = new Map();
  for (const step of issues.plan) {
    if (step.action === 'exists') state.set(step.key, step.existing);
  }
  const byKey = new Map(backlog.issues.map((i) => [i.key, i]));
  for (const key of creationOrder(backlog.issues)) {
    if (state.has(key)) continue;
    const issue = byKey.get(key);
    const body = renderIssueBody(issue, (k) => state.get(k)?.number ?? null);
    doing(`create "${issue.title}" (${key})`);
    const made = dryRun
      ? { id: null, number: null }
      : write.createIssue({
          title: issue.title,
          body,
          labelIds: (issue.labels ?? []).map((name) =>
            labelIds.get(name.toLowerCase()),
          ),
          milestoneId:
            issue.milestone == null
              ? null
              : milestoneOf.get(issue.milestone).id,
        });
    if (made.number) log(`  → #${made.number}`);
    state.set(key, {
      ...made,
      open: true,
      parent: null,
      blockedBy: [],
      item: null,
    });
  }

  const ref = (key) =>
    state.get(key).number ? `#${state.get(key).number}` : `#<${key}>`;
  for (const link of missingLinks(backlog.issues, (k) => state.get(k))) {
    if (link.kind === 'note') notes.push(link.text);
    if (link.kind === 'subIssue') {
      doing(`make ${ref(link.child)} a sub-issue of ${ref(link.parent)}`);
      if (!dryRun)
        write.addSubIssue(state.get(link.parent).id, state.get(link.child).id);
    }
    if (link.kind === 'blockedBy') {
      doing(`mark ${ref(link.issue)} blocked by ${ref(link.blocking)}`);
      if (!dryRun)
        write.addBlockedBy(
          state.get(link.issue).id,
          state.get(link.blocking).id,
        );
    }
  }

  const values = missingFieldValues(
    backlog.issues,
    (k) => state.get(k),
    (k) => state.get(k).item?.values ?? {},
  );
  notes.push(...values.notes);
  for (const { key, field, value } of values.set) {
    const input = fieldValueInput(fieldByName.get(field), value);
    doing(`set ${field} = ${value} on ${ref(key)}`);
    if (dryRun) continue;
    const own = state.get(key);
    if (!own.item) own.item = { id: write.addToBoard(own.id), values: {} };
    write.setValue(own.item.id, fieldByName.get(field).id, input);
  }
  return notes;
}
