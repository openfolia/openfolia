// Setting issues' Status on the project board (scripts/set-project-status.sh), with the ids it
// needs cached between calls: the project's id, the field's id and its options' ids, the repo,
// and each issue's node id and board item. With a warm cache a status change is one mutation;
// a cold one reads the project once and each new issue once. A cached id GitHub no longer
// knows (a field remade, an item removed from the board) fails the mutation: the entry is
// dropped and the change made again from fresh reads, once. `gh` is the injected caller of
// scripts/gh-api.mjs; the cache is `{ read() => object, write(object) }`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readProject } from './board-github.mjs';
import { currentRepo, graphql } from './gh-api.mjs';

const ISSUE_ID = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;

// Adds the issue to the board, or (already there) returns its item: GitHub's add is idempotent.
const ADD_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

const SET_VALUE = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId,
      fieldId: $fieldId, value: $value }) {
    projectV2Item { id }
  }
}`;

/** A cache in a JSON file (made on the first write); an unreadable file reads as empty. */
export function fileCache(file) {
  return {
    read() {
      try {
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      } catch {
        return {};
      }
    },
    write(data) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    },
  };
}

/** A project's cache entry from GitHub: its id, this repo and every single-select field. */
function readEntry(gh, owner, number) {
  const project = readProject(gh, owner, number);
  if (!project) throw new Error(`no project #${number} of ${owner}`);
  const fields = {};
  for (const field of project.fields) {
    if (!field.options) continue;
    fields[field.name] = {
      id: field.id,
      options: Object.fromEntries(field.options.map((o) => [o.name, o.id])),
    };
  }
  return { projectId: project.id, repo: currentRepo(gh), fields, items: {} };
}

/** The field and option ids for `status`, or null when the entry doesn't have them. */
function optionIds(entry, fieldName, status) {
  const field = entry.fields[fieldName];
  const optionId = field?.options[status];
  return optionId ? { fieldId: field.id, optionId } : null;
}

/** The issue's board item, from the entry or (added to it) from GitHub. */
function itemOf(gh, entry, issue) {
  const known = entry.items[issue];
  if (known) return known.itemId;
  const { owner, name } = entry.repo;
  const contentId = graphql(gh, ISSUE_ID, {
    owner,
    name,
    number: Number(issue),
  }).repository?.issue?.id;
  if (!contentId) throw new Error(`no issue #${issue} in ${owner}/${name}`);
  const itemId = graphql(gh, ADD_ITEM, {
    projectId: entry.projectId,
    contentId,
  }).addProjectV2ItemById.item.id;
  entry.items[issue] = { contentId, itemId };
  return itemId;
}

/**
 * Sets the `fieldName` of each issue (numbers) to `status`, adding it to the board first when
 * it isn't on it. Throws when the field has no such option (after reading the board afresh, in
 * case it was added since the cache was made).
 * @param {{ gh: (args: string[], input?: string) => string,
 *   cache: { read: () => Record<string, any>, write: (data: Record<string, any>) => void },
 *   owner: string, number: string | number, fieldName: string, status: string,
 *   issues: (string | number)[], log: (line: string) => void }} input
 */
export function setProjectStatus({
  gh,
  cache,
  owner,
  number,
  fieldName,
  status,
  issues,
  log,
}) {
  const key = `${owner}/${number}`;
  const missing = () =>
    new Error(
      `no option "${status}" in field "${fieldName}" of project ${number}`,
    );
  const data = cache.read();
  const save = () => cache.write(data);
  const fresh = () => {
    data[key] = readEntry(gh, owner, number);
    save();
    return data[key];
  };
  const cached = Boolean(data[key]);
  let entry = data[key] ?? fresh();
  let ids = optionIds(entry, fieldName, status);
  if (!ids && cached) {
    entry = fresh();
    ids = optionIds(entry, fieldName, status);
  }
  if (!ids) throw missing();

  for (const issue of issues.map(String)) {
    const set = () => {
      const itemId = itemOf(gh, entry, issue);
      graphql(gh, SET_VALUE, {
        projectId: entry.projectId,
        itemId,
        fieldId: ids.fieldId,
        value: { singleSelectOptionId: ids.optionId },
      });
    };
    try {
      set();
    } catch (error) {
      // A cached id GitHub no longer knows: read everything again and try once more.
      if (
        !/Could not resolve to a node|NOT_FOUND|does not exist/i.test(
          String(error?.message),
        )
      ) {
        throw error;
      }
      entry = fresh();
      ids = optionIds(entry, fieldName, status);
      if (!ids) throw missing();
      set();
    }
    save();
    log(`#${issue} → ${status}`);
  }
}
