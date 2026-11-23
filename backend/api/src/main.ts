import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { getPriority, setPriority } from 'node:os';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { roleOf, workerNiceOf } from './config/role.js';
import { StartupError } from './config/startup-error.js';
import { startWorkerHealthServer } from './health/api/worker-health.server.js';
import { setUpOpenApi } from './base/api/openapi.js';
import { setUpRequestBodies } from './base/api/request-bodies.js';
import { setUpTrustProxy } from './base/api/trust-proxy.js';

/** How long shutdown may wait for running requests before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Starts the server in its role (`CCMS_ROLE`, #527): `all` and `api` serve
 * the HTTP API; a `worker` runs the same modules as an application context
 * (no HTTP routes at all) with only the health endpoint beside it.
 */
async function bootstrap(): Promise<void> {
  const role = roleOf(process.env);
  // The backup service (#529): its own process, no Nest application; the
  // arguments are its command (run, now, list, restore …).
  if (role === 'backup') {
    const { runBackupCommand } = await import('./backups/backup.main.js');
    return runBackupCommand(process.argv.slice(2));
  }
  if (role === 'worker') return bootstrapWorker();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Startup errors (e.g. invalid settings) reach the catch below.
    abortOnError: false,
  });
  app.disable('x-powered-by');
  setUpTrustProxy(app);
  setUpRequestBodies(app);
  setUpOpenApi(app);

  stopOnSignals(app);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });
  await app.listen(port, host);
  Logger.log(
    `Listening on ${await app.getUrl()} (docs at /docs), content from ${config.get('CCMS_CONTENT_DIR', { infer: true })}`,
    'Bootstrap',
  );
}

/**
 * A worker (#527): every module, so every job handler and background loop,
 * in an application context that mounts no route; then the health server
 * on `HOST`:`PORT`. Shutdown stops the health server first, then the app
 * (running jobs are handed back, as in the API).
 */
async function bootstrapWorker(): Promise<void> {
  lowerPriority(workerNiceOf(process.env));
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
  });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  let health: Awaited<ReturnType<typeof startWorkerHealthServer>>;
  try {
    health = await startWorkerHealthServer(app, {
      host: config.get('HOST', { infer: true }),
      port: config.get('PORT', { infer: true }),
    });
  } catch (error) {
    // The jobs it claimed meanwhile go back to the queue, its consumer row away.
    await app
      .close()
      .catch((closing: unknown) => Logger.error(closing, 'Bootstrap'));
    throw error;
  }
  stopOnSignals({
    close: async () => {
      await health.close();
      await app.close();
    },
  });
  Logger.log(
    `Worker: consuming jobs; health at ${health.url}/health, content from ${config.get('CCMS_CONTENT_DIR', { infer: true })}`,
    'Bootstrap',
  );
}

/**
 * Takes the worker's nice value (`CCMS_WORKER_NICE`) before anything else
 * starts, so the PDF worker processes it forks inherit it: on a host shared
 * with the API, release renders yield the CPU to readers. Only ever raised
 * (lowering needs privileges); a refusal is logged, not fatal.
 */
function lowerPriority(nice: number): void {
  try {
    const current = getPriority();
    if (nice > current) {
      setPriority(nice);
      // On Linux a nice value is a thread's: the threads started before this
      // one (V8's, libuv's) get it too. Elsewhere it is the process's.
      if (process.platform === 'linux') {
        try {
          for (const tid of readdirSync('/proc/self/task')) {
            try {
              if (getPriority(Number(tid)) < nice)
                setPriority(Number(tid), nice);
            } catch {
              // A thread that ended meanwhile.
            }
          }
        } catch {
          // No /proc: the main thread (and what it starts) has it all the same.
        }
      }
    }
    Logger.log(
      nice >= current
        ? `Worker: CPU priority (nice) ${nice}`
        : `Worker: CPU priority (nice) ${current}, kept (CCMS_WORKER_NICE is ${nice})`,
      'Bootstrap',
    );
  } catch (error) {
    Logger.warn(
      `Worker: could not set the CPU priority to ${nice}: ${String(error)}`,
      'Bootstrap',
    );
  }
}

/**
 * SIGINT/SIGTERM: `app.close()` runs the lifecycle hooks in order (PDF jobs
 * end, the HTTP server stops after running requests finish, workers and
 * the repository are cleaned up). A second signal, or the grace period
 * running out, ends the process at once. A clean stop re-raises the
 * signal, so the exit code is the usual one (143 for SIGTERM).
 */
function stopOnSignals(app: { close(): Promise<void> }): void {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const forceExit = () => process.exit(1);
  const stop = (signal: NodeJS.Signals) => {
    for (const s of signals) {
      process.off(s, stop);
      process.on(s, forceExit);
    }
    setTimeout(() => {
      Logger.error('Shutdown took too long; exiting.', 'Bootstrap');
      forceExit();
    }, SHUTDOWN_GRACE_MS).unref();
    app.close().then(
      () => {
        for (const s of signals) process.off(s, forceExit);
        process.kill(process.pid, signal);
      },
      (error: unknown) => {
        Logger.error(error, 'Bootstrap');
        forceExit();
      },
    );
  };
  for (const signal of signals) process.on(signal, stop);
}

bootstrap().catch((error: unknown) => {
  // Settings or database: the message says what to fix. Anything else: the stack.
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
