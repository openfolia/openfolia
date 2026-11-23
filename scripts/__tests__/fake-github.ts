// An in-memory GitHub behind the injected `gh` caller of scripts/gh-api.mjs: just the reads and
// writes scripts/board-github.mjs and scripts/backlog-github.mjs make, so the appliers run end to
// end in a test, twice, without the network. Every write is logged in `writes`.

interface Option {
  id: string;
  name: string;
  color: string;
  description: string;
}
interface Field {
  id: string;
  name: string;
  dataType: string;
  options?: Option[];
}
interface Project {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  url: string;
  repositoryIds: string[];
  fields: Field[];
}
interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  milestone: number | null;
  labels: string[];
  parent: number | null;
  blockedBy: number[];
  items: {
    id: string;
    projectId: string;
    values: Record<string, string | number>;
  }[];
}

export function fakeGitHub() {
  let next = 1;
  const id = (prefix: string) => `${prefix}${next++}`;
  const repo = { id: 'R1', owner: 'acme', name: 'app' };
  const state = {
    projects: [] as Project[],
    milestones: [] as {
      id: string;
      number: number;
      title: string;
      description: string;
    }[],
    labels: [{ id: 'L0', name: 'bug' }],
    issues: [] as Issue[],
    writes: [] as string[],
  };
  const page = <T>(nodes: T[]) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const fieldNode = (f: Field) => ({
    ...f,
    options: f.options?.map((o) => ({ ...o })),
  });
  const issueById = (issueId: string) =>
    state.issues.find((i) => i.id === issueId)!;
  const numberOf = (issueId: string) => issueById(issueId).number;

  function graphql(query: string, v: Record<string, unknown>) {
    const op = query.match(/\{\s*(\w+)/)?.[1];
    if (query.startsWith('mutation')) state.writes.push(op!);
    const project = () => state.projects.find((p) => p.id === v.projectId)!;
    switch (op) {
      case 'repositoryOwner': {
        if (v.login !== repo.owner) return { repositoryOwner: null };
        if (v.number == null)
          return {
            repositoryOwner: { id: 'O1', projectsV2: page(state.projects) },
          };
        const p = state.projects.find((x) => x.number === v.number);
        return {
          repositoryOwner: {
            projectV2: p && {
              ...p,
              repositories: page(p.repositoryIds.map((r) => ({ id: r }))),
              fields: page(p.fields.map(fieldNode)),
            },
          },
        };
      }
      case 'createProjectV2': {
        const p: Project = {
          id: id('P'),
          number: state.projects.length + 1,
          title: v.title as string,
          closed: false,
          url: 'https://github.com/x',
          repositoryIds: [v.repositoryId as string],
          fields: [
            {
              id: id('F'),
              name: 'Status',
              dataType: 'SINGLE_SELECT',
              options: ['Todo', 'In Progress', 'Done'].map((name) => ({
                id: id('o'),
                name,
                color: 'GRAY',
                description: '',
              })),
            },
          ],
        };
        state.projects.push(p);
        return {
          createProjectV2: { projectV2: { id: p.id, number: p.number } },
        };
      }
      case 'linkProjectV2ToRepository':
        project().repositoryIds.push(v.repositoryId as string);
        return {};
      case 'createProjectV2Field': {
        const options = (v.options as Option[] | null)?.map((o) => ({
          ...o,
          id: id('o'),
        }));
        const name = v.name as string;
        project().fields.push({
          id: id('F'),
          name,
          dataType: v.dataType as string,
          options,
        });
        return {};
      }
      case 'updateProjectV2Field': {
        const field = state.projects
          .flatMap((p) => p.fields)
          .find((f) => f.id === v.fieldId)!;
        field.options = (v.options as Option[]).map((o) => ({
          ...o,
          id: o.id ?? id('o'),
        }));
        return {};
      }
      case 'repository': {
        if (query.includes('milestones('))
          return { repository: { milestones: page(state.milestones) } };
        if (query.includes('labels('))
          return { repository: { labels: page(state.labels) } };
        if (query.includes('issue(number')) {
          const issue = state.issues.find((i) => i.number === v.number);
          return { repository: { issue: issue ? { id: issue.id } : null } };
        }
        return {
          repository: {
            issues: page(
              state.issues.map((i) => ({
                ...i,
                milestone: i.milestone == null ? null : { number: i.milestone },
                parent: i.parent == null ? null : { number: i.parent },
                blockedBy: page(i.blockedBy.map((number) => ({ number }))),
                projectItems: page(
                  i.items.map((item) => ({
                    id: item.id,
                    project: { id: item.projectId },
                    fieldValues: page(
                      Object.entries(item.values).map(([name, value]) => ({
                        field: { name },
                        ...(typeof value === 'number'
                          ? { number: value }
                          : { name: value }),
                      })),
                    ),
                  })),
                ),
              })),
            ),
          },
        };
      }
      case 'createIssue': {
        const milestone = state.milestones.find((m) => m.id === v.milestoneId);
        const issue: Issue = {
          id: id('I'),
          number: state.issues.length + 100,
          title: v.title as string,
          body: v.body as string,
          state: 'OPEN',
          milestone: milestone?.number ?? null,
          labels: v.labelIds as string[],
          parent: null,
          blockedBy: [],
          items: [],
        };
        state.issues.push(issue);
        return {
          createIssue: { issue: { id: issue.id, number: issue.number } },
        };
      }
      case 'addSubIssue':
        issueById(v.subIssueId as string).parent = numberOf(
          v.issueId as string,
        );
        return {};
      case 'addBlockedBy':
        issueById(v.issueId as string).blockedBy.push(
          numberOf(v.blockingIssueId as string),
        );
        return {};
      case 'addProjectV2ItemById': {
        const item = {
          id: id('PI'),
          projectId: v.projectId as string,
          values: {},
        };
        issueById(v.contentId as string).items.push(item);
        return { addProjectV2ItemById: { item: { id: item.id } } };
      }
      case 'updateProjectV2ItemFieldValue': {
        const item = state.issues
          .flatMap((i) => i.items)
          .find((x) => x.id === v.itemId);
        // GitHub's answer for an id it doesn't know (an item removed from the board).
        if (!item)
          throw new Error(
            `Could not resolve to a node with the global id of '${v.itemId}'`,
          );
        const field = project().fields.find((f) => f.id === v.fieldId)!;
        const value = v.value as {
          singleSelectOptionId?: string;
          number?: number;
          text?: string;
        };
        item.values[field.name] =
          field.options?.find((o) => o.id === value.singleSelectOptionId)
            ?.name ??
          value.number ??
          value.text!;
        return {};
      }
    }
    throw new Error(`fake GitHub: no ${op}`);
  }

  function restCall(
    method: string,
    path: string,
    body: Record<string, string>,
  ) {
    state.writes.push(`${method} ${path.split('/').slice(3).join('/')}`);
    if (path.endsWith('/milestones') && method === 'POST') {
      const m = {
        id: id('M'),
        number: state.milestones.length + 1,
        title: body.title,
        description: body.description,
      };
      state.milestones.push(m);
      return { node_id: m.id, number: m.number };
    }
    if (path.includes('/milestones/') && method === 'PATCH') {
      const m = state.milestones.find((x) => path.endsWith(`/${x.number}`))!;
      m.description = body.description;
      return m;
    }
    if (path.endsWith('/labels')) {
      const label = { id: id('L'), name: body.name };
      state.labels.push(label);
      return { node_id: label.id };
    }
    throw new Error(`fake GitHub: no ${method} ${path}`);
  }

  const gh = (args: string[], input?: string) => {
    const body = input ? JSON.parse(input) : undefined;
    if (args[0] === 'repo')
      return JSON.stringify({
        id: repo.id,
        name: repo.name,
        owner: { login: repo.owner },
      });
    if (args[1] === 'graphql')
      return JSON.stringify({ data: graphql(body.query, body.variables) });
    return JSON.stringify(restCall(args[2], args[3], body));
  };
  return { gh, repo, state };
}
