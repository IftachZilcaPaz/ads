// Shared by build and deploy: reads .env and injects private values that must
// never be committed (the repo is public) into the rendered workflows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_CHAT, PG_CREDENTIAL } from './nodes.mjs';
import { PUBLISH_TRIGGER } from './workflows.mjs';

export function loadEnv(root) {
  const file = join(root, '.env');
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split('\n')
          .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
          .filter(Boolean)
          .map(([, k, v]) => [k, v.replace(/^['"]|['"]$/g, '')]),
      )
    : {};
  return { ...fromFile, ...process.env };
}

/** Placeholder → value, or throws listing what is missing. */
export function localValues(env) {
  const values = { [PG_CREDENTIAL]: env.N8N_POSTGRES_CREDENTIAL_ID, [OWNER_CHAT]: env.TELEGRAM_CHAT_ID };
  const missing = ['N8N_POSTGRES_CREDENTIAL_ID', 'TELEGRAM_CHAT_ID'].filter((k) => !env[k]);
  return { values, missing };
}

export function localize(workflow, values) {
  let json = JSON.stringify(workflow);
  for (const [k, v] of Object.entries(values)) json = json.replaceAll(k, JSON.stringify(String(v)).slice(1, -1));
  return JSON.parse(json);
}

/**
 * N8N_PUBLISH_EVERY_MINUTES (1-59) overrides the Publisher's 15-minute cadence,
 * e.g. 2 while testing. Unset it and deploy again to go back to 15.
 */
export function withPublishInterval(workflows, raw) {
  if (raw === undefined || raw === '') return workflows;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
    throw new Error(`N8N_PUBLISH_EVERY_MINUTES must be a whole number 1-59, got "${raw}"`);
  }
  const publisher = structuredClone(workflows['bp1-publisher']);
  publisher.nodes.find((n) => n.name === PUBLISH_TRIGGER).parameters.rule.interval[0].minutesInterval = minutes;
  return { ...workflows, 'bp1-publisher': publisher };
}
