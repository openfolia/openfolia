/**
 * The server cannot start for a reason the operator fixes in the settings
 * or the environment (an invalid setting, an unreachable database). `main`
 * prints only its message, which says what to change, instead of a stack.
 * The message never contains a secret.
 */
export class StartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StartupError';
  }
}
