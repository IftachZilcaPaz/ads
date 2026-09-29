#!/usr/bin/env node
/**
 * Renders n8n/src/workflows.mjs into importable JSON.
 *
 *   n8n/workflows/*.json  committed; contains __SPREADSHEET_ID__ / __TELEGRAM_CHAT_ID__ placeholders
 *   n8n/dist/*.json       git-ignored; placeholders replaced from env or .env — import these
 *
 * `--check` fails if the committed JSON is stale (used by tests/CI).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const committedDir = join(root, 'n8n', 'workflows');
const distDir = join(root, 'n8n', 'dist');
const check = process.argv.includes('--check');

function loadDotEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^['"]|['"]$/g, '')]),
  );
}

const render = (wf) => `${JSON.stringify(wf, null, 2)}\n`;
let stale = [];

mkdirSync(committedDir, { recursive: true });
for (const [file, wf] of Object.entries(WORKFLOWS)) {
  const path = join(committedDir, `${file}.json`);
  const json = render(wf);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== json) stale.push(file);
  } else {
    writeFileSync(path, json);
  }
}

if (check) {
  if (stale.length) {
    console.error(`Stale n8n JSON (run npm run n8n:build): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log('n8n workflows are up to date');
  process.exit(0);
}

const env = { ...loadDotEnv(), ...process.env };
const values = { __SPREADSHEET_ID__: env.SPREADSHEET_ID, __TELEGRAM_CHAT_ID__: env.TELEGRAM_CHAT_ID };
const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k.replace(/__/g, ''));

if (missing.length) {
  console.log(`Wrote n8n/workflows/. Set ${missing.join(' and ')} (env or .env) to also produce ready-to-import n8n/dist/.`);
} else {
  mkdirSync(distDir, { recursive: true });
  for (const [file, wf] of Object.entries(WORKFLOWS)) {
    let json = render(wf);
    for (const [k, v] of Object.entries(values)) json = json.replaceAll(k, JSON.stringify(v).slice(1, -1));
    writeFileSync(join(distDir, `${file}.json`), json);
  }
  console.log('Wrote n8n/workflows/ and ready-to-import n8n/dist/');
}
