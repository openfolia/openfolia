import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '@openfolia/content-model';
import { bundleFiles, convertDita, DocumentTooLargeError } from './convert.js';

/** Bounds of a conversion in its own process (`convertDitaIsolated`). */
export interface IsolationLimits {
  /** The child's JavaScript heap (old space), in MiB: past it, the child dies, not the server. The input's bytes come on top. */
  readonly maxMemoryMb: number;
  /** The longest a conversion may take, in milliseconds: then the child is killed. */
  readonly timeoutMs: number;
  /**
   * The largest `import.json` the child may answer with, in bytes: past it,
   * a `ConversionLimitError` `size`, so the server never receives more.
   */
  readonly maxDocumentBytes?: number;
}

/** A conversion stopped by its process's bounds: the project is too large (or too costly) to convert. */
export class ConversionLimitError extends Error {
  constructor(
    readonly reason: 'memory' | 'timeout' | 'size',
    message: string,
  ) {
    super(message);
    this.name = 'ConversionLimitError';
  }
}

const CHILD_ARG = 'openfolia-dita-convert';
const SELF = fileURLToPath(import.meta.url);
/** Started from the TypeScript sources (tests), the child needs them made runnable. */
const FROM_SOURCE = SELF.endsWith('.ts');
const SOURCE_FLAGS = [
  '--experimental-transform-types',
  '--conditions=@openfolia/source',
  '--import',
  new URL('../../source-hooks.mjs', import.meta.url).href,
];

type Request = {
  readonly files: Map<string, Uint8Array>;
  readonly config: ProjectConfig;
  readonly maxDocumentBytes?: number;
};
type Response =
  | { readonly ok: true; readonly files: Map<string, Uint8Array> }
  | {
      readonly ok: false;
      readonly size: boolean;
      readonly message: string;
    };

/**
 * `bundleFiles(convertDita(files, config))` in a child process of its own:
 * whatever an archive makes the conversion cost, the server's event loop
 * and heap stay free. The child's heap is capped (`maxMemoryMb`) and it is
 * killed after `timeoutMs`; either is a `ConversionLimitError`. Nothing but
 * the archive's bytes and the configuration go in, the bundle's files come
 * out (V8 serialisation over IPC); the child reads no file and opens no
 * connection of its own.
 */
export function convertDitaIsolated(
  files: Map<string, Uint8Array>,
  config: ProjectConfig,
  limits: IsolationLimits,
): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, [CHILD_ARG], {
      execArgv: [
        ...(FROM_SOURCE ? SOURCE_FLAGS : []),
        `--max-old-space-size=${limits.maxMemoryMb}`,
        '--no-warnings',
      ],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
      serialization: 'advanced',
      // What it has to say comes as a message; a crash's trace is no author's to see.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      run();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new ConversionLimitError(
              'timeout',
              `The conversion took longer than ${limits.timeoutMs} ms.`,
            ),
          ),
        ),
      limits.timeoutMs,
    );
    child.on('message', (message: Response) =>
      settle(() => {
        if (message.ok) resolve(message.files);
        else if (message.size) {
          reject(new ConversionLimitError('size', message.message));
        } else reject(new Error(`DITA conversion failed: ${message.message}`));
      }),
    );
    child.on('error', (error) => settle(() => reject(error)));
    // `close`, not `exit`: it comes after the IPC channel is drained, so an answer sent is an answer read.
    child.on('close', (code, signal) =>
      settle(() =>
        reject(
          // V8 out of memory aborts (SIGABRT, 134); anything else ending it unanswered is a bug.
          signal === 'SIGABRT' || code === 134
            ? new ConversionLimitError(
                'memory',
                `The conversion went past its ${limits.maxMemoryMb} MiB.`,
              )
            : new Error(
                `The DITA conversion process ended (${signal ?? `code ${code}`}) without an answer.`,
              ),
        ),
      ),
    );
    try {
      const request: Request = {
        files,
        config,
        ...(limits.maxDocumentBytes !== undefined && {
          maxDocumentBytes: limits.maxDocumentBytes,
        }),
      };
      child.send(request, (error) => {
        if (error) settle(() => reject(error));
      });
    } catch (error) {
      settle(() => reject(error as Error));
    }
  });
}

/** Whether Node runs this very file (as the child), not a file importing it. */
function isEntry(): boolean {
  const main = process.argv[1];
  if (main === undefined) return false;
  try {
    return realpathSync(main) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (process.argv[2] === CHILD_ARG && isEntry() && process.send) {
  process.once('message', (request: Request) => {
    void (async () => {
      let response: Response;
      try {
        const conversion = await convertDita(request.files, request.config);
        response = {
          ok: true,
          files: bundleFiles(conversion, {
            ...(request.maxDocumentBytes !== undefined && {
              maxDocumentBytes: request.maxDocumentBytes,
            }),
          }),
        };
      } catch (error) {
        const e = error as Error;
        response = {
          ok: false,
          // What a string or an array past its length throws: the project is too large.
          size:
            e instanceof DocumentTooLargeError ||
            (e instanceof RangeError &&
              /^Invalid (string|array|typed array) length/.test(e.message)),
          message: e.message,
        };
      }
      // Disconnecting once it is sent ends the child; an answer it cannot send ends it with a code.
      try {
        process.send?.(response, (error: Error | null) => {
          if (error) process.exit(1);
          process.disconnect?.();
        });
      } catch {
        process.exit(1);
      }
    })();
  });
}
