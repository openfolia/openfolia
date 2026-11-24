// The agent (README.md, "The agent"): `node dist/agent-main.js`, beside the Docker socket.
import { createAgentServer, DockerRuntime } from './agent.js';
import { DockerSocket } from './docker.js';
import { jsonLogger } from './log.js';
import { agentSettings, SettingsError } from './settings.js';

const log = jsonLogger('agent');

try {
  const settings = agentSettings();
  const runtime = new DockerRuntime(
    new DockerSocket(settings.dockerSocket),
    settings,
    log,
  );
  const server = createAgentServer(runtime, settings.agentToken, log);
  server.listen(settings.port, settings.host, () =>
    log.info('listening', { host: settings.host, port: settings.port }),
  );
  const stop = () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (error) {
  log.error('stopped', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(error instanceof SettingsError ? 64 : 1);
}
