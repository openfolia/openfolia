import { ModuleId } from '@openfolia/content-model';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { GetModuleReferencesAction } from '../core/actions/get-module-references.action.js';
import { RenameModuleAction } from '../core/actions/rename-module.action.js';
import {
  CreateModuleRenameDocument,
  ModuleReferencesDocument,
  ModuleRenameDocument,
  toModuleReferencesDocument,
  toModuleRenameDocument,
} from './module-rename.resources.js';

const CHANGE_SET_ID = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const RENAME_DESCRIPTION = `Changes a module’s ID (#265): one commit on the change set’s branch, made as a save point is, that writes every language of the module under the new ID (with its translation record), deletes the old files, and rewrites every module reference, cross-reference and manifest entry naming the old ID at the branch head, and the \`replacedBy\` of every module deprecated in favour of it. The change set’s comments on the module follow it, with a \`module.rename\` audit event per language (and the commit’s own). Only the change set’s author, while it is a draft. It needs the change set to hold the locks of the module under both IDs, in every language, and of every module and manual it rewrites (\`GET /change-sets/{changeSetId}/module-references/{moduleId}\` lists them); their working copies must be committed or discarded first. Anything it touches outside the actor’s scope is one 403. Releases keep the old ID; it is not kept as an alias. Needs the \`content.edit\` permission.`;

const REFERENCES_DESCRIPTION = `What renaming the module would touch at the change set’s branch head: the languages it has a file in and every other module (per language) and manual whose module references, cross-references or entries name it, and every other module deprecated in favour of it (\`replacedBy\`), with those that have a working copy in the change set. Checked as the rename is (the author only, a draft only, one 403 when any of it lies outside the actor’s scope). Needs the \`content.edit\` permission.`;

const DATABASE_TIMEOUT =
  '`database-timeout`: a transaction waited too long for a row held elsewhere, or a statement ran too long; nothing of it was written to the database, but the Git commit may have landed on the branch already (recorded by the next save point or reconciler pass as a save point). `Retry-After` says when to try again.';

/** Changing a module's ID in a change set (#265). */
@ApiTags('working copies')
@Controller('change-sets')
@JsonApi()
export class ModuleRenamesController {
  constructor(
    private readonly renameModule: RenameModuleAction,
    private readonly moduleReferences: GetModuleReferencesAction,
  ) {}

  @Post(':changeSetId/module-renames')
  @ApiOperation({
    summary: 'Change a module’s ID',
    description: RENAME_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiCreatedResponse({
    description: 'Renamed: the commit.',
    standardSchema: ModuleRenameDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no change set with this ID, or no module `from` (for an actor who edits and reads all of every language; anyone else gets the 403 a hidden one would).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`lock-required`: the change set does not hold a lock the rename needs (`meta.subject`). `id-taken`: a module has the new ID (`meta.moduleId`). `uncommitted-working-copies`: subjects it touches have working copies (`meta.subjects`). `translation-at-provider`: blocks of the module are in an open translation job (`meta.langs`). `branch-moved`, `working-copy-changed`: the branch or a working copy moved while committing, twice (try again). `invalid-state`: the change set is no draft (`meta.state`).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-id`: `from` or `to` is no module ID, or they are the same (`meta.member`). `too-many-changes`: more files than one commit changes (`meta.max`). `not-renamable`: a file to move is not UTF-8 text (`meta.path`).',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async rename(
    @CurrentActor() actor: Actor,
    // Checked by the action, after its permission check.
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: CreateModuleRenameDocument })
    body: CreateModuleRenameDocument,
  ) {
    const { from, to } = body.data.attributes;
    return toModuleRenameDocument(
      await this.renameModule.handle({ actor, changeSetId, from, to }),
    );
  }

  @Get(':changeSetId/module-references/:moduleId')
  @ApiOperation({
    summary: 'What renaming a module would touch',
    description: REFERENCES_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam({ name: 'moduleId', example: 'battery-charging' })
  @ApiOkResponse({
    description: 'The module’s languages and the files naming it.',
    standardSchema: ModuleReferencesDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no change set with this ID, or no module with this ID (for an actor who edits and reads all of every language; anyone else gets the 403 a hidden one would).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`invalid-state`: the change set is no draft (`meta.state`).',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async references(
    @CurrentActor() actor: Actor,
    // Checked by the action, after its permission check.
    @Param('changeSetId') changeSetId: string,
    @Param('moduleId', { schema: ModuleId }) moduleId: string,
  ) {
    return toModuleReferencesDocument(
      await this.moduleReferences.handle({ actor, changeSetId, moduleId }),
    );
  }
}
