#!/usr/bin/env node
/**
 * Deploys the workflows straight into n8n via its public API.
 *
 *   npm run n8n:deploy                      update all 5 workflows and activate them
 *   npm run n8n:deploy -- --dry-run         show what would change, touch nothing
 *   npm run n8n:deploy -- --only bp1-publisher,bp3-watchdog
 *   npm run n8n:deploy -- --no-activate     update but leave activation to you
 *   npm run n8n:deploy -- --restore n8n/backups/<file>.json
 *   N8N_PUBLISH_EVERY_MINUTES=2 npm run n8n:deploy -- --only bp1-publisher   faster cadence for testing
 *
 * Needs in .env (or the environment): N8N_URL, N8N_API_KEY, N8N_POSTGRES_CREDENTIAL_ID,
 * TELEGRAM_CHAT_ID. Every workflow that gets replaced is first saved to
 * n8n/backups/ (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, deployWorkflows, restoreWorkflow } from '../n8n/src/deploy.mjs';
import { loadEnv, localValues, localize, withPublishInterval } from '../n8n/src/local.mjs';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const env = loadEnv(root);
const missingApi = ['N8N_URL', 'N8N_API_KEY'].filter((k) => !env[k]);
if (missingApi.length) {
  fail(`Missing ${missingApi.join(', ')} in .env. Create the key in n8n: Settings → n8n API → Create an API key.`);
}
const api = createClient({ baseUrl: env.N8N_URL, apiKey: env.N8N_API_KEY });

try {
  const restorePath = option('--restore');
  if (restorePath) {
    const id = await restoreWorkflow({ api, backupJson: JSON.parse(readFileSync(restorePath, 'utf8')) });
    console.log(`✅ restored workflow ${id} from ${restorePath}`);
    process.exit(0);
  }

  const { values, missing } = localValues(env);
  if (missing.length) fail(`Missing ${missing.join(', ')} in .env`);
  const workflows = withPublishInterval(
    Object.fromEntries(Object.entries(WORKFLOWS).map(([k, wf]) => [k, localize(wf, values)])),
    env.N8N_PUBLISH_EVERY_MINUTES,
  );
  if (env.N8N_PUBLISH_EVERY_MINUTES) console.log(`Publisher runs every ${env.N8N_PUBLISH_EVERY_MINUTES} min (N8N_PUBLISH_EVERY_MINUTES)`);

  const backupDir = join(root, 'n8n', 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = await deployWorkflows({
    workflows,
    api,
    only: option('--only')?.split(',').map((s) => s.trim()).filter(Boolean),
    activate: !flag('--no-activate'),
    dryRun: flag('--dry-run'),
    backup: (key, existing) => {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, `${key}-${stamp}.json`), `${JSON.stringify(existing, null, 2)}\n`);
    },
    log: (msg) => console.log(msg),
  });

  if (results.some((r) => r.activationError)) {
    console.log('\nSome workflows were updated but not activated - open them in n8n to see which node needs attention.');
    process.exitCode = 2;
  } else if (!flag('--dry-run')) {
    console.log(`\nDone. Backups of the previous versions: n8n/backups/*-${stamp}.json`);
  }
} catch (err) {
  fail(err.message);
}
