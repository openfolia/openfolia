/**
 * The local OpenID Connect provider (`tests/oidc/mock-provider.ts`) as a process of its own: for
 * the editor's browser flows (`frontend/editor-e2e/stack/`) and for trying sign-in on a local
 * run (#37). A test provider only: no passwords, plain http on 127.0.0.1.
 *
 *   node backend/api/scripts/mock-oidc.ts    settings from the environment:
 *     MOCK_OIDC_PORT              the port (default: one the system hands out)
 *     MOCK_OIDC_HOST              the address it listens on (default 127.0.0.1; the issuer stays
 *                                 http://127.0.0.1:<port>, deploy/smoke-oidc.yaml)
 *     MOCK_OIDC_CLIENT_ID         the client the API signs in as (default `openfolia-local`)
 *     MOCK_OIDC_CLIENT_SECRET     its secret (unset: a public client, PKCE only)
 *     MOCK_OIDC_REDIRECT_URIS     the API's callback address(es), comma-separated
 *     MOCK_OIDC_POST_LOGOUT_URIS  where it may send the browser after signing out, comma-separated
 *     MOCK_OIDC_ACCOUNTS          the people, as JSON: {"<login>": {"name", "email", "groups"}}
 *   prints `ready <port>` and then `issuer <url>` once it listens.
 */
import { startMockProvider } from '../tests/oidc/mock-provider.ts';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const redirectUris = list(process.env['MOCK_OIDC_REDIRECT_URIS']);
if (redirectUris.length === 0) {
  console.error('mock-oidc: MOCK_OIDC_REDIRECT_URIS is required');
  process.exit(2);
}

const mock = await startMockProvider({
  clientId: process.env['MOCK_OIDC_CLIENT_ID'] || 'openfolia-local',
  clientSecret: process.env['MOCK_OIDC_CLIENT_SECRET'] || undefined,
  redirectUris,
  postLogoutRedirectUris: list(process.env['MOCK_OIDC_POST_LOGOUT_URIS']),
  accounts: JSON.parse(process.env['MOCK_OIDC_ACCOUNTS'] || '{}'),
  port: Number(process.env['MOCK_OIDC_PORT']) || 0,
  host: process.env['MOCK_OIDC_HOST'] || undefined,
});
console.log(`ready ${new URL(mock.issuer).port}`);
console.log(`issuer ${mock.issuer}`);

const stop = () => void mock.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
