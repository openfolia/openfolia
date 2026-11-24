import { startStack } from './stack.ts';

/**
 * Starts the stack once per run and hands it to the workers through the environment (they are
 * started after this, and inherit it). Returns the teardown that stops it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const started = Date.now();
  const stack = await startStack({ sandbox: true });
  process.env['E2E_BASE_URL'] = stack.editorUrl;
  process.env['E2E_API_URL'] = stack.apiUrl;
  process.env['E2E_API_TOKEN'] = stack.token;
  process.env['E2E_DATABASE_URL'] = stack.databaseUrl;
  process.env['E2E_SIGN_IN_URL'] = stack.signInEditorUrl;
  process.env['E2E_SANDBOX_URL'] = stack.sandboxEditorUrl;
  console.log(
    `editor-e2e: API ${stack.apiUrl}, editor ${stack.editorUrl} (up in ${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  return () => stack.stop();
}
