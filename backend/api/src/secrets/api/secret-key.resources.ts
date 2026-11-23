import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type { SecretKeyReport } from '../core/actions/get-secret-key.action.js';

export const SecretKeyResource = resourceObject('SecretKey', {
  attributes: z.object({
    origin: z
      .enum(['file', 'environment', 'none'])
      .describe(
        'Where the instance secret key comes from: `file`, the key file (made by the server on its first start, or put there by the operator); `environment`, a variable the operator set; `none`, no key (generation turned off and none set): webhooks are off.',
      ),
    file: z
      .string()
      .nullable()
      .describe(
        'The key file’s path on the server, for `file` (back it up: without it, stored secrets cannot be read); else null.',
      ),
    variable: z
      .enum(['CCMS_SECRET_KEY', 'CCMS_WEBHOOKS_SECRET_KEY'])
      .nullable()
      .describe(
        'The variable that sets the key, for `environment` (`CCMS_WEBHOOKS_SECRET_KEY` is its old name, deprecated); else null.',
      ),
    generate: z
      .boolean()
      .describe(
        'Whether the server makes the key file on its first start when there is none (`CCMS_SECRET_KEY_GENERATE`).',
      ),
  }),
})
  .describe('`id` is always `instance`. Never the key itself.')
  .meta({ id: 'SecretKeyResource' });

export const SecretKeyDocument = singleDocument(SecretKeyResource).meta({
  id: 'SecretKeyDocument',
});

export function toSecretKeyDocument(
  report: SecretKeyReport,
): z.infer<typeof SecretKeyDocument> {
  const { origin } = report;
  return {
    data: {
      type: 'SecretKey',
      id: 'instance',
      attributes: {
        origin: origin.kind,
        file: origin.kind === 'file' ? origin.path : null,
        variable: origin.kind === 'environment' ? origin.variable : null,
        generate: report.generate,
      },
    },
  };
}
