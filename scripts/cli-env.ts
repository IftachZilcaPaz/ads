/** Shared by the CLI scripts: loads .env and fails with a readable message. */
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
