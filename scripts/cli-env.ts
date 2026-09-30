/** Shared by the CLI scripts: loads .env and fails with a readable message. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../n8n/src/local.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const env = loadEnv(root);

export function need<N extends string>(...names: N[]): { [K in N]: string } {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) fail(`Missing ${missing.join(', ')} in .env (see .env.example)`);
  return Object.fromEntries(names.map((n) => [n, env[n]!])) as { [K in N]: string };
}

export function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/**
 * DATABASE_URL for CLI use, with the checks that catch the usual mistakes:
 * a shell variable shadowing .env, duplicate lines, or Railway's internal host.
 */
export function databaseUrl(): string {
  const { DATABASE_URL } = need('DATABASE_URL');
  const file = join(root, '.env');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*DATABASE_URL\s*=/.test(l)) : [];
  const source = process.env.DATABASE_URL ? 'the terminal (overrides .env - run: unset DATABASE_URL)' : '.env';

  let target: URL;
  try {
    target = new URL(DATABASE_URL);
  } catch {
    fail(`DATABASE_URL is not a valid postgresql:// URL (from ${source})`);
  }
  console.log(`→ database ${target.hostname}:${target.port || 5432}${target.pathname} (from ${source})`);
  if (lines.length > 1) console.warn(`⚠️ DATABASE_URL appears ${lines.length} times in .env - the last one wins`);
  if (target.hostname.endsWith('.railway.internal')) {
    fail(
      "This is Railway's internal address, reachable only inside Railway. " +
        'Use the value of DATABASE_PUBLIC_URL (host ends with .proxy.rlwy.net) and add ?sslmode=require',
    );
  }
  return DATABASE_URL;
}
