/**
 * What went wrong, as the shared states understand it. It mirrors the kinds of the editor's
 * `ApiError` on purpose, so the editor passes `error.kind` and `error.message` straight in,
 * while this library never imports the editor.
 */
export type StateErrorKind =
  | 'unauthorized'
  | 'not-found'
  | 'invalid'
  | 'unavailable'
  | 'network'
  | 'unknown';

/** Whether trying again can help: not for a missing thing or a bad request. */
export function isRetryable(kind: StateErrorKind): boolean {
  return kind === 'unavailable' || kind === 'network' || kind === 'unknown';
}

/** The title of each kind, as translation keys. */
export const errorTitles: Record<StateErrorKind, string> = {
  unauthorized: 'ui.states.error.unauthorized',
  'not-found': 'ui.states.error.notFound',
  invalid: 'ui.states.error.invalid',
  unavailable: 'ui.states.error.unavailable',
  network: 'ui.states.error.network',
  unknown: 'ui.states.error.unknown',
};
