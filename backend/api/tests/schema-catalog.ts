import type { PGlite } from '@electric-sql/pglite';

/**
 * What a database's `public` schema holds, as sorted lines that compare the
 * same however it was made: the tables and their row counts, the columns
 * (not their order: a column a later migration adds comes last), constraints,
 * indexes, triggers, functions (not the extensions') with their grants, and the extensions.
 */
export async function schemaCatalog(client: PGlite): Promise<string[]> {
  const lines: string[] = [];
  const add = async (kind: string, query: string) => {
    const result = await client.query<{ line: string }>(query);
    for (const row of result.rows) lines.push(`${kind} ${row.line}`);
  };
  await add(
    'column',
    `select table_name || '.' || column_name || ' ' || format_type(a.atttypid, a.atttypmod)
       || case when c.is_nullable = 'NO' then ' not null' else '' end
       || coalesce(' default ' || c.column_default, '')
       || case when c.is_identity = 'YES' then ' identity ' || c.identity_generation else '' end
       || coalesce(' generated ' || c.generation_expression, '') as line
     from information_schema.columns c
     join pg_attribute a on a.attrelid = ('public.' || quote_ident(c.table_name))::regclass
       and a.attname = c.column_name
     where c.table_schema = 'public'`,
  );
  await add(
    'constraint',
    `select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) as line
     from pg_constraint where connamespace = 'public'::regnamespace`,
  );
  await add(
    'index',
    `select indexdef as line from pg_indexes where schemaname = 'public'`,
  );
  await add(
    'trigger',
    `select pg_get_triggerdef(t.oid) as line from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relnamespace = 'public'::regnamespace`,
  );
  await add(
    'function',
    `select pg_get_functiondef(p.oid) || ' grants ' || coalesce(p.proacl::text, 'default') as line
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
  );
  await add('extension', `select extname as line from pg_extension`);
  const tables = await client.query<{ name: string }>(
    `select tablename as name from pg_tables where schemaname = 'public'`,
  );
  for (const { name } of tables.rows) {
    const count = await client.query<{ n: number }>(
      `select count(*)::int as n from "public"."${name.replaceAll('"', '""')}"`,
    );
    lines.push(`table ${name} rows ${count.rows[0]?.n}`);
  }
  return lines.sort();
}
