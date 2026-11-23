import { z } from 'zod';
import { field, wholeNumber } from './fields.js';

/**
 * What one process of the server does (`CCMS_ROLE`, #527), from the same
 * image and the same code:
 *
 * - `all` (the default): everything, as a single-process setup always did.
 * - `api`: serves HTTP and enqueues jobs; consumes none, runs no background
 *   loop, and keeps only a small PDF pool for interactive renders.
 * - `worker`: consumes every job (planning, rendering, imports, webhooks,
 *   …), runs the background loops (sweeps, outbox consumers, recounts) and
 *   the PDF pool; serves no HTTP but a health endpoint and runs no
 *   migrations.
 * - `backup`: the backup service (#529): the entry point (`main.ts`) runs
 *   `backups/backup.main.ts` with its arguments as the command (run, now,
 *   list, restore …), no Nest application.
 *
 * The one list of roles: a role added elsewhere is added here.
 */
export const SERVER_ROLES = ['all', 'api', 'worker', 'backup'] as const;
export type ServerRoleName = (typeof SERVER_ROLES)[number];

/** `CCMS_WORKER_NICE`'s default. */
export const WORKER_NICE_DEFAULT = 10;

export const RoleEnv = z.object({
  CCMS_ROLE: field(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(SERVER_ROLES, `must be one of ${SERVER_ROLES.join(', ')}`))
      .default('all'),
  ),
  /**
   * The worker's CPU priority (#527): the nice value a `worker` process
   * takes at start, which its PDF worker processes inherit, so on a host it
   * shares with the API its renders yield the CPU to the API's readers.
   * 0 (normal) to 19 (lowest); default 10. Only raised, never lowered.
   */
  CCMS_WORKER_NICE: field(wholeNumber(0, 19).default(WORKER_NICE_DEFAULT)),
});

/** `CCMS_ROLE` as parsed, from an environment that may not hold the server's other settings. */
export function roleOf(env: Record<string, unknown>): ServerRoleName {
  const parsed = RoleEnv.safeParse(env);
  return parsed.success ? parsed.data.CCMS_ROLE : 'all';
}

/** `CCMS_WORKER_NICE` as parsed, its default when unset or not valid (the settings' validation says so). */
export function workerNiceOf(env: Record<string, unknown>): number {
  const parsed = RoleEnv.shape.CCMS_WORKER_NICE.safeParse(env.CCMS_WORKER_NICE);
  return parsed.success ? parsed.data : WORKER_NICE_DEFAULT;
}

/** Whether a role serves the HTTP API (its routes, not just health). */
export const servesHttp = (role: ServerRoleName): boolean =>
  role === 'all' || role === 'api';

/** Whether a role consumes jobs and runs the background loops. */
export const runsBackground = (role: ServerRoleName): boolean =>
  role === 'all' || role === 'worker';

/** The PDF workers' default for the `api` role: a small pool for interactive renders only. */
export const API_ROLE_PDF_WORKERS = 2;

/**
 * How many PDF worker processes a role's pool has at most: `CCMS_PDF_WORKERS`
 * when set, else one per spare core (`spare`), and for the `api` role at
 * most `API_ROLE_PDF_WORKERS` (it renders only what readers ask for).
 */
export function pdfWorkersFor(
  role: ServerRoleName,
  configured: number | undefined,
  spare: number,
): number {
  if (configured !== undefined) return configured;
  return role === 'api' ? Math.min(API_ROLE_PDF_WORKERS, spare) : spare;
}

/**
 * `CCMS_RENDER_CONCURRENCY`'s default for a role: a `worker` serves no
 * readers, so it renders release files on all its PDF workers; `all` keeps
 * half of them for readers (at least one).
 */
export function defaultRenderConcurrencyFor(
  role: ServerRoleName,
  pdfWorkers: number,
): number {
  return role === 'worker'
    ? pdfWorkers
    : Math.max(1, Math.floor(pdfWorkers / 2));
}
