import type { Db } from '../../src/server/db/db.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { loadMigrations } from '../../src/server/db/migrations-fs.ts';
import { createMemoryDb } from '../../src/server/db/pglite.ts';
import { createPostgresDb } from '../../src/server/db/postgres.ts';

export { insertRows } from '../../src/server/dev-backend.ts';

/**
 * A migrated database; `reset()` empties every table between tests.
 * In-process PGlite by default. Set TEST_DATABASE_URL to run the same tests
 * against a real server through the production driver:
 *   TEST_DATABASE_URL=postgresql://... npx vitest run --no-file-parallelism
 */
export async function testDb(): Promise<{ db: Db; reset: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? createPostgresDb(url) : await createMemoryDb();
  await migrate(db, loadMigrations());
  return {
    db,
    reset: () => db.exec('truncate posts, campaigns, products, brand, settings'),
  };
}
