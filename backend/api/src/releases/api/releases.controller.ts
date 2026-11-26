import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { NamesPeople } from '../../base/api/people.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CreateReleaseAction,
  RESUME_AFTER_MS,
} from '../core/actions/create-release.action.js';
import {
  GetReleaseAction,
  ListReleasesAction,
} from '../core/actions/read-releases.action.js';
import { ListReleaseChangesAction } from '../core/actions/release-changes.action.js';
import { ReleaseOutputsProgressAction } from '../core/actions/release-outputs.action.js';
import { WithdrawReleaseAction } from '../core/actions/withdraw-release.action.js';
import type { Release } from '../core/release.js';
import type { OutputsProgress } from '../core/release-output.js';
import { MAX_REVIEWED_PATHS } from '../../change-sets/core/review-scope.js';
import {
  CreateReleaseDocument,
  ReleaseChangePageDocument,
  ReleaseDetailDocument,
  ReleaseDocument,
  ReleaseListPageDocument,
  releaseFilters,
  toPreviousRelease,
  toReleaseChangeResource,
  toReleaseDetailResource,
  toReleaseResource,
  WithdrawReleaseDocument,
} from './release.resources.js';

type Document = z.infer<typeof ReleaseDocument>;

const logger = new Logger('Releases');

/** Releases of a page whose outputs are counted at once (`GET /releases`). */
const COUNTED_AT_ONCE = 8;

const ID_PARAMETER = {
  name: 'releaseId',
  description:
    'The release’s ID (a UUID). One that names no release, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

@ApiTags('releases')
@Controller('releases')
@JsonApi()
export class ReleasesController {
  constructor(
    private readonly listReleases: ListReleasesAction,
    private readonly getRelease: GetReleaseAction,
    private readonly createRelease: CreateReleaseAction,
    private readonly withdrawRelease: WithdrawReleaseAction,
    private readonly listChanges: ListReleaseChangesAction,
    private readonly outputsProgress: ReleaseOutputsProgressAction,
  ) {}

  @Get()
  @NamesPeople()
  @Paged()
  @Filters(
    {
      name: 'product',
      description:
        'Only releases of this product (a value of the product facet).',
    },
    {
      name: 'major',
      description:
        '`true`: only major releases; `false`: only the others. Left out: all.',
    },
    {
      name: 'state',
      description:
        '`withdrawn`: only withdrawn releases; `published`: only those that stand. Left out: all.',
    },
  )
  @ApiOperation({
    summary: 'List releases',
    description:
      'Releases, newest first, withdrawn ones too (`attributes.withdrawal`): each a product revision tagged on the whole of `main` at one commit. Read the content as released with `?ref=<attributes.tag>`. Releases are released content, so every reader may list them; what a reader sees at a tag is limited to their scope. Each release’s `meta.outputs` says where its files stand, as `GET /releases/{releaseId}` does (but with `queue` always null: what waits ahead of a release is counted for its own read only), so a list shows them without a read per release. Needs the `content.read` permission.',
  })
  @DeliveryApi()
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ReleaseListPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[product]', { schema: releaseFilters.product.optional() })
    product?: string,
    @Query('filter[major]', { schema: releaseFilters.major.optional() })
    major?: boolean,
    @Query('filter[state]', { schema: releaseFilters.state.optional() })
    withdrawn?: boolean,
  ): Promise<z.infer<typeof ReleaseListPageDocument>> {
    const result = await this.listReleases.handle({
      actor,
      page,
      filter: {
        ...(product !== undefined && { product }),
        ...(major !== undefined && { major }),
        ...(withdrawn !== undefined && { withdrawn }),
      },
    });
    const outputs = await this.progressOf(actor, result.items);
    return toPagedDocument(req, page, result, (release) =>
      toReleaseDetailResource(release, outputs.get(release.id) ?? null),
    );
  }

  /**
   * Where each release's outputs stand for `actor`, a few releases at a time. One that cannot be
   * counted now (its tag or the database failing) is null, as an unreadable tag is: the rest of
   * the list still answers.
   */
  private async progressOf(
    actor: Actor,
    releases: readonly Release[],
  ): Promise<Map<string, OutputsProgress | null>> {
    const found = new Map<string, OutputsProgress | null>();
    for (let i = 0; i < releases.length; i += COUNTED_AT_ONCE) {
      await Promise.all(
        releases.slice(i, i + COUNTED_AT_ONCE).map(async (release) => {
          found.set(
            release.id,
            await this.outputsProgress
              // Without what waits ahead of each (#497): a count over every later release per row.
              .handle({ actor, release, withQueue: false })
              .catch((error: unknown) => {
                logger.warn(
                  `The outputs of release ${release.id} could not be counted: ${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
              }),
          );
        }),
      );
    }
    return found;
  }

  @Get(':releaseId')
  @NamesPeople()
  @ApiOperation({
    summary: 'Read a release',
    description:
      'One release: its product, revision, tag, commit, notes, whether it is major, who cut it and when, and its withdrawal (who, when, why) once withdrawn; `meta.outputs` says where its files stand (still being planned, rendering, done or failed, with counts of those you may read), for a client to show progress and poll while they are under way. Needs the `content.read` permission.',
  })
  @DeliveryApi()
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ReleaseDetailDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no release with this ID.',
    standardSchema: ErrorDocument,
  })
  async get(
    @CurrentActor() actor: Actor,
    @Param('releaseId') id: string,
  ): Promise<z.infer<typeof ReleaseDetailDocument>> {
    const release = await this.getRelease.handle({ actor, id });
    const outputs = await this.outputsProgress.handle({ actor, release });
    return { data: toReleaseDetailResource(release, outputs) };
  }

  @Post()
  @NamesPeople()
  @ApiOperation({
    summary: 'Cut a release',
    description: `Tags the commit \`main\` points to now (the whole repository) as \`revision\` of \`product\`, with an annotated tag named by \`CCMS_RELEASE_TAG\` (default \`release/{product}/{revision}\`; the publisher as tagger; the notes as the message’s body; trailers \`Product\`, \`Revision\` and \`Actor\`), then records the release and a \`release.publish\` audit event. A release is immutable: its tag is never moved or deleted, and its product and revision (or tag name) can never be used again. A request cut off before it was recorded (the server stopped, Git or the database failed) is finished by the next request for the same release once ${RESUME_AFTER_MS / 1000} s have passed, as first requested; until then that is 409 \`release-pending\` (\`meta.releaseId\`, \`meta.retryAfter\` in seconds): try again then. Needs the \`release.publish\` permission in a role whose scope covers the product in every language, module type and audience, and \`content.read\` (to read \`openfolia.yaml\` at \`main\`). With \`maintenanceLine\` (a maintenance line’s ID), the release is cut from the head of the line’s branch instead, of the line’s product (else 422 \`invalid-product\`), and listed under \`GET /maintenance-lines/{id}/releases\`; that head holds unreleased fixes, so it also needs \`content.read.draft\` (without it the branch is not there: 409 \`branch-missing\`).`,
  })
  @ApiPermission('release.publish')
  @ApiCreatedResponse({
    standardSchema: ReleaseDocument,
    headers: {
      Location: { description: 'The new release.', schema: { type: 'string' } },
    },
  })
  @ApiConflictResponse({
    description:
      '`release-exists`: a release of this product and revision, or a tag of this name (in any case, or clashing with a branch or tag), exists already (`meta.releaseId` when it is a release). `release-pending`: it is being made, or was cut off and is finished by a request after `meta.retryAfter` seconds (`meta.releaseId`). `branch-missing`: there is no `main` (or no branch of the maintenance line given).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-product`: the product is no value of the product facet in `openfolia.yaml` at `main` (`meta.facet`). `no-product-facet`: `openfolia.yaml` configures no facet. `invalid-release-name`: the tag name the pattern gives is no valid one. `invalid-notes`: the notes end in lines Git reads as trailers. `unknown-maintenance-line`: no maintenance line with the ID given. `invalid-content`: `openfolia.yaml` at `main` cannot be read.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the database took too long; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateReleaseDocument }) body: CreateReleaseDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const {
      product,
      revision,
      notes,
      notesByLanguage,
      major,
      maintenanceLine,
    } = body.data.attributes;
    const release = await this.createRelease.handle({
      actor,
      product,
      revision,
      notes: notes ?? null,
      notesByLanguage: notesByLanguage ?? {},
      major: major ?? false,
      ...(maintenanceLine !== undefined && { maintenanceLine }),
    });
    res.setHeader('Location', `/releases/${release.id}`);
    return { data: toReleaseResource(release) };
  }

  @Get(':releaseId/changes')
  @Paged()
  @ApiOperation({
    summary: 'List what a release changed',
    description: `The changelog of one release: one \`ReleaseChange\` per manual and language that changed (a release holds the whole repository, so every manual counts) since the product’s previous release that is not withdrawn (by when it was cut; for a release of a maintenance line, the line’s previous one, else its base release; for one of \`main\`, never a line’s), each with the modules it names that changed in that language (\`added\`, \`changed\`, \`removed\`, with their blocks by ID). A product’s first release lists every manual as \`added\`. Derived from Git, never stored. Both releases are read as you may read them: a manual or module outside your scope is not there, exactly like a missing one, so it is neither listed nor counted. Ordered by manual ID, then language. A pair of releases too large to compare (more than the files a review reads, counted over the whole repository) is 422 \`too-many-changes\` for every reader. Needs the \`content.read\` permission.`,
  })
  @DeliveryApi()
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ReleaseChangePageDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no release with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: `\`too-many-changes\`: more than ${MAX_REVIEWED_PATHS} files differ from the previous release; \`invalid-content\`: the configuration at a release cannot be read.`,
    standardSchema: ErrorDocument,
  })
  async changes(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('releaseId') id: string,
  ): Promise<z.infer<typeof ReleaseChangePageDocument>> {
    const result = await this.listChanges.handle({ actor, id, page });
    const document = toPagedDocument(
      req,
      page,
      result,
      toReleaseChangeResource,
    );
    return {
      ...document,
      meta: { ...document.meta, previous: toPreviousRelease(result.previous) },
    };
  }

  @Post(':releaseId/withdraw')
  @NamesPeople()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Withdraw a release',
    description:
      'Marks the release withdrawn, with who, when and the reason (required), a `release.withdraw` audit event and a `release.withdrawn` outbox row, in one transaction. Nothing else changes: the tag stays (tags are immutable) and reads at it keep working, but the release no longer counts as a module’s latest release (`meta.status.release`), and every reader sees it withdrawn, with the reason, in `GET /releases` and `GET /changelog`. It cannot be undone. Needs the `release.publish` permission in a role whose scope covers the release’s product in every language, module type and audience, and `content.read`.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('release.publish')
  @ApiOkResponse({ standardSchema: ReleaseDocument })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: no role with `release.publish` covers the release’s product everywhere.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no release with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`release-withdrawn`: it is withdrawn already.',
    standardSchema: ErrorDocument,
  })
  async withdraw(
    @CurrentActor() actor: Actor,
    @Param('releaseId') id: string,
    @Body({ schema: WithdrawReleaseDocument }) body: WithdrawReleaseDocument,
  ): Promise<Document> {
    const release = await this.withdrawRelease.handle({
      actor,
      id,
      reason: body.meta.reason,
    });
    return { data: toReleaseResource(release) };
  }
}
