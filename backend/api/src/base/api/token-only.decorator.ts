import { SetMetadata } from '@nestjs/common';

export const TOKEN_ONLY = 'openfolia:token-only';

/**
 * Marks a route as authenticated by a bearer token alone (#377: the SCIM routes a directory
 * calls): a session cookie sent with it is never read, so a signed-in browser can never act
 * there, and with no ambient credential left a cross-site request can do nothing either: the
 * cross-site guard lets such routes take any body type, as SCIM clients send them.
 */
export const TokenOnly = () => SetMetadata(TOKEN_ONLY, true);
