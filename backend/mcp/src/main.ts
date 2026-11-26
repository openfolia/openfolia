#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpContentApi } from './api-client.js';
import { isLoopback, MCP_PATH, startHttpServer } from './http.js';
import { ProxyAddresses } from './proxies.js';
import { createContext, createMcpServer, Limiter } from './server.js';
import { loadSettings } from './settings.js';

/**
 * `openfolia-mcp` (stdio, for a desktop assistant that starts it) or
 * `openfolia-mcp --http` (Streamable HTTP). Logs go to stderr: on stdio, stdout
 * carries the protocol.
 */
async function main(argv: string[]): Promise<void> {
  const http = argv.includes('--http');
  const unknown = argv.filter((a) => a !== '--http' && a !== '--stdio');
  if (unknown.length > 0) {
    throw new Error(
      `Unknown arguments: ${unknown.join(' ')} (use --stdio or --http)`,
    );
  }
  if (http) {
    const settings = loadSettings('http');
    warnOnPlainHttp(settings.CCMS_MCP_API_URL);
    // One limiter for every caller: the bound on calls at once is the process's.
    const limiter = new Limiter();
    const apiUrl = settings.CCMS_MCP_API_URL;
    if (settings.CCMS_MCP_API_TOKEN !== undefined) {
      console.error(
        'Note: CCMS_MCP_API_TOKEN is not used over HTTP: each caller sends its own service account token.',
      );
    }
    const proxies = new ProxyAddresses(settings.CCMS_MCP_HTTP_PROXY_ADDRESSES);
    await proxies.refresh();
    const server = await startHttpServer({
      host: settings.CCMS_MCP_HTTP_HOST,
      port: settings.CCMS_MCP_HTTP_PORT,
      callerContext: (token) =>
        createContext(new HttpContentApi(apiUrl, token), limiter),
      allowedOrigins: settings.CCMS_MCP_HTTP_ALLOWED_ORIGINS,
      trustProxy: { hops: settings.CCMS_MCP_HTTP_TRUST_PROXY, proxies },
    });
    const address = server.address();
    const port =
      typeof address === 'object' && address
        ? address.port
        : settings.CCMS_MCP_HTTP_PORT;
    if (!isLoopback(settings.CCMS_MCP_HTTP_HOST)) {
      console.error(
        `Warning: listening on ${settings.CCMS_MCP_HTTP_HOST}, not only on this machine; put TLS in front of it.`,
      );
    }
    console.error(
      `MCP server (Streamable HTTP) on http://${settings.CCMS_MCP_HTTP_HOST}:${port}${MCP_PATH}`,
    );
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const settings = loadSettings('stdio');
  warnOnPlainHttp(settings.CCMS_MCP_API_URL);
  const context = createContext(
    new HttpContentApi(settings.CCMS_MCP_API_URL, settings.CCMS_MCP_API_TOKEN),
  );
  await createMcpServer(context).connect(new StdioServerTransport());
}

/** The token travels in clear over plain HTTP: fine on this machine only. */
function warnOnPlainHttp(apiUrl: string): void {
  const url = new URL(apiUrl);
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    console.error(
      `Warning: CCMS_MCP_API_URL uses plain HTTP to ${url.hostname}; the token is sent unencrypted.`,
    );
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Failed to start');
  process.exit(1);
});
