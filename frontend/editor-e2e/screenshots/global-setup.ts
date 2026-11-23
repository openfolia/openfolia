import { join } from 'node:path';
import { ROOT, startStack } from '../stack/stack.ts';

/**
 * The screenshots' own folder (runs, log, results): never the suite's `.local/editor-e2e/`, so a
 * run beside the suite's changes nothing it reads.
 */
export const SHOTS_DIR = join(ROOT, '.local', 'guide-screenshots');

/**
 * Starts a stack of the screenshots' own: the suite's (a fresh database with the example users,
 * the sample content, the built API and editor on ports the system picks), plus the page designs
 * and the safety leaflet `api:setup-local` adds, so the guide shows what a local set-up shows.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack({
    dir: SHOTS_DIR,
    content: async (contentDir, testing) => {
      await testing['addSamplePageDesigns'](contentDir);
      await testing['addSampleSafetyLeaflet'](contentDir);
    },
  });
  process.env['E2E_BASE_URL'] = stack.editorUrl;
  process.env['E2E_API_URL'] = stack.apiUrl;
  process.env['E2E_API_TOKEN'] = stack.token;
  console.log(
    `guide screenshots: API ${stack.apiUrl}, editor ${stack.editorUrl}`,
  );
  return () => stack.stop();
}
