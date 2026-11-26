import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeenAssertions } from '../core/seen-assertions.js';
import {
  SamlIdentityProvider,
  type SamlSettings,
} from './saml-identity-provider.js';

const dir = mkdtempSync(join(tmpdir(), 'openfolia-test-saml-idp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A throwaway certificate's base64 body, as metadata carries it. */
function certificate(): string {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=idp',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  return readFileSync(join(dir, 'cert.pem'), 'utf8')
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .trim();
}

const CERT = certificate();

const metadata = (sso: string) =>
  `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.org/saml"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sso}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;

const settings = (source: SamlSettings['metadata']): SamlSettings => ({
  metadata: source,
  entityId: 'https://team.example.org/saml',
  acsUrl: 'https://team.example.org/acs',
  nameIdFormat: 'persistent',
  emailAttribute: 'email',
  nameAttribute: 'name',
  groupsAttribute: 'groups',
  emailVerified: true,
  idpInitiated: false,
});

const provider = (source: SamlSettings['metadata']) =>
  new SamlIdentityProvider(settings(source), {} as SeenAssertions);

const URL_SOURCE = { url: 'https://idp.example.org/metadata' };
const xml = (text: string) => new Response(text, { status: 200 });

describe('SamlIdentityProvider.answersNow (#953)', () => {
  let fetched: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetched = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetched.mockRestore());

  it('allows it when the metadata address answers with valid metadata', async () => {
    fetched.mockResolvedValue(xml(metadata('https://idp.example.org/sso')));
    await expect(provider(URL_SOURCE).answersNow()).resolves.toBeUndefined();
  });

  it('reads the metadata again, however recent the last read', async () => {
    fetched.mockImplementation(() =>
      Promise.resolve(xml(metadata('https://idp.example.org/sso'))),
    );
    const saml = provider(URL_SOURCE);
    await saml.begin();
    await saml.answersNow();
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('refuses when the metadata address is unreachable, keeping what sign-ins use', async () => {
    fetched.mockResolvedValueOnce(xml(metadata('https://idp.example.org/old')));
    const saml = provider(URL_SOURCE);
    await saml.begin();
    fetched.mockRejectedValue(new TypeError('fetch failed'));
    await expect(saml.answersNow()).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    expect((await saml.begin()).authorizationUrl).toContain('/old');
  });

  it('refuses invalid metadata and never lets it replace what sign-ins use', async () => {
    fetched.mockResolvedValueOnce(xml(metadata('https://idp.example.org/old')));
    const saml = provider(URL_SOURCE);
    await saml.begin();
    fetched.mockResolvedValue(xml('<html>not metadata</html>'));
    await expect(saml.answersNow()).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    fetched.mockResolvedValue(new Response('', { status: 503 }));
    await expect(saml.answersNow()).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    expect((await saml.begin()).authorizationUrl).toContain('/old');
    // Only one read for sign-ins: the kept copy is used, not the refused ones.
    fetched.mockClear();
    await saml.begin();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('takes valid metadata it read for the sign-ins that follow', async () => {
    fetched.mockResolvedValueOnce(xml(metadata('https://idp.example.org/old')));
    const saml = provider(URL_SOURCE);
    await saml.begin();
    fetched.mockResolvedValue(xml(metadata('https://idp.example.org/new')));
    await saml.answersNow();
    expect((await saml.begin()).authorizationUrl).toContain('/new');
  });

  it('keeps what answersNow read when an earlier sign-in read fails after it', async () => {
    let fail!: (error: Error) => void;
    fetched.mockReturnValueOnce(
      new Promise<Response>((_, reject) => (fail = reject)),
    );
    const saml = provider(URL_SOURCE);
    const begun = saml.begin();
    fetched.mockResolvedValue(xml(metadata('https://idp.example.org/new')));
    await saml.answersNow();
    fail(new TypeError('fetch failed'));
    await expect(begun).rejects.toBeDefined();
    fetched.mockClear();
    expect((await saml.begin()).authorizationUrl).toContain('/new');
    expect(fetched).not.toHaveBeenCalled();
  });

  it('gives the read a time limit', async () => {
    fetched.mockResolvedValue(xml(metadata('https://idp.example.org/sso')));
    await provider(URL_SOURCE).answersNow();
    const init = fetched.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
  });

  it('cannot check metadata from a file: it answers from the file, as before', async () => {
    const file = join(dir, 'idp.xml');
    writeFileSync(file, metadata('https://idp.example.org/sso'));
    const saml = provider({ file });
    await expect(saml.answersNow()).resolves.toBeUndefined();
    expect(fetched).not.toHaveBeenCalled();
    writeFileSync(file, 'not metadata');
    // Kept from the first read, not read again.
    await expect(saml.answersNow()).resolves.toBeUndefined();
  });
});
