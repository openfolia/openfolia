import { SetMetadata, type Type } from '@nestjs/common';

export const OPTIONAL_ACTOR = 'openfolia:optional-actor';

/**
 * Says whether an `@OptionalActor()` route answers everyone alike right now (#608): a provider,
 * found by its class wherever it is registered.
 */
export interface AnswersEveryone {
  answersEveryone(): Promise<boolean>;
}

/**
 * Marks a route a request may reach without any credentials (#450, the stable addresses): a
 * request with no `Authorization` and no `X-Ccms-User` header gets through `ActorGuard` without
 * an actor (`request.actor` undefined), and the route decides what such a reader may see
 * (public content, or 401). A request with either header is authenticated as on every other
 * route, its failures counted and refused alike. Unlike `@Public()`, the route stays documented
 * as one that needs the token.
 *
 * With `everyone` (#608), whenever its `answersEveryone()` says so (a `public` stable address),
 * the request is not authenticated at all: a session, a token and `X-Ccms-User` are ignored,
 * nothing is counted or refused, there is no actor, and the answer varies by none of them.
 */
export const OptionalActor = (everyone?: Type<AnswersEveryone>) =>
  SetMetadata(OPTIONAL_ACTOR, everyone ?? true);
