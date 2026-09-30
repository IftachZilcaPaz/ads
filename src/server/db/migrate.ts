import type { Db } from './db.ts';

export interface Migration {
  version: string;
  sql: string;
}

/** Applies pending migrations in order, each in its own transaction. Idempotent. */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ version: string }>('select version from schema_migrations')).map((r) => r.version));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.version.localeCompare(b.version))) {
    if (done.has(m.version)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('insert into schema_migrations (version) values ($1)', [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}
