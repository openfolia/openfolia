import { Injectable, Logger } from '@nestjs/common';
import { type JobContext, JobHandler } from '../../jobs/core/job.js';
import { PlanReleaseOutputsAction } from '../core/actions/plan-release-outputs.action.js';
import {
  FailReleaseOutputAction,
  RenderReleaseOutputAction,
} from '../core/actions/render-release-output.action.js';
import {
  PLAN_RELEASE_OUTPUTS,
  type PlanReleaseOutputsPayload,
  BUILD_OFFLINE_PACKAGE,
  RENDER_RELEASE_OUTPUT,
  type RenderReleaseOutputPayload,
  ReleaseOutputSettings,
} from '../core/release-output.js';

/** Runs `release.plan-outputs` jobs: `PlanReleaseOutputsAction`. */
@Injectable()
export class PlanReleaseOutputsJobHandler extends JobHandler<PlanReleaseOutputsPayload> {
  readonly kind = PLAN_RELEASE_OUTPUTS;
  private readonly logger = new Logger(PlanReleaseOutputsJobHandler.name);

  constructor(private readonly plan: PlanReleaseOutputsAction) {
    super();
  }

  run(
    payload: PlanReleaseOutputsPayload,
    { signal }: JobContext,
  ): Promise<void> {
    return this.plan.handle({ releaseId: payload.releaseId, signal });
  }

  /** Nothing waits on a plan but its outputs, of which it wrote none or some batches: logged. */
  override async failed(payload: PlanReleaseOutputsPayload): Promise<void> {
    this.logger.error(
      `Planning the outputs of release ${payload.releaseId} failed for good: it has none or only some of its outputs (plan them again).`,
    );
  }
}

/**
 * Runs `release.outputs` jobs: `RenderReleaseOutputAction`, and
 * `FailReleaseOutputAction` once one failed for good;
 * `CCMS_RENDER_CONCURRENCY` at once per server (#497).
 */
@Injectable()
export class RenderReleaseOutputJobHandler extends JobHandler<RenderReleaseOutputPayload> {
  readonly kind = RENDER_RELEASE_OUTPUT;
  override readonly concurrency: number;

  constructor(
    private readonly render: RenderReleaseOutputAction,
    private readonly fail: FailReleaseOutputAction,
    settings: ReleaseOutputSettings,
  ) {
    super();
    this.concurrency = settings.renderConcurrency;
  }

  run(payload: RenderReleaseOutputPayload): Promise<void> {
    return this.render.handle({
      outputId: payload.outputId,
      retries: payload.retries,
    });
  }

  override failed(payload: RenderReleaseOutputPayload): Promise<void> {
    return this.fail.handle({
      outputId: payload.outputId,
      retries: payload.retries,
    });
  }
}

/**
 * Runs `release.offline-package` jobs (#59): `RenderReleaseOutputAction`
 * builds the package, stopping once the attempt is cut off, and
 * `FailReleaseOutputAction` once one failed for good.
 */
@Injectable()
export class BuildOfflinePackageJobHandler extends JobHandler<RenderReleaseOutputPayload> {
  readonly kind = BUILD_OFFLINE_PACKAGE;

  constructor(
    private readonly render: RenderReleaseOutputAction,
    private readonly fail: FailReleaseOutputAction,
  ) {
    super();
  }

  run(
    payload: RenderReleaseOutputPayload,
    { signal }: JobContext,
  ): Promise<void> {
    return this.render.handle({
      outputId: payload.outputId,
      retries: payload.retries,
      signal,
    });
  }

  override failed(payload: RenderReleaseOutputPayload): Promise<void> {
    return this.fail.handle({
      outputId: payload.outputId,
      retries: payload.retries,
    });
  }
}
