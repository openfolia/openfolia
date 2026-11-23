import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import {
  GetSecretKeyAction,
  READ_SECRET_KEY,
} from '../core/actions/get-secret-key.action.js';
import {
  SecretKeyDocument,
  toSecretKeyDocument,
} from './secret-key.resources.js';

/** `GET /secret-key` (#470), for Admin → System. */
@ApiTags('system')
@Controller('secret-key')
@JsonApi()
export class SecretKeyController {
  constructor(private readonly getKey: GetSecretKeyAction) {}

  @Get()
  @ApiOperation({
    summary: 'Where the secret key is',
    description: `Where the instance secret key comes from, which seals the secrets the server stores (webhook signing secrets): the key file the server made on its first start (with its path, to back up), a variable the operator set, or none. Never the key itself. Needs the \`${READ_SECRET_KEY}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: SecretKeyDocument })
  @ApiPermission(READ_SECRET_KEY)
  async get(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof SecretKeyDocument>> {
    return toSecretKeyDocument(await this.getKey.handle({ actor }));
  }
}
