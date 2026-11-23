// What `pnpm setup:board` decides, as plain functions a test can pin: the board's fields
// (Status, Priority, Size, Model, Review rounds and Stopped: the names and options the
// workflow reads), which project is
// this repo's board, what is missing on it, and the settings entry the other scripts read.
// scripts/setup-board.mjs reads GitHub and applies the plan (scripts/board-github.mjs).

/** @typedef {{ id?: string, name: string, color: string, description: string }} Option */
/** @typedef {{ name: string, dataType: string, options?: Option[] }} FieldSpec */
/** @typedef {FieldSpec & { id: string }} Field */
/**
 * @typedef {{ kind: string, name?: string, title?: string, repo?: string, dataType?: string,
 *   options?: Option[], fieldId?: string, added?: string[], renamed?: string[],
 *   dropped?: string[] }} Step
 */
/** @typedef {{ id: string, number: number, title: string, closed: boolean }} ProjectRef */

/** @param {[string, string][]} pairs */
const select = (pairs) =>
  pairs.map(([name, color]) => ({ name, color, description: '' }));

/** The board's fields, in the order they are made. Option colours are only a first look. */
/** @type {FieldSpec[]} */
export const BOARD_FIELDS = [
  {
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: select([
      ['Backlog', 'GREEN'],
      ['Ready', 'BLUE'],
      ['In progress', 'YELLOW'],
      ['In review', 'PURPLE'],
      ['Done', 'ORANGE'],
    ]),
  },
  {
    name: 'Priority',
    dataType: 'SINGLE_SELECT',
    options: select([
      ['P0', 'RED'],
      ['P1', 'ORANGE'],
      ['P2', 'YELLOW'],
    ]),
  },
  {
    name: 'Size',
    dataType: 'SINGLE_SELECT',
    options: select([
      ['XS', 'GREEN'],
      ['S', 'PURPLE'],
      ['M', 'RED'],
      ['L', 'YELLOW'],
      ['XL', 'PINK'],
    ]),
  },
  {
    name: 'Model',
    dataType: 'SINGLE_SELECT',
    options: select([
      ['Opus', 'GRAY'],
      ['Sonnet', 'GRAY'],
    ]),
  },
  { name: 'Review rounds', dataType: 'NUMBER' },
  { name: 'Stopped', dataType: 'TEXT' },
];

/**
 * A single-select field's options after adding the workflow's: an existing option keeps its id
 * (so items keep their value), colour and description, and takes the workflow's spelling when
 * it differs only in case ("In Progress" → "In progress"). Options the workflow doesn't name
 * stay where they are unless `dropExtra` (a project made in this run, whose defaults no item
 * uses yet); then the result is the workflow's options in its order.
 * @param {Option[]} existing
 * @param {Option[]} desired
 * @param {{ dropExtra?: boolean }} [options]
 */
export function mergeOptions(existing, desired, { dropExtra = false } = {}) {
  const used = new Set();
  const added = [];
  const renamed = [];
  const matched = desired.map((want) => {
    const match =
      existing.find((o) => !used.has(o.id) && o.name === want.name) ??
      existing.find(
        (o) =>
          !used.has(o.id) && o.name.toLowerCase() === want.name.toLowerCase(),
      );
    if (!match) {
      added.push(want.name);
      return {
        name: want.name,
        color: want.color,
        description: want.description,
      };
    }
    used.add(match.id);
    if (match.name !== want.name) renamed.push(`${match.name} → ${want.name}`);
    return {
      id: match.id,
      name: want.name,
      color: match.color,
      description: match.description,
    };
  });
  const extra = existing.filter((o) => !used.has(o.id));
  let options;
  if (dropExtra) {
    options = matched;
  } else {
    const byId = new Map(matched.filter((o) => o.id).map((o) => [o.id, o]));
    options = [
      ...existing.map((o) => byId.get(o.id) ?? keep(o)),
      ...matched.filter((o) => !o.id),
    ];
  }
  const dropped = dropExtra ? extra.map((o) => o.name) : [];
  const kept = dropExtra ? [] : extra.map((o) => o.name);
  const changed = added.length + renamed.length + dropped.length > 0;
  return { options, changed, added, renamed, dropped, kept };
}

/** @param {Option} o */
const keep = (o) => ({
  id: o.id,
  name: o.name,
  color: o.color,
  description: o.description,
});

/**
 * The fields GitHub gives a project it just made (its default Status), so a dry run for a
 * board that doesn't exist yet plans what the real run will do. Ids are stand-ins.
 * @type {Field[]}
 */
export const NEW_PROJECT_FIELDS = [
  {
    id: 'new-status',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: ['Todo', 'In Progress', 'Done'].map((name, i) => ({
      id: `new-${i}`,
      name,
      color: 'GRAY',
      description: '',
    })),
  },
];

/**
 * What to do to `fields` (the project's, `{ id, name, dataType, options? }`): create the
 * missing ones, add missing options. A field of the wrong type is a problem a person fixes on
 * the board (changing a type would drop every item's value).
 * @param {{ fields: Field[], freshProject?: boolean }} input
 * @returns {{ steps: Step[], problems: string[], notes: string[] }}
 */
export function planBoard({ fields, freshProject = false }) {
  const steps = [];
  const problems = [];
  const notes = [];
  for (const want of BOARD_FIELDS) {
    const have = fields.find((f) => f.name === want.name);
    if (!have) {
      steps.push({ kind: 'createField', ...want });
      continue;
    }
    if (have.dataType !== want.dataType) {
      problems.push(
        `The field "${want.name}" is ${have.dataType}; the workflow needs ${want.dataType}. ` +
          'Rename or change it on the board, then run this again.',
      );
      continue;
    }
    if (want.dataType !== 'SINGLE_SELECT') continue;
    const merged = mergeOptions(have.options ?? [], want.options, {
      dropExtra: freshProject,
    });
    if (merged.kept.length) {
      notes.push(
        `"${want.name}" keeps options the workflow doesn't use: ${merged.kept.join(', ')}`,
      );
    }
    if (merged.changed) {
      steps.push({
        kind: 'updateOptions',
        fieldId: have.id,
        name: want.name,
        ...merged,
      });
    }
  }
  return { steps, problems, notes };
}

/** One line per step, for the plan and the log. @param {Step} step */
export function describeStep(step) {
  if (step.kind === 'createProject')
    return `create the project "${step.title}" for ${step.repo}`;
  if (step.kind === 'linkRepo') return `link ${step.repo} to the project`;
  if (step.kind === 'createField') {
    const options = step.options
      ? ` (${step.options.map((o) => o.name).join(', ')})`
      : '';
    return `create the field "${step.name}", ${step.dataType}${options}`;
  }
  const parts = [
    step.added.length && `add ${step.added.join(', ')}`,
    step.renamed.length && `rename ${step.renamed.join(', ')}`,
    step.dropped.length && `drop ${step.dropped.join(', ')}`,
  ].filter(Boolean);
  return `"${step.name}": ${parts.join('; ')}`;
}

/**
 * Which of the owner's projects is this repo's board: the one numbered `number` (the settings'
 * GH_PROJECT_NUMBER, when it belongs to this owner), else the open one titled `title`.
 * Returns `{ project }` (null: none yet) or `{ problem }`.
 * @param {{ projects: ProjectRef[], title: string, number?: string | number | null }} input
 * @returns {{ project?: ProjectRef | null, problem?: string }}
 */
export function findProject({ projects, title, number }) {
  if (number != null) {
    const project = projects.find((p) => p.number === Number(number));
    if (project) return { project };
  }
  const named = projects.filter((p) => !p.closed && p.title === title);
  if (named.length > 1) {
    return {
      problem: `${named.length} open projects are titled "${title}" (${named.map((p) => `#${p.number}`).join(', ')}): pass --title with another name, or close the extra one.`,
    };
  }
  return { project: named[0] ?? null };
}

/**
 * `.claude/settings.local.json` with the board's owner and number, everything else kept.
 * @param {any} current
 * @param {{ owner: string, number: string | number }} board
 */
export function mergeLocalSettings(current, { owner, number }) {
  const settings = current && typeof current === 'object' ? current : {};
  return {
    ...settings,
    env: {
      ...settings.env,
      GH_PROJECT_OWNER: owner,
      GH_PROJECT_NUMBER: String(number),
    },
  };
}
