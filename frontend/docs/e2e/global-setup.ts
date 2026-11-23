import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from './static-server.ts';

/**
 * Serves the built site (`out/`, from `docs:build`) on a port the system picks, at 127.0.0.1 as
 * the repository's other servers are reached, and hands its address to the workers through the
 * environment. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const out = join(import.meta.dirname, '..', 'out');
  if (!existsSync(join(out, 'index.html')))
    throw new Error(
      `docs e2e: no built site in ${out}; run pnpm nx build docs first`,
    );
  const { url, server } = await serveStatic(out);
  process.env['DOCS_E2E_URL'] = url;
  return () => new Promise((resolve) => server.close(() => resolve()));
}
