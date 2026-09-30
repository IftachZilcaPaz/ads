import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration } from './migrate.ts';

/** Reads db/migrations/*.sql (Node only: scripts, dev server, tests). */
export function loadMigrations(dir = join(process.cwd(), 'db', 'migrations')): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}
