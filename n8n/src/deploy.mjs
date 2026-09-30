// Pushes the workflows to an n8n instance through its public REST API
// (available without Enterprise). Updating in place keeps each workflow's id,
// so the Telegram webhook and the error-workflow link stay intact.
import { ERROR_WORKFLOW_ID } from './nodes.mjs';

/** Error workflow first (others link to it), the always-on pieces last. */
export const DEPLOY_ORDER = ['bp5-error-alert', 'bp4-token-refresh', 'bp3-watchdog', 'bp1-publisher', 'bp2-telegram-hub'];

/** Only an Error Trigger: runs when referenced, cannot/need not be activated. */
const NOT_ACTIVATABLE = new Set(['bp5-error-alert']);

// The public API rejects unknown properties, so send only what it accepts.
const SETTINGS_KEYS = [
  'executionOrder',
  'timezone',
  'errorWorkflow',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'saveManualExecutions',
  'saveExecutionProgress',
  'executionTimeout',
  'callerPolicy',
];

export class N8nApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'N8nApiError';
    this.status = status;
  }
}

export function toPayload(workflow, errorWorkflowId = ERROR_WORKFLOW_ID) {
  const settings = Object.fromEntries(SETTINGS_KEYS.filter((k) => k in (workflow.settings ?? {})).map((k) => [k, workflow.settings[k]]));
  if (settings.errorWorkflow) settings.errorWorkflow = errorWorkflowId;
  return { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings };
}

export function createClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/v1`;
  return async function api(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          'X-N8N-API-KEY': apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new N8nApiError(`Cannot reach ${root}: ${err.message}`, 0);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check N8N_API_KEY)' : '';
      throw new N8nApiError(`${method} ${path} → ${res.status}: ${data.message ?? text.slice(0, 200)}${hint}`, res.status);
    }
    return data;
  };
}

/**
 * @param {object} opts
 * @param {Record<string, object>} opts.workflows  localized workflows keyed by file name
 * @param {(method: string, path: string, body?: object) => Promise<any>} opts.api
 * @param {string[]} [opts.only]
 * @param {boolean} [opts.activate]
 * @param {boolean} [opts.dryRun]
 * @param {(key: string, existing: object) => void} [opts.backup]
 * @param {(msg: string) => void} [opts.log]
 */
export async function deployWorkflows({ workflows, api, only, activate = true, dryRun = false, backup = () => {}, log = () => {} }) {
  const keys = DEPLOY_ORDER.filter((k) => workflows[k] && (!only?.length || only.includes(k)));
  const unknown = (only ?? []).filter((k) => !workflows[k]);
  if (unknown.length) throw new Error(`Unknown workflow(s): ${unknown.join(', ')}. Known: ${DEPLOY_ORDER.join(', ')}`);

  let errorWorkflowId = ERROR_WORKFLOW_ID;
  const results = [];

  for (const key of keys) {
    const wf = workflows[key];
    let existing = null;
    try {
      existing = await api('GET', `/workflows/${wf.id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    if (dryRun) {
      log(`[dry-run] ${wf.name}: would ${existing ? 'update' : 'create'} (${wf.nodes.length} nodes)`);
      results.push({ key, id: wf.id, action: existing ? 'update' : 'create', dryRun: true });
      continue;
    }

    const payload = toPayload(wf, errorWorkflowId);
    let id = wf.id;
    if (existing) {
      backup(key, existing);
      await api('PUT', `/workflows/${id}`, payload);
    } else {
      id = (await api('POST', '/workflows', payload)).id;
    }
    if (key === 'bp5-error-alert') errorWorkflowId = id;

    const result = { key, id, action: existing ? 'updated' : 'created', active: false };
    if (activate && !NOT_ACTIVATABLE.has(key)) {
      try {
        await api('POST', `/workflows/${id}/activate`);
        result.active = true;
      } catch (err) {
        result.activationError = err.message;
      }
    }
    log(
      `${result.activationError ? '⚠️' : '✅'} ${wf.name}: ${result.action}${result.active ? ', active' : ''}${
        result.activationError ? ` - not activated: ${result.activationError}` : ''
      }`,
    );
    results.push(result);
  }
  return results;
}

/** Puts a backup (as saved by deployWorkflows) back in place. */
export async function restoreWorkflow({ api, backupJson }) {
  await api('PUT', `/workflows/${backupJson.id}`, toPayload(backupJson, backupJson.settings?.errorWorkflow));
  if (backupJson.active) await api('POST', `/workflows/${backupJson.id}/activate`);
  return backupJson.id;
}
