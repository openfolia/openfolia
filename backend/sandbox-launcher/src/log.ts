// One JSON line per event on stdout: starts, stops, refusals and errors. Never a request's path,
// body or cookie, and never a visitor's address, not even hashed (the start page's "What this
// demo stores" says so).

export type Fields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface Logger {
  info(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

export function jsonLogger(
  component: string,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const emit = (level: string, event: string, fields: Fields = {}) =>
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        component,
        event,
        ...fields,
      }) + '\n',
    );
  return {
    info: (event, fields) => emit('info', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};
