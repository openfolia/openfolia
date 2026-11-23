import { chunk, connectClient, paged, stubContext } from '../tests/stub-api.js';
import { ToolError } from './api-client.js';
import { Limiter, manualUri, TOOLS } from './server.js';

describe('the MCP server', () => {
  it('lists every tool as read-only, each with a description and an input schema', async () => {
    const mcp = await connectClient(stubContext());
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual([
      'search',
      'read_module',
      'list_manuals',
      'read_manual',
      'get_chunks',
      'list_variants',
      'list_releases',
      'list_downloads',
      'list_download_versions',
    ]);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/\S{20,}|.{80,}/);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
    await mcp.close();
  });

  it('refuses every call while its API token holds more than content.read, before reading content', async () => {
    const context = stubContext();
    context.api.set('/me', {
      data: {
        type: 'Actor',
        id: 'service:agent',
        meta: {
          permissions: [
            { permission: 'content.read' },
            { permission: 'content.edit' },
          ],
        },
      },
    });
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('list_manuals');
    expect(isError).toBe(true);
    expect(structured['error']).toMatchObject({ code: 'token-not-read-only' });
    expect(context.api.calls.map((c) => c.path)).toEqual(['/me']);
    await expect(mcp.client.listResources()).rejects.toThrow(
      /token-not-read-only/,
    );
    await mcp.close();
  });

  it('gives an unexpected failure as internal-error, without its message', async () => {
    const context = stubContext();
    context.api.set('/variants', () => {
      throw new Error('secret detail at /srv/app.js:1:1');
    });
    const mcp = await connectClient(context);
    const { isError, text } = await mcp.call('list_variants');
    expect(isError).toBe(true);
    expect(text).toBe(
      '{"error":{"code":"internal-error","title":"The tool failed"}}',
    );
    await mcp.close();
  });

  it('lists each manual per variant and language as a resource, paged, and reads one as Markdown', async () => {
    const context = stubContext();
    context.api.set(
      '/manuals',
      paged(
        [
          {
            type: 'Manual',
            id: 'operating',
            attributes: { title: 'Operating manual', entries: [] },
            meta: {
              variants: [{ slug: 'model=large', label: 'Large', values: {} }],
              issues: [],
            },
          },
          { type: 'Manual', id: 'broken', meta: { error: 'x' } },
        ],
        { currentPage: 1, lastPage: 2 },
      ),
    );
    const mcp = await connectClient(context);
    const list = await mcp.client.listResources();
    expect(list.resources.map((r) => r.uri)).toEqual([
      'openfolia://manuals/operating/model%3Dlarge/en',
      'openfolia://manuals/operating/model%3Dlarge/de',
    ]);
    expect(list.nextCursor).toBe('2');
    await mcp.client.listResources({ cursor: '2' });
    expect(
      context.api.callsTo('/manuals').map((q) => q['page[number]']),
    ).toEqual(['1', '2']);
    const templates = await mcp.client.listResourceTemplates();
    expect(templates.resourceTemplates[0]?.uriTemplate).toBe(
      'openfolia://manuals/{id}/{variant}/{lang}',
    );

    context.api.set('/manuals/operating/variants/model%3Dlarge/en', {
      data: {
        attributes: {
          title: 'Operating manual',
          lang: 'en',
          entries: [
            {
              kind: 'module',
              module: 'charging',
              title: 'Charging',
              lang: 'en',
              blocks: [],
            },
          ],
        },
      },
    });
    context.api.set('/chunks', paged([chunk('charging', 'en', '# Charging')]));
    const read = await mcp.client.readResource({
      uri: manualUri('operating', 'model=large', 'en'),
    });
    expect(read.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      _meta: { truncated: false },
    });
    expect((read.contents[0] as { text: string }).text).toContain('# Charging');
    await expect(
      mcp.client.readResource({ uri: 'openfolia://manuals/../x/en' }),
    ).rejects.toThrow(/Not a manual resource/);
    await mcp.close();
  });
});

describe('refs and cancelling', () => {
  it('refuses a change set’s branch before any API call at all, the token check included', async () => {
    const context = stubContext();
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('read_module', {
      id: 'charging',
      lang: 'en',
      ref: 'change-sets/0190a1b2c3d4',
    });
    expect(isError).toBe(true);
    expect(structured['error']).toMatchObject({ code: 'ref-not-released' });
    expect(context.api.calls).toEqual([]);
    await mcp.close();
  });

  it('refuses a variant that is no slug, such as a dot segment, before any API call', async () => {
    const context = stubContext();
    const mcp = await connectClient(context);
    for (const variant of ['..', '.', 'model', 'model=large,']) {
      const { isError } = await mcp.call('read_manual', {
        id: 'operating',
        variant,
        lang: 'en',
      });
      expect(isError, variant).toBe(true);
    }
    expect(context.api.calls).toEqual([]);
    await mcp.close();
  });
});

describe('Limiter', () => {
  it('lets a call given up while waiting leave the queue', async () => {
    const limiter = new Limiter(1, 1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    const waiting = limiter.run(async () => 'never', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    // Its place in the queue is free again.
    const next = limiter.run(async () => 'next');
    release();
    await first;
    await expect(next).resolves.toBe('next');
  });

  it('runs at most so many at once, queues some, and refuses past the queue', async () => {
    const limiter = new Limiter(1, 1);
    let release!: () => void;
    const first = limiter.run(
      () => new Promise<string>((r) => (release = () => r('first'))),
    );
    const second = limiter.run(async () => 'second');
    await expect(limiter.run(async () => 'third')).rejects.toBeInstanceOf(
      ToolError,
    );
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    await expect(limiter.run(async () => 'again')).resolves.toBe('again');
  });
});
