import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIdpMetadata, SamlMetadataError } from './saml-metadata.js';

/** A throwaway certificate's base64 body, as metadata carries it. */
function certificate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openfolia-test-saml-md-'));
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CERT = certificate();

const entity = ({
  id = 'https://idp.example.org/saml',
  sso = '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.org/post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/sso"/>',
  keys = `<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>\n${CERT}\n</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
} = {}) =>
  `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${id}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keys}${sso}</md:IDPSSODescriptor></md:EntityDescriptor>`;

describe('readIdpMetadata (#376)', () => {
  it('reads the entity ID, the HTTP-Redirect address and the signing certificates', () => {
    const metadata = readIdpMetadata(`<?xml version="1.0"?>\n${entity()}`);
    expect(metadata.entityId).toBe('https://idp.example.org/saml');
    expect(metadata.ssoUrl).toBe('https://idp.example.org/sso');
    // The encryption key is left out; the one without `use` signs.
    expect(metadata.certificates).toHaveLength(1);
    expect(metadata.certificates[0]).toMatch(
      /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/,
    );
  });

  it('finds the one identity provider in an EntitiesDescriptor', () => {
    const sp = `<md:EntityDescriptor entityID="https://sp.example.org"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/></md:EntityDescriptor>`;
    const metadata = readIdpMetadata(
      `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${sp}${entity()}</md:EntitiesDescriptor>`,
    );
    expect(metadata.entityId).toBe('https://idp.example.org/saml');
  });

  it.each([
    ['no identity provider', '<root/>'],
    [
      'two identity providers',
      `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${entity()}${entity({ id: 'x' })}</md:EntitiesDescriptor>`,
    ],
    ['no entity ID', entity({ id: '' })],
    [
      'an entity ID over 1024 characters',
      entity({ id: `https://${'x'.repeat(1020)}` }),
    ],
    ['no HTTP-Redirect address', entity({ sso: '' })],
    [
      'a plain http address',
      entity({
        sso: '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://idp.example.org/sso"/>',
      }),
    ],
    ['no signing certificate', entity({ keys: '' })],
    [
      'a certificate that is none',
      entity({
        keys: '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>bm90IGEgY2VydA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>',
      }),
    ],
  ])('refuses metadata with %s', (_what, xml) => {
    expect(() => readIdpMetadata(xml)).toThrow(SamlMetadataError);
  });

  it('never reads a DTD', () => {
    expect(() =>
      readIdpMetadata(
        `<!DOCTYPE md [<!ENTITY x SYSTEM "file:///etc/passwd">]>${entity()}`,
      ),
    ).toThrow(/DOCTYPE|document type/i);
  });
});
