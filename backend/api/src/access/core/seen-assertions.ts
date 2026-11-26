/**
 * Port: the SAML assertions already accepted (#376), so one is never accepted twice (SAML
 * profiles §4.1.4.5). Shared by every server: a copy of an assertion posted to another server
 * is refused there too.
 */
export abstract class SeenAssertions {
  /**
   * Records `key` (an identity provider's assertion, by its issuer and ID) until `until`, in one
   * step: true when it was not recorded yet (or its time had passed), false when it was. Rejects
   * when the record cannot be read or written: never taken as either answer.
   */
  abstract recordOnce(key: string, until: Date): Promise<boolean>;
}
