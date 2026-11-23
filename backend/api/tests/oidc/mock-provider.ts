// A local OpenID Connect provider for tests (#37): a real one (`oidc-provider`, a test
// dependency), on a loopback port, with a sign-in page that takes a login name and no password.
// Nothing external is called. Used by the API's tests (`sign-in.e2e.spec.ts`), the editor's
// browser flows (`frontend/editor-e2e/stack/`) and, as a process of its own, by
// `scripts/mock-oidc.ts` (the editor's flows, and trying sign-in on a local run).
//
// This file imports only packages, never another file of this repository, so Node runs it as it
// is (type stripping) from `scripts/mock-oidc.ts` too.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider, { type Configuration } from 'oidc-provider';

/** A person the mock signs in, by login name (also the subject, `sub`). */
export interface MockAccount {
  readonly name?: string;
  readonly email?: string;
  /** Default true when there is an email address. */
  readonly emailVerified?: boolean;
  readonly groups?: readonly string[];
}

export interface MockProviderOptions {
  /** The client the API signs in as. */
  readonly clientId: string;
  /** Unset: a public client (PKCE only). */
  readonly clientSecret?: string;
  /** The API's callback address(es). */
  readonly redirectUris: readonly string[];
  /** Where the provider may send the browser after signing out. */
  readonly postLogoutRedirectUris?: readonly string[];
  /** The people it signs in; changeable while it runs (`accounts`). */
  readonly accounts: Record<string, MockAccount>;
  /** The port (default: one the system hands out), on 127.0.0.1. */
  readonly port?: number;
  /**
   * The address it listens on (default 127.0.0.1). The issuer stays `http://127.0.0.1:<port>`:
   * `0.0.0.0` only where 127.0.0.1 reaches it for everyone, as in the API container's network
   * with the port published on 127.0.0.1 (`deploy/smoke-oidc.yaml`).
   */
  readonly host?: string;
  /** The claim the groups are sent in (default `groups`). */
  readonly groupsClaim?: string;
}

export interface MockProvider {
  /** The issuer, e.g. `http://127.0.0.1:53211`. */
  readonly issuer: string;
  /** The people it signs in, by login name: change them between sign-ins. */
  readonly accounts: Record<string, MockAccount>;
  close(): Promise<void>;
}

/** The sign-in page's form: one field, `login`, posted back to the same address. */
export const MOCK_LOGIN_FIELD = 'login';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

const page = (uid: string, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock provider: sign in</title></head>
<body>
<h1>Mock provider</h1>
${error ? `<p role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/interaction/${escape(uid)}">
<label>Login <input name="${MOCK_LOGIN_FIELD}" autocomplete="off" autofocus></label>
<button type="submit">Sign in</button>
</form>
</body></html>`;

async function formOf(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 10_000) break;
  }
  return new URLSearchParams(body);
}

/** Starts the mock provider; `close()` stops it. */
export async function startMockProvider(
  options: MockProviderOptions,
): Promise<MockProvider> {
  const accounts = options.accounts;
  const groupsClaim = options.groupsClaim ?? 'groups';
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () =>
      resolve(),
    );
  });
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  const configuration: Configuration = {
    clients: [
      {
        client_id: options.clientId,
        ...(options.clientSecret
          ? {
              client_secret: options.clientSecret,
              token_endpoint_auth_method: 'client_secret_basic',
            }
          : { token_endpoint_auth_method: 'none' }),
        redirect_uris: [...options.redirectUris],
        post_logout_redirect_uris: [...(options.postLogoutRedirectUris ?? [])],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    ],
    // Every claim in the ID token too, as many providers send them.
    conformIdTokenClaims: false,
    claims: {
      openid: ['sub'],
      profile: ['name', 'preferred_username', groupsClaim],
      email: ['email', 'email_verified'],
    },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        // Signs out without asking: a test has nobody to ask.
        logoutSource: (ctx, form) => {
          ctx.type = 'html';
          ctx.body = `<!doctype html><html><body>${form}<script>document.forms[0].submit()</script></body></html>`;
        },
      },
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: (_ctx, sub) => {
      const account = accounts[sub];
      if (!account) return undefined;
      return {
        accountId: sub,
        claims: () => ({
          sub,
          preferred_username: sub,
          ...(account.name !== undefined && { name: account.name }),
          ...(account.email !== undefined && {
            email: account.email,
            email_verified: account.emailVerified ?? true,
          }),
          [groupsClaim]: [...(account.groups ?? [])],
        }),
      };
    },
    // A fixed signing key is not needed: one is made per start.
    ttl: { Interaction: 600, Session: 3600, Grant: 3600 },
  };
  const provider = new Provider(issuer, configuration);
  // Plain http on loopback: tests only.
  provider.on('server_error', (_ctx, error) =>
    console.error('mock-oidc:', error),
  );
  const handle = provider.callback();

  server.on('request', (req, res) => {
    const match = /^\/interaction\/([\w-]+)$/.exec(req.url ?? '');
    if (!match) {
      handle(req, res);
      return;
    }
    void (async () => {
      try {
        const details = await provider.interactionDetails(req, res);
        const show = (error?: string) => {
          res.writeHead(error ? 401 : 200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(page(details.uid, error));
        };
        const grantAll = async (accountId: string) => {
          const grant = details.grantId
            ? await provider.Grant.find(details.grantId)
            : new provider.Grant({
                accountId,
                clientId: String(details.params['client_id']),
              });
          if (!grant) throw new Error('grant not found');
          grant.addOIDCScope(String(details.params['scope'] ?? 'openid'));
          return grant.save();
        };
        if (details.prompt.name === 'consent' && details.session?.accountId) {
          const grantId = await grantAll(details.session.accountId);
          await provider.interactionFinished(
            req,
            res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
          return;
        }
        if (req.method !== 'POST') {
          show();
          return;
        }
        const login = (await formOf(req)).get(MOCK_LOGIN_FIELD)?.trim() ?? '';
        if (!accounts[login]) {
          show(`No account "${login}".`);
          return;
        }
        const grantId = await grantAll(login);
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId: login }, consent: { grantId } },
          { mergeWithLastSubmission: false },
        );
      } catch (error) {
        console.error('mock-oidc: interaction failed', error);
        if (!res.headersSent)
          res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('interaction failed');
      }
    })();
  });

  return {
    issuer,
    accounts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
