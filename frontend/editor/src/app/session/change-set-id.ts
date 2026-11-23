/**
 * A change set's ID as the API makes and accepts them (a UUID version 7, lowercase): what
 * `?cs=` may hold. Anything else in the address (a crafted `..`, say) chooses no change set.
 */
const CHANGE_SET_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isChangeSetId = (
  value: string | null | undefined,
): value is string => typeof value === 'string' && CHANGE_SET_ID.test(value);
