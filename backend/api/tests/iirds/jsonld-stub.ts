/**
 * Stands in for `jsonld`, which the official validator's container rules
 * import for rule C16.2 only: whether an iiRDS/H package's
 * `META-INF/metadata.jsonld` parses. The packages made here are
 * unrestricted iiRDS without JSON-LD metadata, so that rule never applies
 * (it is scoped to iiRDS/H); reaching this is an error.
 */
export function toRDF(): never {
  throw new Error('jsonld is not available in these tests');
}
