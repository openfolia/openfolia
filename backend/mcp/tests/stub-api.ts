import {
  ToolError,
  type ApiResponse,
  type ContentApi,
  type Query,
} from '../src/api-client.js';
import { createContext, type McpContext } from '../src/server.js';

export const COMMIT = 'c'.repeat(40);

type Answer = unknown | ToolError | ((query: Query) => unknown);

/**
 * The content API as a table of answers by path (a body, a `ToolError` to
 * throw, or a function of the query); records every call. `/me`, `/refs`,
 * `/releases` and `/config` answer as a `content.read` token at a sample
 * with tag `v1` and a withdrawn release `v0` unless a test sets them.
 */
export class StubApi implements ContentApi {
  readonly baseUrl = 'http://api.test';
  readonly calls: { path: string; query: Query }[] = [];
  readonly answers = new Map<string, Answer>([
    [
      '/me',
      {
        data: {
          type: 'Actor',
          id: 'service:agent',
          meta: { permissions: [{ permission: 'content.read', scopes: [{}] }] },
        },
      },
    ],
    [
      '/refs',
      paged([
        {
          type: 'Ref',
          id: 'heads/main',
          attributes: { kind: 'branch', name: 'main', commit: COMMIT },
        },
        {
          type: 'Ref',
          id: 'tags/v1',
          attributes: { kind: 'tag', name: 'v1', commit: COMMIT },
        },
        {
          type: 'Ref',
          id: 'tags/v0',
          attributes: { kind: 'tag', name: 'v0', commit: COMMIT },
        },
      ]),
    ],
    [
      '/releases',
      paged([
        release('r1', 'v1', null),
        release('r0', 'v0', {
          by: { kind: 'user', id: 'x' },
          at: '2026-01-02T00:00:00.000Z',
          reason: 'Wrong torque values.',
        }),
      ]),
    ],
    [
      '/config',
      {
        data: {
          type: 'ProjectConfig',
          id: 'config',
          attributes: { languages: { source: 'en', targets: ['de'] } },
        },
      },
    ],
  ]);

  set(path: string, answer: Answer): this {
    this.answers.set(path, answer);
    return this;
  }

  /** The calls to `path`, without the lookups every tool makes. */
  callsTo(path: string): Query[] {
    return this.calls.filter((c) => c.path === path).map((c) => c.query);
  }

  async get(path: string, query: Query = {}): Promise<ApiResponse> {
    this.calls.push({ path, query });
    const answer = this.answers.get(path);
    if (answer === undefined) {
      throw new ToolError('not-found', 'Not found', `No stub for ${path}`, 404);
    }
    if (answer instanceof ToolError) throw answer;
    const body: unknown = await (typeof answer === 'function'
      ? (answer as (q: Query) => unknown)(query)
      : answer);
    if (body instanceof ToolError) throw body;
    return { body, commit: COMMIT };
  }
}

export function stubContext(
  api = new StubApi(),
): McpContext & { api: StubApi } {
  return { ...createContext(api), api };
}

/** A JSON:API page of `data`. */
export function paged(data: unknown[], page = { currentPage: 1, lastPage: 1 }) {
  return {
    data,
    meta: {
      page: {
        ...page,
        perPage: 50,
        total: data.length + (page.lastPage - 1) * 50,
      },
    },
    links: {},
  };
}

export function release(id: string, tag: string, withdrawal: unknown) {
  return {
    type: 'Release',
    id,
    attributes: {
      product: 'tugger',
      productFacet: 'product-line',
      revision: tag,
      tag,
      tagObject: 'a'.repeat(40),
      commit: COMMIT,
      notes: null,
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'x' },
      publishedAt: '2026-01-01T00:00:00.000Z',
      withdrawal,
    },
  };
}

export function chunk(
  moduleId: string,
  lang: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'Chunk',
    id: `${lang}/${moduleId}`,
    attributes: {
      moduleId,
      lang,
      title: moduleId,
      moduleType: 'procedure',
      audience: 'public',
      facets: {},
      keywords: [],
      manuals: [],
      conditions: [],
      text,
      sourceHash: '0'.repeat(64),
      contentHash: '1'.repeat(64),
      ...extra,
    },
    relationships: {
      module: {
        data: { type: 'Module', id: `${lang}/${moduleId}` },
        links: { related: '' },
      },
    },
    meta: {
      ref: 'main',
      commit: COMMIT,
      sources: [],
      release: { tag: 'v1', commit: COMMIT, same: true },
    },
  };
}

/** A real SDK client connected to a server made from `context`, in memory. */
export async function connectClient(context: McpContext) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } =
    await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../src/server.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(context);
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    /** Calls a tool; its structured answer, and whether it is an error. */
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        structured: result.structuredContent as Record<string, any>,
        text:
          (result.content as { type: string; text: string }[])[0]?.text ?? '',
      };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
