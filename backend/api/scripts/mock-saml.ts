/**
 * The local SAML 2.0 identity provider (`tests/saml/mock-idp.ts`) as a process of its own: for
 * the editor's browser flows (`frontend/editor-e2e/stack/`, #376), in front of an API without the
 * shared token (the dev server's proxy adds one, so it is no way to try SAML). A test provider
 * only: no passwords, plain http on 127.0.0.1, a key made at start and never kept.
 *
 *   node backend/api/scripts/mock-saml.ts    settings from the environment:
 *     MOCK_SAML_PORT       the port (default: one the system hands out)
 *     MOCK_SAML_HOST       the address it listens on (default 127.0.0.1)
 *     MOCK_SAML_AUDIENCE   the API's entity ID (default: <editor>/api/auth/saml/metadata)
 *     MOCK_SAML_ACS_URL    the API's assertion consumer service (<editor>/api/auth/saml/callback)
 *     MOCK_SAML_ACCOUNTS   the people, as JSON: {"<login>": {"name", "email", "groups"}}
 *   prints `ready <port>` and then `metadata <url>` (CCMS_SAML_IDP_METADATA_URL) once it listens.
 */
import { startMockSamlIdp } from '../tests/saml/mock-idp.ts';

const acsUrl = process.env['MOCK_SAML_ACS_URL'] ?? '';
if (!URL.canParse(acsUrl)) {
  console.error('mock-saml: MOCK_SAML_ACS_URL is required');
  process.exit(2);
}

const mock = await startMockSamlIdp({
  acsUrl,
  audience:
    process.env['MOCK_SAML_AUDIENCE'] ||
    new URL('metadata', new URL('.', acsUrl)).href,
  accounts: JSON.parse(process.env['MOCK_SAML_ACCOUNTS'] || '{}'),
  port: Number(process.env['MOCK_SAML_PORT']) || 0,
  host: process.env['MOCK_SAML_HOST'] || undefined,
});
console.log(`ready ${new URL(mock.metadataUrl).port}`);
console.log(`metadata ${mock.metadataUrl}`);

const stop = () => void mock.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
