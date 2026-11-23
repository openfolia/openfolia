import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Strings only a build of ONNX Runtime with its usage-data client has
 * (the client and its upload endpoint). Version 1.29 added one, which
 * sends usage data unless `ORT_DISABLE_TELEMETRY` is set; this worker
 * pins 1.27.0, whose libraries do not even link a network call
 * (`backend/embedder/README.md`, "No network").
 */
export const TELEMETRY_MARKERS = ['OneCollector', 'telemetry_1ds'];

/** The folder of ONNX Runtime's native libraries, as installed. */
export function runtimeLibraryDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve('onnxruntime-node')),
    '..',
    'bin',
  );
}

/**
 * The native files under `dir` that hold a telemetry marker, as paths
 * relative to it: empty when the runtime has no usage-data client. The
 * image's build and a test run it, so a version bump that brings one back
 * fails.
 */
export async function filesWithTelemetry(
  dir: string = runtimeLibraryDir(),
): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(file);
    if (TELEMETRY_MARKERS.some((marker) => bytes.includes(marker))) {
      found.push(path.relative(dir, file));
    }
  }
  return found.sort();
}
