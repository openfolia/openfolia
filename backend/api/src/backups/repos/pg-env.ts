/**
 * The libpq environment (`PGHOST`, `PGPASSWORD`, …) for a database URL, so
 * `pg_dump` and `pg_restore` connect without the password on their command
 * line, where any process of the container could read it.
 */
export function pgEnvOf(
  url: string,
  database?: string,
): Record<string, string> {
  const parsed = new URL(url);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGDATABASE:
      database ?? decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    // No ~/.pgpass, no service file: only what the URL says.
    PGPASSFILE: '/dev/null',
    PGSERVICEFILE: '/dev/null',
  };
  if (parsed.username) env['PGUSER'] = decodeURIComponent(parsed.username);
  if (parsed.password) env['PGPASSWORD'] = decodeURIComponent(parsed.password);
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env['PGSSLMODE'] = sslmode;
  return env;
}

/** The database a URL names. */
export const databaseOf = (url: string): string =>
  decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

/** `url` naming `database` instead. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/** A Postgres identifier, quoted. */
export const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;
