import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { serveStatic } from './static-server.ts';

/** Where `portal:build` put the fixture sites. */
export const FIXTURE_OUT = join(import.meta.dirname, '..', 'dist-fixture');

/**
 * Serves each audience's fixture sites (`dist-fixture/<audience>/`) at 127.0.0.1 on a port the
 * system picks, as a static host would, and hands the addresses to the workers through the
 * environment. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const servers: Server[] = [];
  for (const audience of ['public', 'internal', 'plain']) {
    const root = join(FIXTURE_OUT, audience);
    if (!existsSync(join(root, 'index.html')))
      throw new Error(
        `portal e2e: no built site in ${root}; run pnpm nx build portal first`,
      );
    const { url, server } = await serveStatic(root);
    process.env[`PORTAL_E2E_${audience.toUpperCase()}`] = url;
    servers.push(server);
  }
  return async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => server.close(() => resolve(undefined))),
      ),
    );
  };
}
