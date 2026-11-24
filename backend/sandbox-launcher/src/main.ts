// The launcher (README.md): `node dist/main.js`, its settings from the environment.
import { loadAssets } from './assets.js';
import { jsonLogger } from './log.js';
import { AgentRuntime } from './runtime.js';
import { Sandboxes } from './sandboxes.js';
import { createLauncherServer } from './server.js';
import { launcherSettings, SettingsError } from './settings.js';

const SWEEP_MS = 15_000;
const log = jsonLogger('launcher');

async function main(): Promise<void> {
  const settings = launcherSettings();
  const runtime = new AgentRuntime(settings.agentUrl, settings.agentToken);
  const sandboxes = new Sandboxes(runtime, settings, log);
  // Every sandbox left from an earlier run goes first: no cookie names it any more.
  for (let attempt = 1; ; attempt++) {
    try {
      await sandboxes.reset();
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      log.error('agent-unreachable', {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const server = createLauncherServer({
    settings,
    sandboxes,
    assets: loadAssets(),
    log,
  });
  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sandboxes.sweep().finally(() => (sweeping = false));
  }, SWEEP_MS);
  server.listen(settings.port, settings.host, () =>
    log.info('listening', {
      host: settings.host,
      port: settings.port,
      capacity: settings.maxSandboxes,
    }),
  );
  const stop = () => {
    clearInterval(sweep);
    server.close();
    server.closeAllConnections();
    void sandboxes.removeAll().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  log.error('stopped', {
    error:
      error instanceof SettingsError || error instanceof Error
        ? error.message
        : String(error),
  });
  process.exit(error instanceof SettingsError ? 64 : 1);
});
