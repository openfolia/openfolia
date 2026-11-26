/**
 * An error for a log line: its name and its message's first line, nothing more. A failed
 * query's message ends with its parameters (addresses, texts), so neither the whole message nor
 * the error itself is logged where those may be personal.
 */
export function errorLine(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message.split('\n', 1)[0]}`
    : 'unknown error';
}
