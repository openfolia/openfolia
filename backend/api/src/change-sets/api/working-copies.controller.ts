import {
  DesignTemplateId,
  MAX_TEMPLATE_FILE_BYTES,
  ModuleId,
  PageDesignId,
  TermId,
} from '@openfolia/content-model';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { AcceptsQuery, JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { DiscardWorkingCopyAction } from '../core/actions/discard-working-copy.action.js';
import { GetWorkingCopyAction } from '../core/actions/get-working-copy.action.js';
import { SaveWorkingCopyAction } from '../core/actions/save-working-copy.action.js';
import type { LockSubject } from '../core/lock.js';
import {
  ConfigWorkingCopyDocument,
  ManualWorkingCopyDocument,
  ModuleWorkingCopyDocument,
  PageDesignWorkingCopyDocument,
  SaveConfigWorkingCopyDocument,
  SaveManualWorkingCopyDocument,
  SaveModuleWorkingCopyDocument,
  SavePageDesignWorkingCopyDocument,
  SaveTemplateFileWorkingCopyDocument,
  SaveTermWorkingCopyDocument,
  TemplateFileWorkingCopyDocument,
  TermWorkingCopyDocument,
  toWorkingCopyResource,
} from './working-copy.resources.js';

type ModuleDocument = z.infer<typeof ModuleWorkingCopyDocument>;
type ManualDocument = z.infer<typeof ManualWorkingCopyDocument>;
type ConfigDocument = z.infer<typeof ConfigWorkingCopyDocument>;
type TermDocument = z.infer<typeof TermWorkingCopyDocument>;
type DesignDocument = z.infer<typeof PageDesignWorkingCopyDocument>;
type TemplateFileDocument = z.infer<typeof TemplateFileWorkingCopyDocument>;

const MODULE_PATH =
  'change-sets/:changeSetId/modules/:lang/:moduleId/working-copy';
const MANUAL_PATH = 'change-sets/:changeSetId/manuals/:manualId/working-copy';
const CONFIG_PATH = 'change-sets/:changeSetId/config/working-copy';
const TERM_PATH = 'change-sets/:changeSetId/terms/:termId/working-copy';
const DESIGN_PATH =
  'change-sets/:changeSetId/page-designs/:designId/working-copy';
const TEMPLATE_FILE_PATH =
  'change-sets/:changeSetId/page-design-templates/:templateId/files/working-copy';

const CHANGE_SET_ID = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;
const LANG = {
  name: 'lang',
  example: 'en',
  description:
    'A language with subtags of 2 to 8 characters (`en`, `pt-BR`); any case. One that is not is 404.',
} as const;
const MODULE_ID = { name: 'moduleId', example: 'battery-charging' } as const;
const MANUAL_ID = { name: 'manualId', example: 'operating' } as const;
const TERM_ID = { name: 'termId', example: 'charger' } as const;
const DESIGN_ID = { name: 'designId', example: 'product-line' } as const;
const TEMPLATE_ID = { name: 'templateId', example: 'house' } as const;
const FILE_PATH = {
  name: 'path',
  required: true,
  example: 'parts/notice.typ',
  description:
    'The file’s path in the template’s folder (`templates/<templateId>/<path>`): names of letters, digits, `_`, `-` and `.` joined by `/`, none starting with `.`, at most 8 deep and 150 characters, ending in a text file’s extension (`.typ`, `.yaml`, `.yml`, `.json`, `.toml`, `.csv`, `.txt`, `.xml`, `.svg`, `.bib`). Any other path is 404, never a file outside the folder.',
  schema: { type: 'string' },
} as const;
/** Checked by the action (`LockSubject`), after its permission check: a bad path is 404. */
const FilePathQuery = z.string().max(1000);

const AUTHOR_ONLY =
  'Only the change set’s author works on its working copies (403 for anyone else who holds `content.read.draft`; for anyone else another author’s change set is 404, exactly like a missing one).';

const SAVE_DESCRIPTION = `Autosave: stores the editor’s content as the change set’s working copy (Postgres), without a commit and without an audit event; a save point commits it later. The shape is checked (400 otherwise); validation issues come back in \`meta.issues\` without refusing it, since a draft may be incomplete. Send \`meta.version\`: the version last read or saved (0 for none yet); the answer has the next one. Send \`meta.baseCommit\`: the commit the content is based on. ${AUTHOR_ONLY} Needs the change set to be a draft holding the subject’s lock, and the \`content.edit\` permission covering the content (and the committed file).`;

const SAVE_CONFLICT = {
  description:
    '`lock-required`: the change set does not hold the subject’s lock. `version-conflict`: the working copy is at another version (`meta.version`; read it again). `stale-working-copy`: the file changed on the branch since `meta.baseCommit` (`meta.head`). `invalid-state`: the change set is no draft (`meta.state`). `asset-deleted`: a file it names is being deleted as unused (`meta.assets`; upload it again; once deleted it is 422 `unknown-asset`).',
  standardSchema: ErrorDocument,
};

const SAVE_UNPROCESSABLE = {
  description:
    '`subject-mismatch`: the content names another module or manual than the path. `table-too-large` (a module, or a page design’s regions): a table has more than 1,000 columns or 50,000 cells (rows × columns), or the tables of a module or of a design’s regions more than 1,000,000 cells together; one error per such table (or one at `blocks` or `regions` for the total), `source.pointer` at it, `meta.columns`, `meta.cells` and `meta.totalCells` the caps. `too-large`: more than `meta.max` bytes of JSON. `too-many-files`: a module names more than `meta.max` different images and attachments. `unknown-asset`: an image or attachment block names a file you may not use (`meta.assets`): only one a module you may see on the change set’s branch or at its base uses, or one uploaded into a change set of yours, is taken; any other is refused alike, whether or not it is stored. `translation-record-protected`: a page design’s or manual’s `translations` changed in a language whose translation you do not manage (`translation.manage`; `meta.languages`): keep it as the branch or the change set’s base has it.',
  standardSchema: ErrorDocument,
};

const CONFIG_SAVE_DESCRIPTION = `${SAVE_DESCRIPTION} Changing the configuration needs \`content.edit\` through a role whose scope restricts nothing, and \`admin.roles\` (403 otherwise, also for its lock). The whole configuration is sent; a change that would make content on the change set’s branch invalid (a variant attribute or value still used, a language with modules, a module type, audience, facet value, text attribute or safety symbol in use) is refused with the usages (422 \`config-in-use\`); archive a variant value (\`archived: true\`) instead of removing it. A save point checks it again.`;

const CONFIG_SAVE_UNPROCESSABLE = {
  description:
    '`config-in-use`: content on the branch uses what the change removes; one error per usage (`source.pointer` the module or manual and block, `meta.subject`, `meta.issue` the validation code, `meta.at`). `too-large`: more than `meta.max` bytes of JSON.',
  standardSchema: ErrorDocument,
};

const TERM_SAVE_DESCRIPTION = `${SAVE_DESCRIPTION} A term needs \`content.edit\` through one role covering everything in each language it holds, as committed and as sent (its scope restricts nothing but languages).`;

const DESIGN_SAVE_DESCRIPTION = `${SAVE_DESCRIPTION} A page design (#390) needs \`content.edit\` through a role whose scope restricts nothing: it is every manual's look that uses it, in every language. Its \`meta.issues\` say where in the design (\`at\`, a dotted path; a region's block after \`#\`).`;

const TEMPLATE_FILE_SAVE_DESCRIPTION = `${SAVE_DESCRIPTION} A text file of a page design’s own template (#396), \`templates/<templateId>/<path>\`: like a page design, it needs \`content.edit\` through a role whose scope restricts nothing (it lays out every manual whose design names the template). The content is the file’s whole text, at most ${MAX_TEMPLATE_FILE_BYTES / 1024} KiB as UTF-8; a path no file has yet makes a new one (\`manual.typ\` a new template) at the save point. Whether the template compiles is not checked here: the template’s preview (\`GET /page-design-templates/{templateId}/preview/pages/{page}.png\`) shows it, and the change set’s checks hold a broken one (\`page-design-template-error\`). Deleting a file is a save point’s \`deletes\`.`;

const TEMPLATE_FILE_SAVE_UNPROCESSABLE = {
  description:
    '`template-too-large` (#803): with this text, the template’s folder would hold more than `meta.maxFiles` files or `meta.maxBytes` bytes together (the files at the branch, each of the change set’s drafts at its length in place of its file; `meta.files`, `meta.bytes`: what it would hold); a save adding neither a file nor bytes is taken, so a folder past them can be made smaller. `path-conflict`: a file and a folder of one name. `subject-mismatch`: the content is no template file’s (its `text`). `too-large`: more than `meta.max` bytes of JSON.',
  standardSchema: ErrorDocument,
};

const GET_DESCRIPTION = `The change set’s working copy, else the file committed on its branch (\`version\` 0, \`meta.saved\` false), with its validation issues. ${AUTHOR_ONLY} What lies outside the reader’s scope (their \`content.read.draft\` roles; for an author without that permission, their \`content.read\` roles) is not found. Reads with \`?ref=\` on the branch keep showing the committed file. Needs the \`content.read\` permission.`;

const NOT_FOUND = {
  description:
    '`not-found`: no change set with this ID, or neither a working copy nor a committed file the reader may see.',
  standardSchema: ErrorDocument,
};

const DISCARD_DESCRIPTION = `Throws the working copy away; the committed file stays as it is. No lock needed. ${AUTHOR_ONLY} Needs the \`content.edit\` permission.`;

const DISCARD_NOT_FOUND = {
  description: '`not-found`: no change set with this ID, or no working copy.',
  standardSchema: ErrorDocument,
};

/**
 * Working copies: the editor's autosaves of a module, manual, the
 * configuration or a term in a change set, kept in Postgres until a save
 * point commits them.
 */
@ApiTags('working copies')
@Controller()
@JsonApi()
export class WorkingCopiesController {
  constructor(
    private readonly saveWorkingCopy: SaveWorkingCopyAction,
    private readonly getWorkingCopy: GetWorkingCopyAction,
    private readonly discardWorkingCopy: DiscardWorkingCopyAction,
  ) {}

  @Put(MODULE_PATH)
  @ApiOperation({
    summary: 'Save a module’s working copy',
    description: SAVE_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(LANG)
  @ApiParam(MODULE_ID)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: ModuleWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveModule(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    // Checked by the action (`LockSubject`), after its permission check.
    @Param('lang') lang: string,
    @Param('moduleId', { schema: ModuleId }) moduleId: string,
    @Body({ schema: SaveModuleWorkingCopyDocument })
    body: SaveModuleWorkingCopyDocument,
  ): Promise<ModuleDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'module', lang, moduleId },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as ModuleDocument;
  }

  @Get(MODULE_PATH)
  @ApiOperation({
    summary: 'Read a module’s working copy',
    description: GET_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(LANG)
  @ApiParam(MODULE_ID)
  @ApiOkResponse({ standardSchema: ModuleWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getModule(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    // Checked by the action (`LockSubject`), after its permission check.
    @Param('lang') lang: string,
    @Param('moduleId', { schema: ModuleId }) moduleId: string,
  ): Promise<ModuleDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'module', lang, moduleId },
    });
    return { data: toWorkingCopyResource(view) } as ModuleDocument;
  }

  @Delete(MODULE_PATH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a module’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(LANG)
  @ApiParam(MODULE_ID)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardModule(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    // Checked by the action (`LockSubject`), after its permission check.
    @Param('lang') lang: string,
    @Param('moduleId', { schema: ModuleId }) moduleId: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, { type: 'module', lang, moduleId });
  }

  @Put(MANUAL_PATH)
  @ApiOperation({
    summary: 'Save a manual’s working copy',
    description: `${SAVE_DESCRIPTION} A manual whose committed manifest names modules the author may not see is refused (403).`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(MANUAL_ID)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: ManualWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveManual(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('manualId', { schema: ModuleId }) manualId: string,
    @Body({ schema: SaveManualWorkingCopyDocument })
    body: SaveManualWorkingCopyDocument,
  ): Promise<ManualDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'manual', manualId },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as ManualDocument;
  }

  @Get(MANUAL_PATH)
  @ApiOperation({
    summary: 'Read a manual’s working copy',
    description: GET_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(MANUAL_ID)
  @ApiOkResponse({ standardSchema: ManualWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getManual(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('manualId', { schema: ModuleId }) manualId: string,
  ): Promise<ManualDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'manual', manualId },
    });
    return { data: toWorkingCopyResource(view) } as ManualDocument;
  }

  @Delete(MANUAL_PATH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a manual’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(MANUAL_ID)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardManual(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('manualId', { schema: ModuleId }) manualId: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, { type: 'manual', manualId });
  }

  @Put(CONFIG_PATH)
  @ApiOperation({
    summary: 'Save the configuration’s working copy',
    description: CONFIG_SAVE_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: ConfigWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(CONFIG_SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveConfig(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: SaveConfigWorkingCopyDocument })
    body: SaveConfigWorkingCopyDocument,
  ): Promise<ConfigDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'config' },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as ConfigDocument;
  }

  @Get(CONFIG_PATH)
  @ApiOperation({
    summary: 'Read the configuration’s working copy',
    description: GET_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiOkResponse({ standardSchema: ConfigWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getConfig(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
  ): Promise<ConfigDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'config' },
    });
    return { data: toWorkingCopyResource(view) } as ConfigDocument;
  }

  @Delete(CONFIG_PATH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard the configuration’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardConfig(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, { type: 'config' });
  }

  @Put(TERM_PATH)
  @ApiOperation({
    summary: 'Save a term’s working copy',
    description: TERM_SAVE_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TERM_ID)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: TermWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveTerm(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('termId', { schema: TermId }) termId: string,
    @Body({ schema: SaveTermWorkingCopyDocument })
    body: SaveTermWorkingCopyDocument,
  ): Promise<TermDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'term', termId },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as TermDocument;
  }

  @Get(TERM_PATH)
  @ApiOperation({
    summary: 'Read a term’s working copy',
    description: `${GET_DESCRIPTION} A committed file that is no term reads as none.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TERM_ID)
  @ApiOkResponse({ standardSchema: TermWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getTerm(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('termId', { schema: TermId }) termId: string,
  ): Promise<TermDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'term', termId },
    });
    return { data: toWorkingCopyResource(view) } as TermDocument;
  }

  @Delete(TERM_PATH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a term’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TERM_ID)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardTerm(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('termId', { schema: TermId }) termId: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, { type: 'term', termId });
  }

  @Put(DESIGN_PATH)
  @ApiOperation({
    summary: 'Save a page design’s working copy',
    description: DESIGN_SAVE_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(DESIGN_ID)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: PageDesignWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveDesign(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('designId', { schema: PageDesignId }) designId: string,
    @Body({ schema: SavePageDesignWorkingCopyDocument })
    body: SavePageDesignWorkingCopyDocument,
  ): Promise<DesignDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'design', designId },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as DesignDocument;
  }

  @Get(DESIGN_PATH)
  @ApiOperation({
    summary: 'Read a page design’s working copy',
    description: `${GET_DESCRIPTION} A committed file that is no page design reads as none.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(DESIGN_ID)
  @ApiOkResponse({ standardSchema: PageDesignWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getDesign(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('designId', { schema: PageDesignId }) designId: string,
  ): Promise<DesignDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'design', designId },
    });
    return { data: toWorkingCopyResource(view) } as DesignDocument;
  }

  @Delete(DESIGN_PATH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a page design’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(DESIGN_ID)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardDesign(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('designId', { schema: PageDesignId }) designId: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, { type: 'design', designId });
  }

  @Put(TEMPLATE_FILE_PATH)
  @AcceptsQuery('path')
  @ApiOperation({
    summary: 'Save a template file’s working copy',
    description: TEMPLATE_FILE_SAVE_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TEMPLATE_ID)
  @ApiQuery(FILE_PATH)
  @ApiOkResponse({
    description: 'Saved, at its new version.',
    standardSchema: TemplateFileWorkingCopyDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(SAVE_CONFLICT)
  @ApiUnprocessableEntityResponse(TEMPLATE_FILE_SAVE_UNPROCESSABLE)
  @ApiPermission('content.edit')
  async saveTemplateFile(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @Query('path', { schema: FilePathQuery }) path: string,
    @Body({ schema: SaveTemplateFileWorkingCopyDocument })
    body: SaveTemplateFileWorkingCopyDocument,
  ): Promise<TemplateFileDocument> {
    const view = await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'template', templateId, path },
      content: body.data.attributes.content,
      version: body.meta.version,
      baseCommit: body.meta.baseCommit,
    });
    return { data: toWorkingCopyResource(view) } as TemplateFileDocument;
  }

  @Get(TEMPLATE_FILE_PATH)
  @AcceptsQuery('path')
  @ApiOperation({
    summary: 'Read a template file’s working copy',
    description: `${GET_DESCRIPTION} A committed file that is no UTF-8 text (an image the template shows) reads as none.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TEMPLATE_ID)
  @ApiQuery(FILE_PATH)
  @ApiOkResponse({ standardSchema: TemplateFileWorkingCopyDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.read')
  async getTemplateFile(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @Query('path', { schema: FilePathQuery }) path: string,
  ): Promise<TemplateFileDocument> {
    const view = await this.getWorkingCopy.handle({
      actor,
      changeSetId,
      subject: { type: 'template', templateId, path },
    });
    return { data: toWorkingCopyResource(view) } as TemplateFileDocument;
  }

  @Delete(TEMPLATE_FILE_PATH)
  @AcceptsQuery('path')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a template file’s working copy',
    description: DISCARD_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(TEMPLATE_ID)
  @ApiQuery(FILE_PATH)
  @ApiNoContentResponse({ description: 'Discarded.' })
  @ApiNotFoundResponse(DISCARD_NOT_FOUND)
  @ApiPermission('content.edit')
  async discardTemplateFile(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @Query('path', { schema: FilePathQuery }) path: string,
  ): Promise<void> {
    await this.discard(actor, changeSetId, {
      type: 'template',
      templateId,
      path,
    });
  }

  private discard(
    actor: Actor,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void> {
    return this.discardWorkingCopy.handle({ actor, changeSetId, subject });
  }
}
