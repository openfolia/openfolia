import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolError, type ContentApi } from './api-client.js';
import {
  checkRefForm,
  RELEASED_BRANCH,
  ReleasedRefs,
  TokenCheck,
} from './released.js';
import { getChunksTool, readModuleTool } from './tools/chunks.js';
import { listReleasesTool, listVariantsTool } from './tools/lists.js';
import {
  listDownloadsTool,
  listDownloadVersionsTool,
} from './tools/downloads.js';
import {
  languagesAt,
  listManualsTool,
  ManualPage,
  manualMarkdown,
  readManualTool,
} from './tools/manuals.js';
import { searchTool } from './tools/search.js';
import {
  Id,
  Lang,
  nextPage,
  PageCursor,
  pageOf,
  sliceText,
  VariantSlug,
  type ToolContext,
  type ToolDefinition,
} from './tools/tool.js';
import { parseAnswer } from './api-client.js';

/** The server's name and version, as it introduces itself to clients. */
export const SERVER_INFO = { name: 'openfolia', version: '0.0.1' } as const;

/** Every tool, in the order `tools/list` gives them. */
export const TOOLS = [
  searchTool,
  readModuleTool,
  listManualsTool,
  readManualTool,
  getChunksTool,
  listVariantsTool,
  listReleasesTool,
  listDownloadsTool,
  listDownloadVersionsTool,
] as const;

/** Tool calls run at once; more wait, up to `MAX_WAITING`. */
export const MAX_RUNNING = 8;
export const MAX_WAITING = 32;
/** Manuals per page of `resources/list` (each listed once per variant and language). */
export const RESOURCES_PAGE_SIZE = 20;
/** The most characters of a manual a resource read gives (`_meta.truncated` past it). */
export const RESOURCE_TEXT_LIMIT = 500_000;

/** Bounds how many tool calls run at once in this process; past the queue, a call is refused. */
export class Limiter {
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(
    private readonly maxRunning = MAX_RUNNING,
    private readonly maxWaiting = MAX_WAITING,
  ) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#running >= this.maxRunning) {
      if (this.#waiting.length >= this.maxWaiting) {
        throw new ToolError(
          'busy',
          'Too many calls at once',
          'The server is answering as many calls as it takes; try again shortly.',
          429,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', leave);
          resolve();
        };
        // A call given up while waiting leaves the queue.
        const leave = () => {
          const at = this.#waiting.indexOf(wake);
          if (at !== -1) this.#waiting.splice(at, 1);
          reject(
            new ToolError(
              'cancelled',
              'The call was cancelled or ran past its deadline',
            ),
          );
        };
        if (signal?.aborted) return leave();
        signal?.addEventListener('abort', leave, { once: true });
        this.#waiting.push(wake);
      });
    } else {
      this.#running++;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      // The slot passes straight to the next call waiting.
      if (next) next();
      else this.#running--;
    }
  }
}

/** What one process shares between the servers it makes (one per HTTP request). */
export interface McpContext extends ToolContext {
  readonly limiter: Limiter;
}

export function createContext(api: ContentApi): McpContext {
  return {
    api,
    refs: new ReleasedRefs(api),
    token: new TokenCheck(api),
    limiter: new Limiter(),
  };
}

/** A tool's error as MCP gives it: `isError`, the code and what the API said, nothing more. */
export function errorResult(error: unknown): CallToolResult {
  const e =
    error instanceof ToolError
      ? error
      : new ToolError('internal-error', 'The tool failed');
  const structured = {
    error: {
      code: e.code,
      title: e.title,
      ...(e.detail !== undefined && { detail: e.detail }),
      ...(e.status !== undefined && { status: e.status }),
      ...(e.retryAfter !== undefined && { retryAfter: e.retryAfter }),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** The most one call (a tool, a resource read or list) may take, waiting included. */
export const CALL_TIMEOUT_MS = 120_000;

/**
 * Runs a call: within the limiter, after checking the server's own token
 * holds `content.read` alone, with the API read through `signal` (the
 * client's cancellation, or closing the HTTP request) and the call's
 * deadline, so a call given up stops reading and frees its place.
 */
async function guarded<T>(
  context: McpContext,
  signal: AbortSignal | undefined,
  task: (api: ContentApi, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const until = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const api: ContentApi = {
    baseUrl: context.api.baseUrl,
    get: (path, query) => context.api.get(path, query, until),
  };
  return context.limiter.run(async () => {
    await context.token.ensure(until);
    return task(api, until);
  }, until);
}

/**
 * The MCP server over the released content: the tools in `TOOLS` and each
 * manual as a resource (`openfolia://manuals/<id>/<variant>/<lang>`). Read-only:
 * every call is a GET to the API with the server's service account token.
 */
export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
  });
  for (const tool of TOOLS as readonly ToolDefinition[]) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (
        args: Record<string, unknown>,
        extra: { signal?: AbortSignal },
      ): Promise<CallToolResult> => {
        try {
          // A ref that can never be released content is refused before any API call.
          if (typeof args['ref'] === 'string') checkRefForm(args['ref']);
          const output = await guarded(context, extra.signal, (api, signal) =>
            tool.run({ ...context, api, signal }, args as never),
          );
          return {
            content: [
              {
                type: 'text',
                text: output.text ?? JSON.stringify(output.structured),
              },
            ],
            structuredContent: output.structured,
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
  registerManualResources(server, context);
  return server;
}

const RESOURCE_TEMPLATE = 'openfolia://manuals/{id}/{variant}/{lang}';

/** `openfolia://manuals/<id>/<variant>/<lang>`, the variant slug percent-encoded. */
export function manualUri(id: string, variant: string, lang: string): string {
  return `openfolia://manuals/${id}/${encodeURIComponent(variant)}/${lang}`;
}

function parseManualUri(uri: string) {
  const match = /^openfolia:\/\/manuals\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(
    uri,
  );
  const decode = (part: string | undefined) => {
    try {
      return decodeURIComponent(part ?? '');
    } catch {
      return '';
    }
  };
  const id = Id.safeParse(decode(match?.[1]));
  const variant = VariantSlug.safeParse(decode(match?.[2]));
  const lang = Lang.safeParse(decode(match?.[3]));
  if (!match || !id.success || !variant.success || !lang.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Not a manual resource: ${RESOURCE_TEMPLATE}`,
    );
  }
  return { id: id.data, variant: variant.data, lang: lang.data };
}

/** Resources through the protocol's own handlers, so `resources/list` pages like every list. */
function registerManualResources(server: McpServer, context: McpContext) {
  const toMcpError = (error: unknown) => {
    const e = error instanceof ToolError ? error : undefined;
    return new McpError(
      e?.status === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
      e ? `${e.code}: ${e.detail ?? e.title}` : 'internal-error',
      e && {
        code: e.code,
        ...(e.status !== undefined && { status: e.status }),
      },
    );
  };
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: RESOURCE_TEMPLATE,
        name: 'manual',
        title: 'A released manual for a variant and language',
        description:
          'A manual at `main`, resolved for a variant and language, as Markdown (as `read_manual` gives it).',
        mimeType: 'text/markdown',
      },
    ],
  }));
  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    async (request, extra) => {
      const cursor = PageCursor.safeParse(request.params?.cursor);
      if (request.params?.cursor !== undefined && !cursor.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Not a cursor this server gave',
        );
      }
      try {
        return await guarded(context, extra.signal, async (api) => {
          const [{ body }, languages] = await Promise.all([
            api.get('/manuals', {
              ref: RELEASED_BRANCH,
              'page[number]': String(pageOf(cursor.data)),
              'page[size]': String(RESOURCES_PAGE_SIZE),
            }),
            languagesAt(api, RELEASED_BRANCH),
          ]);
          const page = parseAnswer(ManualPage, body);
          const next = nextPage(page.meta.page);
          return {
            resources: page.data.flatMap((m) =>
              !m.attributes
                ? []
                : (m.meta?.variants ?? []).flatMap((v) =>
                    languages.map((lang) => ({
                      uri: manualUri(m.id, v.slug, lang),
                      name: `${m.id}/${v.slug}/${lang}`,
                      title: `${titleIn(m.attributes?.title, lang, languages[0]) ?? m.id} (${v.label}, ${lang})`,
                      mimeType: 'text/markdown',
                    })),
                  ),
            ),
            ...(next !== null && { nextCursor: next }),
          };
        });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
  server.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request, extra) => {
      const { id, variant, lang } = parseManualUri(request.params.uri);
      try {
        return await guarded(context, extra.signal, async (api) => {
          const manual = await manualMarkdown(
            api,
            RELEASED_BRANCH,
            id,
            variant,
            lang,
          );
          const slice = sliceText(
            manual.markdown,
            undefined,
            RESOURCE_TEXT_LIMIT,
          );
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'text/markdown',
                text: slice.text,
                _meta: {
                  commit: manual.commit,
                  truncated: slice.nextCursor !== null,
                },
              },
            ],
          };
        });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

/** A manual's title in `lang` (#731): its own there, else the source language's (the first configured), else its first. */
function titleIn(
  title: string | Record<string, string> | undefined,
  lang: string,
  source?: string,
): string | undefined {
  if (title === undefined || typeof title === 'string') return title;
  return (
    title[lang] ??
    (source === undefined ? undefined : title[source]) ??
    Object.values(title)[0]
  );
}
