// A local SAML 2.0 identity provider for tests (#376): metadata, a sign-in page that takes a
// login name and no password, and signed answers posted back to the service provider over the
// HTTP-POST binding, on a loopback port. It also makes answers a test shapes itself (unsigned,
// signed with another key, for another audience, expired, …). Nothing external is called. Used by
// the API's tests (`saml-sign-in.e2e.spec.ts`) and, as a process of its own, by
// `scripts/mock-saml.ts` (the editor's browser flows, and trying SAML on a local run).
//
// This file imports only packages, never another file of this repository, so Node runs it as it
// is (type stripping) from `scripts/mock-saml.ts` too.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

/**
 * A person the mock signs in, by login name; their NameID is `id-<login>` (persistent), or in the
 * Format a request's NameIDPolicy asks for.
 */
export interface MockSamlAccount {
  readonly name?: string;
  readonly email?: string;
  readonly groups?: readonly string[];
}

export interface MockSamlOptions {
  /** The service provider's entity ID: the audience of its answers. */
  readonly audience: string;
  /** The service provider's assertion consumer service: the recipient of its answers. */
  readonly acsUrl: string;
  /** The people it signs in; changeable while it runs (`accounts`). */
  readonly accounts: Record<string, MockSamlAccount>;
  /** The port (default: one the system hands out), on 127.0.0.1. */
  readonly port?: number;
  /** Name another signing certificate in the metadata, before its own (a key being replaced). */
  readonly secondCertificate?: boolean;
  /** The address it listens on (default 127.0.0.1); its addresses stay `http://127.0.0.1:<port>`. */
  readonly host?: string;
}

/** How a test shapes an answer (`MockSamlIdp.answer`). */
export interface AnswerOptions {
  readonly login: string;
  /** The request it answers; unset: unsolicited (IdP-initiated). */
  readonly inResponseTo?: string;
  /** Leave the (unsigned) Response's InResponseTo out, keeping the assertion's: as an attacker would. */
  readonly stripResponseInResponseTo?: boolean;
  /** `idp` (default): its own key; `other`: a key nobody trusts; `none`: unsigned. */
  readonly signWith?: 'idp' | 'other' | 'none';
  readonly audience?: string;
  readonly recipient?: string;
  /** Its NameID (default: `id-<login>`, persistent); null: none. */
  readonly nameId?: {
    readonly value: string;
    readonly format?: string;
    readonly nameQualifier?: string;
    readonly spNameQualifier?: string;
  } | null;
  /** Changes the assertion's XML before it is signed. */
  readonly reshape?: (assertion: string) => string;
  /**
   * Signs the response, as it is after this change, once its assertion is signed (or is not:
   * `signWith` `none`).
   */
  readonly signResponse?: (xml: string) => string;
  /** Attributes besides the account's own, by name. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** When the assertion stops counting (default: five minutes from now). */
  readonly notOnOrAfter?: Date;
  /** Its time of issue (default: now). */
  readonly issuedAt?: Date;
  /** Changes the XML after signing (a tampered answer). */
  readonly tamper?: (xml: string) => string;
}

export interface MockSamlIdp {
  /** Its entity ID, e.g. `http://127.0.0.1:53211/idp`. */
  readonly entityId: string;
  /** Where its metadata is. */
  readonly metadataUrl: string;
  /** The people it signs in, by login name: change them between sign-ins. */
  readonly accounts: Record<string, MockSamlAccount>;
  /** An answer (`SAMLResponse`, base64), shaped by `options`. */
  answer(options: AnswerOptions): string;
  close(): Promise<void>;
}

/** The sign-in page's form: one field, `login`. */
export const MOCK_SAML_LOGIN_FIELD = 'login';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

interface KeyPair {
  readonly key: string;
  readonly cert: string;
}

/** A throwaway RSA key and self-signed certificate (`openssl`, a day), never kept. */
function makeKeyPair(): KeyPair {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-test-saml-'));
  try {
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=mock-saml-idp',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(keyFile, 'utf8'),
      cert: readFileSync(certFile, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certBody = (pem: string) =>
  pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

/** Signs the element at `signedAt`, the signature after its Issuer. */
function sign(xml: string, pair: KeyPair, signedAt: string): string {
  const signed = new SignedXml({
    privateKey: pair.key,
    publicCert: pair.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signed.addReference({
    xpath: signedAt,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  signed.computeSignature(xml, {
    location: {
      reference: `${signedAt}/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return signed.getSignedXml();
}

async function formOf(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 10_000) break;
  }
  return new URLSearchParams(body);
}

/** What a sign-in request asks for: its ID, and the NameID's Format and qualifier (its NameIDPolicy). */
interface Asked {
  readonly id: string;
  readonly format: string;
  readonly spNameQualifier: string;
}

/**
 * Reads a sign-in request (HTTP-Redirect binding: deflated, base64), signed or not: as most
 * providers do, the mock answers whatever the browser brings.
 */
function readRequest(samlRequest: string): Asked | undefined {
  try {
    const xml = inflateRawSync(Buffer.from(samlRequest, 'base64')).toString(
      'utf8',
    );
    const id = /<samlp:AuthnRequest\b[^>]*\sID="([^"]+)"/.exec(xml)?.[1];
    if (!id) return undefined;
    const policy = /<samlp:NameIDPolicy\b[^>]*>/.exec(xml)?.[0] ?? '';
    const of = (name: string) =>
      new RegExp(`\\s${name}="([^"]*)"`).exec(policy)?.[1] ?? '';
    return {
      id,
      format: of('Format'),
      spNameQualifier: of('SPNameQualifier'),
    };
  } catch {
    return undefined;
  }
}

const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

/** The NameID of `login` in the Format asked for (none: persistent). */
function nameIdFor(
  login: string,
  account: MockSamlAccount,
  asked: Omit<Asked, 'id'>,
): NonNullable<AnswerOptions['nameId']> {
  const format = asked.format || PERSISTENT;
  const values: Record<string, string> = {
    transient: `_t${randomUUID()}`,
    emailAddress: account.email ?? `${login}@example.org`,
    unspecified: login,
  };
  return {
    value: values[format.split(':').at(-1) ?? ''] ?? `id-${login}`,
    format,
    ...(asked.spNameQualifier && { spNameQualifier: asked.spNameQualifier }),
  };
}

const loginPage = (asked: Asked, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock SAML provider: sign in</title></head>
<body>
<h1>Mock SAML provider</h1>
${error ? `<p role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/sso/login">
<input type="hidden" name="requestId" value="${escape(asked.id)}">
<input type="hidden" name="format" value="${escape(asked.format)}">
<input type="hidden" name="spNameQualifier" value="${escape(asked.spNameQualifier)}">
<label>Login <input name="${MOCK_SAML_LOGIN_FIELD}" autocomplete="off" autofocus></label>
<button type="submit">Sign in</button>
</form>
</body></html>`;

/** The page that posts the answer to the service provider (HTTP-POST binding). */
const postPage = (acsUrl: string, response: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock SAML provider: signing in</title></head>
<body>
<form method="post" action="${escape(acsUrl)}">
<input type="hidden" name="SAMLResponse" value="${escape(response)}">
<button type="submit">Continue</button>
</form>
<script>document.forms[0].submit()</script>
</body></html>`;

export async function startMockSamlIdp(
  options: MockSamlOptions,
): Promise<MockSamlIdp> {
  const own = makeKeyPair();
  const other = makeKeyPair();
  const accounts = options.accounts;
  let base = '';
  const entityId = () => `${base}/idp`;

  const rolled = options.secondCertificate ? makeKeyPair() : undefined;
  const keyDescriptor = (pair: KeyPair) =>
    `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(pair.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;

  const metadata = () => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${escape(entityId())}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${rolled ? keyDescriptor(rolled) : ''}${keyDescriptor(own)}
    <md:NameIDFormat>${PERSISTENT}</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escape(base)}/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

  const answer = (shape: AnswerOptions): string => {
    const account = accounts[shape.login];
    if (!account) throw new Error(`no account "${shape.login}"`);
    const issued = shape.issuedAt ?? new Date();
    const until = shape.notOnOrAfter ?? new Date(issued.getTime() + 5 * 60_000);
    const iso = (date: Date) => date.toISOString();
    const recipient = shape.recipient ?? options.acsUrl;
    const inResponseTo = shape.inResponseTo
      ? ` InResponseTo="${escape(shape.inResponseTo)}"`
      : '';
    const attribute = (name: string, values: readonly string[]) =>
      values.length === 0
        ? ''
        : `<saml:Attribute Name="${escape(name)}">${values
            .map(
              (v) => `<saml:AttributeValue>${escape(v)}</saml:AttributeValue>`,
            )
            .join('')}</saml:Attribute>`;
    const name =
      shape.nameId === undefined
        ? nameIdFor(shape.login, account, { format: '', spNameQualifier: '' })
        : shape.nameId;
    const given = (key: string, value: string | undefined) =>
      value === undefined ? '' : ` ${key}="${escape(value)}"`;
    const nameId = name
      ? `<saml:NameID${given('NameQualifier', name.nameQualifier)}${given('SPNameQualifier', name.spNameQualifier)}${given('Format', name.format)}>${escape(name.value)}</saml:NameID>`
      : '';
    const more = Object.entries(shape.attributes ?? {})
      .map(([key, value]) => attribute(key, [value]))
      .join('');
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${randomUUID()}" Version="2.0" IssueInstant="${iso(issued)}"><saml:Issuer>${escape(entityId())}</saml:Issuer><saml:Subject>${nameId}<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(until)}" Recipient="${escape(recipient)}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(new Date(issued.getTime() - 1000))}" NotOnOrAfter="${iso(until)}"><saml:AudienceRestriction><saml:Audience>${escape(shape.audience ?? options.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(issued)}" SessionIndex="_s${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attribute('email', account.email ? [account.email] : [])}${attribute('name', account.name ? [account.name] : [])}${attribute('groups', account.groups ?? [])}${more}</saml:AttributeStatement></saml:Assertion>`;
    let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${iso(issued)}" Destination="${escape(recipient)}"${shape.stripResponseInResponseTo ? '' : inResponseTo}><saml:Issuer>${escape(entityId())}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${shape.reshape?.(assertion) ?? assertion}</samlp:Response>`;
    const signWith = shape.signWith ?? 'idp';
    const pair = signWith === 'other' ? other : own;
    if (signWith !== 'none') {
      xml = sign(xml, pair, "/*/*[local-name(.)='Assertion']");
    }
    if (shape.signResponse) xml = sign(shape.signResponse(xml), pair, '/*');
    if (shape.tamper) xml = shape.tamper(xml);
    return Buffer.from(xml, 'utf8').toString('base64');
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const html = (status: number, body: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (req.method === 'GET' && url.pathname === '/metadata') {
        res.writeHead(200, { 'Content-Type': 'application/samlmetadata+xml' });
        res.end(metadata());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/sso') {
        const asked = readRequest(url.searchParams.get('SAMLRequest') ?? '');
        if (!asked) return html(400, '<p>No sign-in request.</p>');
        return html(200, loginPage(asked));
      }
      if (req.method === 'POST' && url.pathname === '/sso/login') {
        const form = await formOf(req);
        const asked = {
          id: form.get('requestId') ?? '',
          format: form.get('format') ?? '',
          spNameQualifier: form.get('spNameQualifier') ?? '',
        };
        const login = form.get(MOCK_SAML_LOGIN_FIELD) ?? '';
        const account = accounts[login];
        if (!account) {
          return html(200, loginPage(asked, `No account "${login}".`));
        }
        return html(
          200,
          postPage(
            options.acsUrl,
            answer({
              login,
              inResponseTo: asked.id,
              nameId: nameIdFor(login, account, asked),
            }),
          ),
        );
      }
      // IdP-initiated: `/sso/start?login=<login>` answers to no request.
      if (req.method === 'GET' && url.pathname === '/sso/start') {
        const login = url.searchParams.get(MOCK_SAML_LOGIN_FIELD) ?? '';
        if (!accounts[login]) return html(404, '<p>No such account.</p>');
        return html(200, postPage(options.acsUrl, answer({ login })));
      }
      html(404, '<p>Not found.</p>');
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () =>
      resolve(),
    );
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return {
    entityId: entityId(),
    metadataUrl: `${base}/metadata`,
    accounts,
    answer,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
