import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { DeleteAssetAction } from '../core/actions/delete-asset.action.js';

/** Deleting a file nobody uses (#255). */
@ApiTags('assets')
@Controller('assets')
@JsonApi()
export class AssetDeleteController {
  constructor(private readonly deleteAsset: DeleteAssetAction) {}

  @Delete(':hash')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an unused file',
    description:
      'Deletes a file nobody uses, with its renditions and its upload records, from the blob store, recorded with an `asset.delete` audit event. Unused, checked again right before deleting: no module file refers to it at `main`, any other branch that is not a change set’s, any tag, the head of any open change set, or any working copy, and it is not an import’s uploaded bundle while that import is kept, nor an image uploaded for the branding, nor an archived release PDF (a `done` release output’s file) no upload records; its last upload (into any change set) or its storing is more than 24 hours ago; and it is not itself a rendition. Otherwise 409 `asset-in-use` with `meta.usedIn`: the places (`{ in: "main" | "release", ref }`, or `{ in: "branch" | "change-set" | "working-copy" | "import" | "branding" | "release-output" | "recent-upload" | "rendition" }`, at most 50), and `meta.deletableAt` for a recent upload. Deleting the uploads of an archived release PDF’s bytes keeps the file; the audit event says so (`fileKept: true`). The same rules hold for attachments. Needs `content.read.draft` and `content.edit`, each in a role whose scope restricts nothing (403 otherwise).',
  })
  @ApiParam({
    name: 'hash',
    description: 'SHA-256 of the file, 64 lowercase hex characters.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiForbiddenResponse({
    description:
      '`forbidden`: not both `content.read.draft` and `content.edit`, each in a role whose scope restricts nothing.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: neither the blob store nor an upload record holds the file (or the hash is not 64 lowercase hex characters).',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`asset-in-use`: used somewhere, uploaded or stored within 24 hours, or a rendition (`meta.usedIn`).',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async remove(
    @CurrentActor() actor: Actor,
    // Checked by the action, after the permission: a malformed hash is 404.
    @Param('hash') hash: string,
  ): Promise<void> {
    await this.deleteAsset.handle({ actor, hash });
  }
}
