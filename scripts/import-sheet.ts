/**
 * One-time copy of the Google Sheet into Postgres.
 *   npm run db:import-sheet               keeps rows that already exist in the DB
 *   npm run db:import-sheet -- --overwrite  sheet wins for rows that exist in both
 * Runs the migrations first. Needs DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID.
 */
import { join } from 'node:path';
import { migrate } from '../src/server/db/migrate.ts';
import { loadMigrations } from '../src/server/db/migrations-fs.ts';
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { ServiceAccountTokenProvider, parseServiceAccount } from '../src/server/google-auth.ts';
import { importSheet, type SheetGrids } from '../src/server/sheet-import.ts';
import { SheetsClient, a1 } from '../src/server/sheets.ts';
import { env, fail, need, root } from './cli-env.ts';

const { DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID } = need('DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID');
const TABS = ['calendar', 'campaigns', 'products', 'brand', 'config'] as const;

const sheets = new SheetsClient(SPREADSHEET_ID, new ServiceAccountTokenProvider(parseServiceAccount(GOOGLE_SERVICE_ACCOUNT_JSON)));
const db = createPostgresDb(DATABASE_URL);
try {
  const existing = new Set(await sheets.sheetTitles());
  const present = TABS.filter((t) => existing.has(t));
  const values = await sheets.batchGet(present.map((t) => a1(t)));
  const grids = Object.fromEntries(TABS.map((t) => [t, values[present.indexOf(t)] ?? []])) as SheetGrids;

  await migrate(db, loadMigrations(join(root, 'db', 'migrations')));
  const report = await importSheet(db, grids, { overwrite: process.argv.includes('--overwrite'), apiToken: env.API_TOKEN });

  console.log(`✅ imported: ${report.posts} posts, ${report.campaigns} campaigns, ${report.products} products, ${report.brand} brand keys, ${report.settings} settings`);
  if (report.skipped.length) console.log(`⚠️ skipped:\n  ${report.skipped.join('\n  ')}`);
  console.log('Rows that already existed were kept. Use --overwrite to replace them with the sheet values.');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.close();
}
