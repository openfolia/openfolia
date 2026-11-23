import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CreateBackupKeyAction,
  GetBackupRequestAction,
  GetBackupSettingsAction,
  GetBackupStatusAction,
  ListBackupKeysAction,
  ListBackupRunsAction,
  MANAGE_BACKUPS,
  RequestBackupAction,
  UpdateBackupSettingsAction,
} from '../core/actions/manage-backups.action.js';
import {
  BackupKeyPageDocument,
  BackupRequestDocument,
  BackupRunPageDocument,
  BackupSettingsDocument,
  BackupStatusDocument,
  CreateBackupKeyDocument,
  CreateBackupRequestDocument,
  MadeBackupKeyDocument,
  toBackupKeyResource,
  toBackupRequestResource,
  toBackupRunResource,
  toBackupSettingsResource,
  toBackupStatusResource,
  toMadeBackupKeyDocument,
  UpdateBackupSettingsDocument,
} from './backup.resources.js';

const NEEDS = `Needs \`${MANAGE_BACKUPS}\` (403 \`forbidden\` otherwise).`;

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long; nothing of it was written.',
  standardSchema: ErrorDocument,
};

/**
 * Backups (#529): the settings, the key, the requests to the backup
 * process, the history and the status for the admin overview. Every route
 * needs `admin.backups`. See the README, "Backups", and `deploy/README.md`.
 */
@ApiTags('backups')
@Controller()
@JsonApi()
export class BackupsController {
  constructor(
    private readonly getSettings: GetBackupSettingsAction,
    private readonly updateSettings: UpdateBackupSettingsAction,
    private readonly createKey: CreateBackupKeyAction,
    private readonly listKeys: ListBackupKeysAction,
    private readonly listRuns: ListBackupRunsAction,
    private readonly requestBackup: RequestBackupAction,
    private readonly getRequest: GetBackupRequestAction,
    private readonly getStatus: GetBackupStatusAction,
  ) {}

  @Get('backup-settings')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Backup settings',
    description: `The settings in force: what the page set, with what the backup service’s environment fixes in its place (\`meta.fixed\`), the next three runs, whether the backup service runs, and the key by fingerprint. Never the S3 secret key nor the key’s identity. ${NEEDS}`,
  })
  @ApiOkResponse({ standardSchema: BackupSettingsDocument })
  @ApiPermission(MANAGE_BACKUPS)
  async settings(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof BackupSettingsDocument>> {
    return {
      data: toBackupSettingsResource(await this.getSettings.handle({ actor })),
    };
  }

  @Patch('backup-settings')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Change the backup settings',
    description: `What is left out stays; \`location\` is given whole (an S3 location’s secret key is write-only: a value sets it, null removes it, left out keeps it). A change applies at the backup service’s next pass, without a restart. Recorded as \`backup-settings.update\` with the old and new values (the S3 secret key only as \`set\`, \`replaced\` or \`removed\`). ${NEEDS}`,
  })
  @ApiOkResponse({ standardSchema: BackupSettingsDocument })
  @ApiConflictResponse({
    description:
      '`backup-setting-fixed-by-environment`: a variable of the backup service fixes that setting (`meta.setting`, `meta.variable`). `secret-key-missing`: the instance has no secret key to seal the S3 secret key with.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'One error per problem: `backup-path-outside-volume` (a subfolder that is absolute, holds `..` or a name outside letters, digits, `.`, `_`, `-`), `invalid-schedule`, `invalid-time-zone`, `invalid-endpoint`, `invalid-bucket`, `invalid-prefix`; several at once as `invalid-backup-settings`. `secret-required`: another endpoint, bucket or access key without the secret key again. `backup-identity-missing`: verifying by decrypting needs a key whose identity the server keeps (rotate the key).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission(MANAGE_BACKUPS)
  async update(
    @CurrentActor() actor: Actor,
    @Body({ schema: UpdateBackupSettingsDocument })
    body: UpdateBackupSettingsDocument,
  ): Promise<z.infer<typeof BackupSettingsDocument>> {
    const a = body.data.attributes ?? {};
    const view = await this.updateSettings.handle({
      actor,
      changes: {
        ...(a.enabled !== undefined && { enabled: a.enabled }),
        ...(a.frequency !== undefined && { frequency: a.frequency }),
        ...(a.time !== undefined && { time: a.time }),
        ...(a.timeZone !== undefined && { timeZone: a.timeZone }),
        ...(a.retention !== undefined && { retention: a.retention }),
        ...(a.location !== undefined && { location: a.location }),
        ...(a.verify !== undefined && { verify: a.verify }),
        ...(a.verifyByDecrypting !== undefined && {
          verifyByDecrypting: a.verifyByDecrypting,
        }),
      },
    });
    return { data: toBackupSettingsResource(view) };
  }

  @Get('backup-keys')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'Backup keys',
    description: `Every backup key, newest first, by fingerprint (a backup names the key it was encrypted to). Never an identity. ${NEEDS}`,
  })
  @ApiOkResponse({ standardSchema: BackupKeyPageDocument })
  @ApiPermission(MANAGE_BACKUPS)
  async keys(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof BackupKeyPageDocument>> {
    return toPagedDocument(
      req,
      page,
      await this.listKeys.handle({ actor, page }),
      toBackupKeyResource,
    );
  }

  @Post('backup-keys')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Make or rotate the backup key',
    description: `Makes the backup key (an age X25519 key) and answers its identity **once**, in \`meta.identity\`: without it no backup can be restored, so keep it, away from the backups. With \`meta.rotate: true\`, replaces the current key: later backups are encrypted to the new one, earlier ones stay readable with the old one. The server keeps the identity sealed only while \`verifyByDecrypting\` is on. Recorded as \`backup-key.create\` or \`backup-key.rotate\` (fingerprints only). ${NEEDS}`,
  })
  @ApiCreatedResponse({ standardSchema: MadeBackupKeyDocument })
  @ApiConflictResponse({
    description:
      '`backup-key-exists`: there is a key already (rotate it). `backup-setting-fixed-by-environment`: `CCMS_BACKUP_KEY_FILE` sets the key. `secret-key-missing`: no instance secret key to seal the identity with.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission(MANAGE_BACKUPS)
  async makeKey(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateBackupKeyDocument }) body: CreateBackupKeyDocument,
  ): Promise<z.infer<typeof MadeBackupKeyDocument>> {
    const made = await this.createKey.handle({
      actor,
      rotate: body.meta?.rotate === true,
    });
    return toMadeBackupKeyDocument(made);
  }

  @Get('backup-runs')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'Backup history',
    description: `The runs, newest first: when, size, duration, location, the key’s fingerprint, verified or failed and why. ${NEEDS}`,
  })
  @ApiOkResponse({ standardSchema: BackupRunPageDocument })
  @ApiPermission(MANAGE_BACKUPS)
  async runs(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof BackupRunPageDocument>> {
    return toPagedDocument(
      req,
      page,
      await this.listRuns.handle({ actor, page }),
      toBackupRunResource,
    );
  }

  @Post('backup-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Back up now, or test the location',
    description: `Asks the backup service to back up now (\`run\`) or to test the location (\`test-location\`: write, read back and delete a small object, reporting the exact error). It takes the request within seconds; read its result with \`GET /backup-requests/{id}\`. A request of the same kind still waiting is answered instead of a second. Recorded as \`backup.request\`. ${NEEDS}`,
  })
  @ApiAcceptedResponse({ standardSchema: BackupRequestDocument })
  @ApiConflictResponse({
    description:
      '`backup-service-not-running`: no heartbeat from the backup service in the last minute. `backup-key-missing`: no key to encrypt to yet.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission(MANAGE_BACKUPS)
  async request(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateBackupRequestDocument })
    body: CreateBackupRequestDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof BackupRequestDocument>> {
    const request = await this.requestBackup.handle({
      actor,
      kind: body.data.attributes.kind,
    });
    res.setHeader('Location', `/backup-requests/${request.id}`);
    return { data: toBackupRequestResource(request) };
  }

  @Get('backup-requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A backup request',
    description: `A request and, once the backup service answered it, its result. ${NEEDS}`,
  })
  @ApiParam({
    name: 'requestId',
    description: 'The request’s ID (a UUID).',
    schema: { type: 'string' },
  })
  @ApiOkResponse({ standardSchema: BackupRequestDocument })
  @ApiNotFoundResponse({
    description: '`not-found`',
    standardSchema: ErrorDocument,
  })
  @ApiPermission(MANAGE_BACKUPS)
  async requestOf(
    @CurrentActor() actor: Actor,
    @Param('requestId') id: string,
  ): Promise<z.infer<typeof BackupRequestDocument>> {
    return {
      data: toBackupRequestResource(
        await this.getRequest.handle({ actor, id }),
      ),
    };
  }

  @Get('backup-status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Backup status',
    description: `For the admin overview: the last run, the last good one, and a warning when backups are not set up, the backup service is not running, the last run failed, or the last good backup is older than \`CCMS_BACKUP_WARN_AFTER_HOURS\` (default 26). ${NEEDS}`,
  })
  @ApiOkResponse({ standardSchema: BackupStatusDocument })
  @ApiPermission(MANAGE_BACKUPS)
  async status(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof BackupStatusDocument>> {
    return {
      data: toBackupStatusResource(await this.getStatus.handle({ actor })),
    };
  }
}
