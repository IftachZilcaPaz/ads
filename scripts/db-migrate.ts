/**
 * Creates/updates the database schema.   npm run db:migrate
 * Safe to run any time: already-applied migrations are skipped.
 */
import { migrate } from '../src/server/db/migrate.ts';
import { loadMigrations } from '../src/server/db/migrations-fs.ts';
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { fail, need, root } from './cli-env.ts';
import { join } from 'node:path';

const { DATABASE_URL } = need('DATABASE_URL');
const db = createPostgresDb(DATABASE_URL);
try {
  const applied = await migrate(db, loadMigrations(join(root, 'db', 'migrations')));
  console.log(applied.length ? `✅ applied: ${applied.join(', ')}` : '✅ schema is up to date');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.close();
}
