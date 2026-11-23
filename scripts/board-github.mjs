// The board on GitHub: reading a project and its fields, and applying scripts/board-plan.mjs's
// steps with the GraphQL API (Projects v2 has no REST API). `gh` is the injected caller of
// scripts/gh-api.mjs.
import { allNodes, graphql } from './gh-api.mjs';
import {
  describeStep,
  findProject,
  NEW_PROJECT_FIELDS,
  planBoard,
} from './board-plan.mjs';

const FIELD_NODE = `
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } }`;

const OWNER_PROJECTS = `query($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    id
    ... on ProjectV2Owner {
      projectsV2(first: 100, after: $after) {
        nodes { id number title closed }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const PROJECT = `query($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id number title url
        repositories(first: 100) { nodes { id } }
        fields(first: 100) { nodes { ${FIELD_NODE} } }
      }
    }
  }
}`;

const CREATE_PROJECT = `mutation($ownerId: ID!, $title: String!, $repositoryId: ID!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
    projectV2 { id number }
  }
}`;

const LINK_REPO = `mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
    repository { id }
  }
}`;

const CREATE_FIELD = `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!,
    $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType,
      singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2FieldCommon { id } }
  }
}`;

// Every option is sent with its id where it has one, so items keep their values; an option
// left out of the list is deleted (the planner leaves one out only on a project made now).
const UPDATE_OPTIONS = `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2FieldCommon { id } }
  }
}`;

/** The mutation and variables for one plan step. */
function stepRequest(step, { projectId, ownerId, repositoryId }) {
  if (step.kind === 'createProject') {
    return [CREATE_PROJECT, { ownerId, title: step.title, repositoryId }];
  }
  if (step.kind === 'linkRepo') return [LINK_REPO, { projectId, repositoryId }];
  if (step.kind === 'createField') {
    return [
      CREATE_FIELD,
      {
        projectId,
        name: step.name,
        dataType: step.dataType,
        options: step.options ?? null,
      },
    ];
  }
  return [UPDATE_OPTIONS, { fieldId: step.fieldId, options: step.options }];
}

/** The owner's node id and projects. */
export function readOwner(gh, login) {
  let id = null;
  const projects = allNodes(gh, OWNER_PROJECTS, { login }, (data) => {
    if (!data.repositoryOwner)
      throw new Error(`No GitHub user or organisation "${login}".`);
    id = data.repositoryOwner.id;
    return data.repositoryOwner.projectsV2;
  });
  return { id, projects };
}

/** A project with its linked repositories' ids and its fields; null when there is none. */
export function readProject(gh, login, number) {
  let project;
  try {
    project = graphql(gh, PROJECT, { login, number: Number(number) })
      .repositoryOwner?.projectV2;
  } catch (error) {
    // GitHub answers an unknown number with an error, not null.
    if (
      /Could not resolve to a ProjectV2/i.test(String(error?.message ?? error))
    )
      return null;
    throw error;
  }
  if (!project) return null;
  return {
    id: project.id,
    number: project.number,
    title: project.title,
    url: project.url,
    repositoryIds: project.repositories.nodes.map((r) => r.id),
    fields: project.fields.nodes.filter((f) => f.id),
  };
}

/**
 * Finds or makes the repo's board and fills in what it lacks. With `dryRun`, reads only and
 * logs the plan. Returns `{ number, problems }` (`number` null when a dry run would create it).
 * @param {{ gh: (args: string[], input?: string) => string,
 *   repo: { id: string, owner: string, name: string }, owner: string, title: string,
 *   number?: string | number | null, dryRun: boolean, log: (line: string) => void }} input
 * @returns {{ number: number | null, problems: string[] }}
 */
export function setupBoard({ gh, repo, owner, title, number, dryRun, log }) {
  const ownerInfo = readOwner(gh, owner);
  const found = findProject({ projects: ownerInfo.projects, title, number });
  if (found.problem) return { number: null, problems: [found.problem] };
  const ids = {
    ownerId: ownerInfo.id,
    repositoryId: repo.id,
    projectId: found.project?.id,
  };
  const repoName = `${repo.owner}/${repo.name}`;
  const run = (step) => {
    log(`${dryRun ? 'would ' : ''}${describeStep(step)}`);
    return dryRun ? null : graphql(gh, ...stepRequest(step, ids));
  };

  let project = found.project && readProject(gh, owner, found.project.number);
  const fresh = !project;
  if (fresh) {
    const made = run({ kind: 'createProject', title, repo: repoName });
    if (dryRun) {
      // Against the fields GitHub gives a new project, as the real run will find them.
      planBoard({
        fields: NEW_PROJECT_FIELDS,
        freshProject: true,
      }).steps.forEach((step) => run(step));
      return { number: null, problems: [] };
    }
    project = readProject(gh, owner, made.createProjectV2.projectV2.number);
    ids.projectId = project.id;
  } else {
    log(
      `found the project #${project.number} "${project.title}" (${project.url})`,
    );
    if (!project.repositoryIds.includes(repo.id))
      run({ kind: 'linkRepo', repo: repoName });
  }

  const plan = planBoard({ fields: project.fields, freshProject: fresh });
  plan.notes.forEach((note) => log(note));
  plan.steps.forEach((step) => run(step));
  if (!plan.steps.length) log('every field and option is there already');
  return { number: project.number, problems: plan.problems };
}
