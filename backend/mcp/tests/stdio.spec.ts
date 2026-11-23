import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chunk, paged, StubApi } from './stub-api.js';

/**
 * The protocol over stdio, as a desktop assistant uses it: the SDK's client
 * starts the built server (`dist/main.js`) as a child process, which reads
 * a stub content API over HTTP.
 */
const MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');
const API_TOKEN = 'ccms_sat_0123456789abcdef_' + 'f'.repeat(64);

let api: Server;
let apiUrl: string;
const seen: { path: string; authorization: string | undefined }[] = [];
beforeAll(async () => {
  const stub = new StubApi();
  stub.set(
    '/chunks',
    paged([
      chunk('charging', 'en', '# Charging\n\n> **CAUTION:** Hot surface'),
    ]),
  );
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname, authorization: req.headers.authorization });
    const query = Object.fromEntries(url.searchParams);
    stub.get(url.pathname, query).then(
      ({ body }) => {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.api+json',
          'X-Ccms-Commit': 'c'.repeat(40),
        });
        res.end(JSON.stringify(body));
      },
      () => {
        res.writeHead(404, { 'Content-Type': 'application/vnd.api+json' });
        res.end(
          JSON.stringify({
            errors: [{ status: '404', code: 'not-found', title: 'Not found' }],
          }),
        );
      },
    );
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())));

describe('over stdio', () => {
  it('lists the tools and reads a module through the API, sending its token on every request', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: { CCMS_MCP_API_URL: apiUrl, CCMS_MCP_API_TOKEN: API_TOKEN },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('read_module');
    const result = await client.callTool({
      name: 'read_module',
      arguments: { id: 'charging', lang: 'en' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0]?.text).toContain(
      '**CAUTION:**',
    );
    const refused = await client.callTool({
      name: 'read_module',
      arguments: {
        id: 'charging',
        lang: 'en',
        ref: 'change-sets/0190a1b2c3d4',
      },
    });
    expect(refused.isError).toBe(true);
    await client.close();
    // The token's permissions are checked once a minute; the change set's branch reached no API.
    expect(seen.map((s) => s.path)).toEqual(['/me', '/chunks']);
    expect(new Set(seen.map((s) => s.authorization))).toEqual(
      new Set([`Bearer ${API_TOKEN}`]),
    );
  });

  it('exits with a message naming the missing settings, never starting without them', async () => {
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(process.execPath, [MAIN], {
      env: {},
      encoding: 'utf8',
      input: '',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/CCMS_MCP_API_URL/);
  });
});
