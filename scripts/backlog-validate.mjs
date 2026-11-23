// The checks a backlog file (scripts/backlog.schema.json) passes before anything is written,
// and the order its issues are made in: scripts/backlog-apply.mjs runs both first.
import { BOARD_FIELDS } from './board-plan.mjs';

/** @typedef {import('./backlog-plan.mjs').IssueEntry} IssueEntry */

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Every mistake in a backlog file, as sentences; empty when it can be applied.
 * @param {any} backlog
 * @returns {string[]}
 */
export function validateBacklog(backlog) {
  const errors = [];
  const milestones = backlog?.milestones ?? [];
  const issues = backlog?.issues ?? [];
  const seen = new Set();
  for (const item of [...milestones, ...issues]) {
    if (!KEY.test(item?.key ?? ''))
      errors.push(`"${item?.key}" is not a key (letters, digits, . _ : -)`);
    else if (seen.has(item.key))
      errors.push(`the key "${item.key}" is used twice`);
    seen.add(item?.key);
    if (!String(item?.title ?? '').trim())
      errors.push(`${item?.key}: no title`);
  }
  const labelNames = new Set();
  for (const label of backlog?.labels ?? []) {
    const name = String(label?.name ?? '').trim();
    if (!name) errors.push('a label without a name');
    else if (labelNames.has(name.toLowerCase()))
      errors.push(`the label "${name}" is defined twice`);
    labelNames.add(name.toLowerCase());
    if (label?.color !== undefined && !/^[0-9a-f]{6}$/i.test(label.color)) {
      errors.push(
        `the label "${name}": colour "${label.color}" is not 6 hex digits without #`,
      );
    }
  }
  const milestoneAt = new Map(milestones.map((m, i) => [m.key, i]));
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));
  for (const issue of issues) {
    const at = `${issue.key}`;
    if (issue.milestone != null && !milestoneAt.has(issue.milestone)) {
      errors.push(`${at}: no milestone "${issue.milestone}"`);
    }
    if (issue.parent != null && !issueByKey.has(issue.parent)) {
      errors.push(`${at}: no parent issue "${issue.parent}"`);
    }
    // Its parent chain ends: no issue is its own parent, directly or around a loop.
    const chain = new Set([issue.key]);
    for (
      let up = issueByKey.get(issue.parent);
      up;
      up = issueByKey.get(up.parent)
    ) {
      if (chain.has(up.key)) {
        errors.push(`${at}: its parents loop back to it`);
        break;
      }
      chain.add(up.key);
    }
    for (const dep of issue.waitsFor ?? []) {
      const other = issueByKey.get(dep);
      if (!other)
        errors.push(`${at}: waits for "${dep}", which isn't in the backlog`);
      else if (
        milestoneAt.get(other.milestone) > milestoneAt.get(issue.milestone)
      ) {
        errors.push(`${at}: waits for "${dep}", which is in a later milestone`);
      }
    }
    for (const [name, value] of Object.entries(issue.fields ?? {})) {
      const field = BOARD_FIELDS.find((f) => f.name === name);
      if (!field) errors.push(`${at}: no board field "${name}"`);
      else if (field.options && !field.options.some((o) => o.name === value)) {
        errors.push(
          `${at}: "${value}" is not a ${name} (${field.options.map((o) => o.name).join(', ')})`,
        );
      } else if (field.dataType === 'NUMBER' && typeof value !== 'number') {
        errors.push(`${at}: ${name} takes a number`);
      }
    }
  }
  if (!errors.length) {
    try {
      creationOrder(issues);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

/**
 * Issue keys in the order they are made: whatever an issue waits for first, so its
 * "Waits for" line can name real numbers; otherwise the file's order. Throws on a cycle.
 * @param {IssueEntry[]} issues
 * @returns {string[]}
 */
export function creationOrder(issues) {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const order = [];
  const state = new Map();
  const visit = (key, path) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'open') {
      throw new Error(
        `issues wait for each other in a circle: ${[...path, key].join(' → ')}`,
      );
    }
    state.set(key, 'open');
    for (const dep of byKey.get(key)?.waitsFor ?? [])
      visit(dep, [...path, key]);
    state.set(key, 'done');
    order.push(key);
  };
  issues.forEach((issue) => visit(issue.key, []));
  return order;
}
