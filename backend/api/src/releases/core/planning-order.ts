import { JobQueue } from '../../jobs/core/job-queue.js';
import type { Release } from './release.js';
import { NEIGHBOURS_SCANNED, PLAN_RELEASE_OUTPUTS } from './release-output.js';
import { ReleaseOutputStore } from './release-output-store.js';
import { ReleaseStore } from './release-store.js';

/**
 * How long one planning attempt plans its product's earlier releases before its own (#527): 10
 * of the attempt's 15 minutes (`PLAN_RELEASE_OUTPUTS.timeoutSeconds`), so its own planning
 * still fits.
 */
export const EARLIER_PLANNING_MS = 10 * 60_000;

/**
 * The releases of `release`'s product cut before it whose planning is still to come (#527):
 * not planned to the end (`ReleaseOutputStore.plannedWholly`: none of its outputs yet, or a
 * planning cut off), and a `release.plan-outputs` job that has not ended (queued, waiting to retry,
 * or claimed and waiting for the product's turn), oldest first, among the nearest
 * `NEIGHBOURS_SCANNED`. Releases are planned strictly in the order they were cut: these are
 * planned before it, in its product's turn (`PlanReleaseOutputsAction`). One whose planning
 * ended without outputs (refused for its size, failed for good) is not waited for: a
 * publisher plans it again.
 */
export async function earlierToPlan(
  ports: {
    readonly releases: ReleaseStore;
    readonly outputs: ReleaseOutputStore;
    readonly jobs: JobQueue;
  },
  release: Release,
): Promise<Release[]> {
  const earlier = (
    await ports.releases.before(release, NEIGHBOURS_SCANNED)
  ).filter((r) => r.productFacet === release.productFacet);
  if (earlier.length === 0) return [];
  const ids = earlier.map((r) => r.id);
  const [planned, open] = await Promise.all([
    ports.outputs.plannedWholly(ids),
    ports.jobs.openKeys(PLAN_RELEASE_OUTPUTS, ids),
  ]);
  return earlier.filter((r) => !planned.has(r.id) && open.has(r.id));
}
