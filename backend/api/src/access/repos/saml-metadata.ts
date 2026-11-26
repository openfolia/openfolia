import { X509Certificate } from 'node:crypto';
import { readXml, type XmlElement } from '@openfolia/xml';
import { isLoopbackHost } from '../../config/sign-in-env.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** The most an identity provider's metadata may be, in characters (an aggregate is refused). */
export const MAX_METADATA_LENGTH = 2 * 1024 * 1024;

/** What sign-in needs of an identity provider's metadata (#376). */
export interface IdpMetadata {
  /** Its entity ID: the `Issuer` its assertions must name. */
  readonly entityId: string;
  /** Where the browser is sent with a sign-in request (HTTP-Redirect binding). */
  readonly ssoUrl: string;
  /** The certificates its signatures are checked with (PEM), at least one. */
  readonly certificates: readonly string[];
}

/** The metadata could not be used; the message says why, for the log. */
export class SamlMetadataError extends Error {
  override readonly name = 'SamlMetadataError';
}

const elements = (parent: XmlElement, ns: string, local: string) =>
  parent.children.filter(
    (child): child is XmlElement =>
      typeof child !== 'string' && child.ns === ns && child.local === local,
  );

const textOf = (element: XmlElement): string =>
  element.children.filter((child) => typeof child === 'string').join('');

/**
 * Reads an identity provider's SAML 2.0 metadata (#376): one `EntityDescriptor` (or an
 * `EntitiesDescriptor` holding exactly one identity provider) with an `IDPSSODescriptor` for
 * SAML 2.0, its HTTP-Redirect sign-in address and its signing certificates. Read with the
 * strict reader (`readXml`: no DTD, bounded), so nothing in it is fetched or expanded. Its own
 * signature, if any, is not checked: the metadata is trusted as the operator named it (an
 * `https://` address or a file).
 */
export function readIdpMetadata(text: string): IdpMetadata {
  const root = readXml(text, {
    maxLength: MAX_METADATA_LENGTH,
    maxDepth: 32,
    maxNodes: 200_000,
    maxAttributes: 64,
  });
  const candidates =
    root.ns === MD && root.local === 'EntityDescriptor'
      ? [root]
      : root.ns === MD && root.local === 'EntitiesDescriptor'
        ? elements(root, MD, 'EntityDescriptor')
        : [];
  const idps = candidates.flatMap((entity) =>
    elements(entity, MD, 'IDPSSODescriptor')
      .filter((sso) =>
        (sso.attributes.get('protocolSupportEnumeration') ?? '')
          .split(/\s+/)
          .includes(PROTOCOL),
      )
      .map((sso) => ({ entity, sso })),
  );
  if (idps.length !== 1) {
    throw new SamlMetadataError(
      idps.length === 0
        ? 'The metadata describes no SAML 2.0 identity provider (IDPSSODescriptor).'
        : 'The metadata describes more than one SAML 2.0 identity provider.',
    );
  }
  const { entity, sso } = idps[0]!;
  const entityId = entity.attributes.get('entityID')?.trim();
  if (!entityId) {
    throw new SamlMetadataError('The metadata names no entityID.');
  }
  // SAML's own limit (metadata §2.3.2), which keeps the identity's issuer within its column.
  if (entityId.length > 1024) {
    throw new SamlMetadataError('The entityID is longer than 1024 characters.');
  }
  const ssoUrl = elements(sso, MD, 'SingleSignOnService')
    .find((service) => service.attributes.get('Binding') === REDIRECT_BINDING)
    ?.attributes.get('Location')
    ?.trim();
  if (!ssoUrl || !secureAddress(ssoUrl)) {
    throw new SamlMetadataError(
      'The metadata names no https:// SingleSignOnService for the HTTP-Redirect binding.',
    );
  }
  const certificates = elements(sso, MD, 'KeyDescriptor')
    .filter((key) => (key.attributes.get('use') ?? 'signing') === 'signing')
    .flatMap((key) => elements(key, DS, 'KeyInfo'))
    .flatMap((info) => elements(info, DS, 'X509Data'))
    .flatMap((data) => elements(data, DS, 'X509Certificate'))
    .map((cert) => pemOf(textOf(cert)));
  if (certificates.length === 0) {
    throw new SamlMetadataError(
      'The metadata names no signing certificate (KeyDescriptor, X509Certificate).',
    );
  }
  return { entityId, ssoUrl, certificates: [...new Set(certificates)] };
}

/** An `https://` address, or `http://` on a loopback host (a local test provider). */
function secureAddress(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  );
}

/** A certificate from metadata (base64 DER, any whitespace) as PEM, once it parses. */
function pemOf(base64: string): string {
  const body = base64.replace(/\s+/g, '');
  try {
    const der = Buffer.from(body, 'base64');
    if (der.toString('base64') !== body) throw new Error('not base64');
    new X509Certificate(der);
  } catch {
    throw new SamlMetadataError(
      'A signing certificate in the metadata is not an X.509 certificate.',
    );
  }
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}
