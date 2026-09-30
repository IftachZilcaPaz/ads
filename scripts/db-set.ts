/**
 * Reads or writes a row in the `settings` table.
 *   npm run db:set                          list keys (secret values are masked)
 *   npm run db:set -- app_url https://...   set a value
 */
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { fail, need } from './cli-env.ts';

const SECRET = /token|secret|password|key$/i;
const [key, ...rest] = process.argv.slice(2);
const { DATABASE_URL } = need('DATABASE_URL');
const db = createPostgresDb(DATABASE_URL);

try {
  if (!key) {
    const rows = await db.query<{ key: string; value: string }>('select key, value from settings order by key');
    for (const r of rows) console.log(`${r.key} = ${SECRET.test(r.key) && r.value ? `${r.value.slice(0, 4)}…` : r.value}`);
  } else {
    if (!rest.length) fail('Usage: npm run db:set -- <key> <value>');
    await db.query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [
      key,
      rest.join(' '),
    ]);
    console.log(`✅ ${key} saved`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.close();
}
