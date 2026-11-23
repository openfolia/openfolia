import type { components, paths } from './schema';

/** Schemas of the API's OpenAPI document, by name: `Schema<'ModuleResource'>`. */
export type Schema<N extends keyof components['schemas']> =
  components['schemas'][N];

type JsonTypes = 'application/vnd.api+json' | 'application/json';

type JsonOf<C> =
  C extends Record<string, unknown> ? C[Extract<keyof C, JsonTypes>] : never;

type GetOf<P extends keyof paths> = paths[P] extends { get: infer G }
  ? G
  : never;

/** Routes with a `GET` that answers JSON (binary routes such as the PDF are left out). */
export type JsonGetPath = {
  [P in keyof paths]: GetOf<P> extends {
    responses: { 200: { content: infer C } };
  }
    ? [JsonOf<C>] extends [never]
      ? never
      : P
    : never;
}[keyof paths];

/** The success document of a route. */
export type Response<P extends JsonGetPath> =
  GetOf<P> extends {
    responses: { 200: { content: infer C } };
  }
    ? JsonOf<C>
    : never;

/** Query parameters of a route as the document names them (`page[number]`, `ref`, …). */
export type Query<P extends JsonGetPath> =
  GetOf<P> extends {
    parameters: { query?: infer Q };
  }
    ? NonNullable<Q>
    : never;

/** Path parameters of a route. */
export type PathParams<P extends JsonGetPath> =
  GetOf<P> extends {
    parameters: { path: infer Q };
  }
    ? Q
    : never;

/** One resource of a paged document, e.g. `Item<'/modules'>`. */
export type Item<P extends JsonGetPath> =
  Response<P> extends { data: (infer D)[] } ? D : never;

type PostOf<P extends keyof paths> = paths[P] extends { post: infer G }
  ? G
  : never;

/** Routes with a `POST` that takes a JSON body and answers `201` with JSON. */
export type JsonPostPath = {
  [P in keyof paths]: PostOf<P> extends {
    requestBody: { content: infer B };
    responses: { 201: { content: infer C } };
  }
    ? [JsonOf<B>] extends [never]
      ? never
      : [JsonOf<C>] extends [never]
        ? never
        : P
    : never;
}[keyof paths];

/** The request document of a `POST` route. */
export type PostBody<P extends JsonPostPath> =
  PostOf<P> extends { requestBody: { content: infer B } } ? JsonOf<B> : never;

/** The `201` document of a `POST` route. */
export type PostResponse<P extends JsonPostPath> =
  PostOf<P> extends { responses: { 201: { content: infer C } } }
    ? JsonOf<C>
    : never;

/** Path parameters of a `POST` route (never for one without). */
export type PostPathParams<P extends JsonPostPath> =
  PostOf<P> extends { parameters: { path: infer Q } } ? Q : never;

/**
 * The JSON an action answers: its `200` document, else its `202` one (queued), else `null` for
 * one that answers `204` with a JSON body sent (breaking a lock).
 */
type ActionContent<G> = G extends { responses: { 200: { content: infer C } } }
  ? JsonOf<C>
  : G extends { responses: { 202: { content: infer C } } }
    ? JsonOf<C>
    : G extends {
          requestBody: { content: infer B };
          responses: { 204: unknown };
        }
      ? [JsonOf<B>] extends [never]
        ? never
        : null
      : never;

/**
 * Routes with a `POST` that answers `200` (or `202`, queued) with JSON, or `204` to a JSON body:
 * an action on a resource (a workflow transition, deactivating a user, retrying a release's file,
 * breaking a lock), with or without a JSON body.
 */
export type JsonActionPath = {
  [P in keyof paths]: [ActionContent<PostOf<P>>] extends [never] ? never : P;
}[keyof paths];

/** The request document of an action route (`never` for one that takes none). */
export type ActionBody<P extends JsonActionPath> =
  PostOf<P> extends { requestBody?: { content: infer B } } ? JsonOf<B> : never;

/** The `200` (or `202`) document of an action route. */
export type ActionResponse<P extends JsonActionPath> = ActionContent<PostOf<P>>;

/** Path parameters of an action route. */
export type ActionPathParams<P extends JsonActionPath> =
  PostOf<P> extends { parameters: { path: infer Q } } ? Q : never;

type PutOf<P extends keyof paths> = paths[P] extends { put: infer G }
  ? G
  : never;

/** Routes with a `PUT` that takes a JSON body and answers `200` with JSON. */
export type JsonPutPath = {
  [P in keyof paths]: PutOf<P> extends {
    requestBody: { content: infer B };
    responses: { 200: { content: infer C } };
  }
    ? [JsonOf<B>] extends [never]
      ? never
      : [JsonOf<C>] extends [never]
        ? never
        : P
    : never;
}[keyof paths];

/** The request document of a `PUT` route. */
export type PutBody<P extends JsonPutPath> =
  PutOf<P> extends { requestBody: { content: infer B } } ? JsonOf<B> : never;

/** The `200` document of a `PUT` route. */
export type PutResponse<P extends JsonPutPath> =
  PutOf<P> extends { responses: { 200: { content: infer C } } }
    ? JsonOf<C>
    : never;

/** Path parameters of a `PUT` route. */
export type PutPathParams<P extends JsonPutPath> =
  PutOf<P> extends { parameters: { path: infer Q } } ? Q : never;

/** Query parameters of a `PUT` route (a template file's path, #396). */
export type PutQuery<P extends JsonPutPath> =
  PutOf<P> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

type PatchOf<P extends keyof paths> = paths[P] extends { patch: infer G }
  ? G
  : never;

/** Routes with a `PATCH` that takes a JSON body and answers `200` with JSON. */
export type JsonPatchPath = {
  [P in keyof paths]: PatchOf<P> extends {
    requestBody: { content: infer B };
    responses: { 200: { content: infer C } };
  }
    ? [JsonOf<B>] extends [never]
      ? never
      : [JsonOf<C>] extends [never]
        ? never
        : P
    : never;
}[keyof paths];

/** The request document of a `PATCH` route. */
export type PatchBody<P extends JsonPatchPath> =
  PatchOf<P> extends { requestBody: { content: infer B } } ? JsonOf<B> : never;

/** The `200` document of a `PATCH` route. */
export type PatchResponse<P extends JsonPatchPath> =
  PatchOf<P> extends { responses: { 200: { content: infer C } } }
    ? JsonOf<C>
    : never;

/** Path parameters of a `PATCH` route. */
export type PatchPathParams<P extends JsonPatchPath> =
  PatchOf<P> extends { parameters: { path: infer Q } } ? Q : never;

type DeleteOf<P extends keyof paths> = paths[P] extends { delete: infer G }
  ? G
  : never;

/** Routes with a `DELETE`. */
export type DeletePath = {
  [P in keyof paths]: [DeleteOf<P>] extends [never] ? never : P;
}[keyof paths];

/** Path parameters of a `DELETE` route. */
export type DeletePathParams<P extends DeletePath> =
  DeleteOf<P> extends { parameters: { path: infer Q } } ? Q : never;

/** Query parameters of a `DELETE` route (`ifUnchanged`, …); `never` when it takes none. */
export type DeleteQuery<P extends DeletePath> =
  DeleteOf<P> extends { parameters: { query?: infer Q } }
    ? NonNullable<Q>
    : never;

/** The request document of a `DELETE` route that takes one (`never` otherwise). */
export type DeleteBody<P extends DeletePath> =
  DeleteOf<P> extends { requestBody: { content: infer B } } ? JsonOf<B> : never;

/** Whether a `GET` route takes `ref` (a branch, tag or commit to read at). */
type TakesRef<P extends JsonGetPath> = [Query<P>] extends [never]
  ? never
  : 'ref' extends keyof Query<P>
    ? P
    : never;

/** Every `GET` route that reads content at a `ref`. */
export type RefPath = { [P in JsonGetPath]: TakesRef<P> }[JsonGetPath];
