import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { Public } from '../../base/api/public.decorator.js';
import type { Env } from '../../config/env.js';
import { AboutDocument, LICENSE, LICENSE_URL } from './about.resources.js';

/**
 * `GET /about` (#370): the licence and where the source is, for the editor's links and any other
 * client. Public, like the health check: someone who cannot sign in is offered the source too.
 * Read from the settings alone, so there is no action behind it.
 */
@ApiTags('about')
@Controller('about')
@JsonApi()
export class AboutController {
  private readonly about: z.infer<typeof AboutDocument>;

  constructor(config: ConfigService<Env, true>) {
    this.about = {
      data: {
        type: 'About',
        id: 'about',
        attributes: {
          license: LICENSE,
          licenseUrl: LICENSE_URL,
          sourceUrl: config.get('CCMS_SOURCE_URL', { infer: true }) ?? null,
          docsUrl: config.get('CCMS_DOCS_URL', { infer: true }),
        },
      },
    };
  }

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Licence and source code',
    description:
      'The licence (AGPL-3.0-only), where this deployment’s source code is and where its user guide is, for links in a client; needs no token.',
  })
  @ApiOkResponse({ standardSchema: AboutDocument })
  get(): z.infer<typeof AboutDocument> {
    return this.about;
  }
}
