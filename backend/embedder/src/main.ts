#!/usr/bin/env node
import { loadOnnxModel } from './onnx-model.js';
import { filesWithTelemetry } from './runtime-check.js';
import { EMBEDDINGS_PATH, startEmbedderServer } from './server.js';
import { loadSettings } from './settings.js';

/**
 * `node dist/main.js`: loads the model once, then serves
 * `POST /v1/embeddings`. `node dist/main.js --check-runtime`: fails when the
 * installed ONNX Runtime holds a usage-data client (the image's build runs
 * it). Logs go to stderr and never hold a text.
 */
async function main(argv: string[]): Promise<void> {
  if (argv.includes('--check-runtime')) {
    const found = await filesWithTelemetry();
    if (found.length > 0) {
      throw new Error(
        `The ONNX Runtime has a usage-data client: ${found.join(', ')}. Use a version without one (backend/embedder/README.md).`,
      );
    }
    console.error('The ONNX Runtime has no usage-data client.');
    return;
  }
  if (argv.length > 0) {
    throw new Error(`Unknown arguments: ${argv.join(' ')}`);
  }
  // The pinned runtime has no usage-data client; should another ever get in,
  // this turns it off before it loads.
  process.env['ORT_DISABLE_TELEMETRY'] = '1';
  const settings = loadSettings();
  const started = performance.now();
  const model = await loadOnnxModel(settings);
  const server = await startEmbedderServer(model, {
    model: settings.CCMS_EMBEDDER_MODEL,
    queue: settings.CCMS_EMBEDDER_QUEUE,
    host: settings.CCMS_EMBEDDER_HOST,
    port: settings.CCMS_EMBEDDER_PORT,
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address
      ? address.port
      : settings.CCMS_EMBEDDER_PORT;
  console.error(
    `Embedding worker: model loaded in ${Math.round(performance.now() - started)} ms (${settings.CCMS_EMBEDDER_DIMENSIONS} dimensions), on http://${settings.CCMS_EMBEDDER_HOST}:${port}${EMBEDDINGS_PATH}`,
  );
  const stop = () => {
    server.close(() => {
      void model.close().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
