/**
 * The start of `MeService.me().id` while another tab's sign-in is not confirmed in this one yet
 * (#716): no person's ID, and unique to that wait. Nothing is kept under it for anyone.
 */
export const UNCONFIRMED = '~unconfirmed:';

/** Whether the ID is that placeholder: who acts is not known yet. */
export const isUnconfirmed = (id: string): boolean =>
  id.startsWith(UNCONFIRMED);
