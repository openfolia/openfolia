// The backlog on GitHub: reading the repo's milestones, labels and issues (closed ones too,
// with their parent, blocked-by links and board values) through GraphQL rather than
// `gh search`, whose index lags behind what was just made; and the writes
// scripts/backlog-apply.mjs makes. `gh` is the injected caller of scripts/gh-api.mjs.
import { allNodes, graphql, rest } from './gh-api.mjs';

const PAGE = 'pageInfo { hasNextPage endCursor }';
const FIELD_NAME = 'field { ... on ProjectV2FieldCommon { name } }';

const MILESTONES = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    milestones(first: 100, after: $after) { nodes { id number title description state } ${PAGE} }
  }
}`;

const LABELS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) { nodes { id name } ${PAGE} }
  }
}`;

const ISSUES = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, states: [OPEN, CLOSED]) {
      nodes {
        id number title body state
        milestone { number }
        parent { number }
        blockedBy(first: 50) { nodes { number } }
        projectItems(first: 20) {
          nodes {
            id
            project { id }
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name ${FIELD_NAME} }
                ... on ProjectV2ItemFieldTextValue { text ${FIELD_NAME} }
                ... on ProjectV2ItemFieldNumberValue { number ${FIELD_NAME} }
              }
            }
          }
        }
      }
      ${PAGE}
    }
  }
}`;

const CREATE_ISSUE = `mutation($repositoryId: ID!, $title: String!, $body: String!, $labelIds: [ID!],
    $milestoneId: ID) {
  createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body,
      labelIds: $labelIds, milestoneId: $milestoneId }) {
    issue { id number }
  }
}`;

const ADD_SUB_ISSUE = `mutation($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { id } }
}`;

const ADD_BLOCKED_BY = `mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
}`;

const ADD_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

const SET_VALUE = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId,
      fieldId: $fieldId, value: $value }) {
    projectV2Item { id }
  }
}`;

const nodesOf = (gh, query, repo, pick) =>
  allNodes(gh, query, { owner: repo.owner, name: repo.name }, (data) =>
    pick(data.repository),
  );

/** An issue as the planner reads it, its board item that of `projectId` only. */
function toIssue(node, projectId) {
  const item = node.projectItems.nodes.find((i) => i.project?.id === projectId);
  const values = {};
  for (const v of item?.fieldValues.nodes ?? []) {
    if (v.field?.name) values[v.field.name] = v.name ?? v.text ?? v.number;
  }
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    body: node.body,
    open: node.state === 'OPEN',
    milestone: node.milestone?.number ?? null,
    parent: node.parent?.number ?? null,
    blockedBy: node.blockedBy.nodes.map((b) => b.number),
    item: item ? { id: item.id, values } : null,
  };
}

/** Everything the planner compares the file with. */
export function readRepoBacklog(gh, repo, projectId) {
  return {
    milestones: nodesOf(gh, MILESTONES, repo, (r) => r.milestones),
    labels: nodesOf(gh, LABELS, repo, (r) => r.labels),
    issues: nodesOf(gh, ISSUES, repo, (r) => r.issues).map((n) =>
      toIssue(n, projectId),
    ),
  };
}

/** The writes, each one call; every one returns the ids the next step needs. */
export function backlogWriter(gh, repo, project) {
  const path = `repos/${repo.owner}/${repo.name}`;
  return {
    createMilestone: (title, description) => {
      const made = rest(gh, 'POST', `${path}/milestones`, {
        title,
        description,
      });
      return { id: made.node_id, number: made.number };
    },
    setMilestoneDescription: (number, description) =>
      rest(gh, 'PATCH', `${path}/milestones/${number}`, { description }),
    createLabel: (label) => rest(gh, 'POST', `${path}/labels`, label).node_id,
    createIssue: (fields) =>
      graphql(gh, CREATE_ISSUE, { repositoryId: repo.id, ...fields })
        .createIssue.issue,
    addSubIssue: (parentId, childId) =>
      graphql(gh, ADD_SUB_ISSUE, { issueId: parentId, subIssueId: childId }),
    addBlockedBy: (issueId, blockingId) =>
      graphql(gh, ADD_BLOCKED_BY, { issueId, blockingIssueId: blockingId }),
    addToBoard: (contentId) =>
      graphql(gh, ADD_ITEM, { projectId: project.id, contentId })
        .addProjectV2ItemById.item.id,
    setValue: (itemId, fieldId, value) =>
      graphql(gh, SET_VALUE, { projectId: project.id, itemId, fieldId, value }),
  };
}

/** The `value` input for a field: a single-select option's id, a number or a text. */
export function fieldValueInput(field, value) {
  if (field.dataType === 'SINGLE_SELECT') {
    const option = field.options.find((o) => o.name === value);
    if (!option) {
      throw new Error(
        `the board's "${field.name}" has no option "${value}": run pnpm setup:board`,
      );
    }
    return { singleSelectOptionId: option.id };
  }
  if (field.dataType === 'NUMBER') return { number: Number(value) };
  return { text: String(value) };
}
