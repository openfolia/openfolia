// `pnpm nx run portal:site`: one audience's portal, a site per language, from the API at its
// releases (frontend/portal/README.md; the settings in .env.example, "Portal"). Exits 1 with
// the reason, and writes nothing, when the build is refused (the token reads more than the
// audience, or the API gave content above it) or fails.
import { buildPortal } from '../build/run.ts';
import { readSettings } from '../build/settings.ts';

try {
  const settings = readSettings(process.env, process.cwd());
  // Held by the client only: no child process (Astro, Pagefind) inherits it.
  delete process.env['CCMS_PORTAL_TOKEN'];
  await buildPortal(settings);
  console.log(
    `Portal for "${settings.audience}" written to ${settings.outDir}`,
  );
} catch (error) {
  // The message only: no stack (which could show values), never the settings.
  console.error(
    `Portal build failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
}
