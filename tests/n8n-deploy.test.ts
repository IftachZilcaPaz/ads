import { describe, expect, it } from 'vitest';
import { createClient, deployWorkflows, restoreWorkflow, toPayload } from '../n8n/src/deploy.mjs';
import { localValues, localize } from '../n8n/src/local.mjs';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';

type Wf = Record<string, any>;

/** Minimal in-memory n8n public API. */
function fakeN8n(existingIds: string[], { failActivate = [] as string[] } = {}) {
  const store = new Map<string, Wf>(existingIds.map((id) => [id, { id, name: `old ${id}`, active: true, nodes: [], connections: {}, settings: {} }]));
  const calls: string[] = [];
  let seq = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://n8n.example/api/v1', '');
    const method = init.method!;
    calls.push(`${method} ${path}`);
    const headers = init.headers as Record<string, string>;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers['X-N8N-API-KEY'] !== 'key') return reply(401, { message: 'unauthorized' });

    const id = /^\/workflows\/([^/]+)/.exec(path)?.[1];
    if (method === 'GET' && id) return store.has(id) ? reply(200, store.get(id)) : reply(404, { message: 'Not Found' });
    if (method === 'PUT' && id) {
      const body = JSON.parse(String(init.body));
      const extra = Object.keys(body).filter((k) => !['name', 'nodes', 'connections', 'settings', 'staticData'].includes(k));
      if (extra.length) return reply(400, { message: `request/body must NOT have additional properties: ${extra}` });
      store.set(id, { ...store.get(id), ...body });
      return reply(200, store.get(id));
    }
    if (method === 'POST' && path === '/workflows') {
      const created = { ...JSON.parse(String(init.body)), id: `new${++seq}` };
      store.set(created.id, created);
      return reply(200, created);
    }
    if (method === 'POST' && path.endsWith('/activate')) {
      if (failActivate.includes(id!)) return reply(400, { message: 'Node "Load Config" has issues' });
      store.get(id!)!.active = true;
      return reply(200, store.get(id!));
    }
    return reply(404, { message: 'route' });
  }) as typeof fetch;
  return { store, calls, api: createClient({ baseUrl: 'https://n8n.example/', apiKey: 'key', fetchImpl }) };
}

const { values } = localValues({ N8N_POSTGRES_CREDENTIAL_ID: 'PGCRED123', TELEGRAM_CHAT_ID: '999' });
const workflows = Object.fromEntries(Object.entries(WORKFLOWS).map(([k, wf]) => [k, localize(wf, values)]));
const ids = Object.values(WORKFLOWS).map((w) => w.id);

describe('n8n deploy', () => {
  it('injects private ids without leaving placeholders', () => {
    const text = JSON.stringify(workflows);
    expect(text).not.toMatch(/__PG_CREDENTIAL_ID__|__TELEGRAM_CHAT_ID__/);
    expect(text).toContain('PGCRED123');
  });

  it('sends only the properties the public API accepts', () => {
    const payload = toPayload(WORKFLOWS['bp1-publisher']!);
    expect(Object.keys(payload).sort()).toEqual(['connections', 'name', 'nodes', 'settings']);
    expect(payload.settings).toEqual({ executionOrder: 'v1', timezone: 'Asia/Jerusalem', errorWorkflow: 'cPELz1Hlnup9oEir' });
  });

  it('updates existing workflows in place, backs them up, and activates in order', async () => {
    const n8n = fakeN8n(ids);
    const backups: string[] = [];
    const results = await deployWorkflows({ workflows, api: n8n.api, backup: (key) => backups.push(key) });

    expect(results.map((r) => r.key)).toEqual(['bp5-error-alert', 'bp4-token-refresh', 'bp3-watchdog', 'bp1-publisher', 'bp2-telegram-hub']);
    expect(results.every((r) => r.action === 'updated')).toBe(true);
    expect(backups).toHaveLength(5);
    expect(n8n.calls.filter((c) => c.startsWith('POST /workflows/') && c.endsWith('/activate'))).toHaveLength(4); // not BP5
    expect(n8n.store.get('EMES0elQDjPxhY6Z')!.nodes.length).toBe(WORKFLOWS['bp1-publisher']!.nodes.length);
    expect(JSON.stringify(n8n.store.get('RbzKFcz4zIHRiJJl'))).toContain('PGCRED123');
  });

  it('creates missing workflows and re-links them to the new error workflow', async () => {
    const n8n = fakeN8n([]);
    const results = await deployWorkflows({ workflows, api: n8n.api, activate: false });
    const errorId = results.find((r) => r.key === 'bp5-error-alert')!.id;
    expect(errorId).toBe('new1');
    const publisherId = results.find((r) => r.key === 'bp1-publisher')!.id;
    expect(n8n.store.get(publisherId)!.settings.errorWorkflow).toBe('new1');
  });

  it('reports activation problems without aborting the rest', async () => {
    const n8n = fakeN8n(ids, { failActivate: ['sE2eyZ6EJD3PjYwY'] });
    const results = await deployWorkflows({ workflows, api: n8n.api });
    expect(results.find((r) => r.key === 'bp3-watchdog')!.activationError).toMatch(/Load Config/);
    expect(results.find((r) => r.key === 'bp2-telegram-hub')!.active).toBe(true);
  });

  it('supports dry runs, --only, and clear auth errors', async () => {
    const n8n = fakeN8n(ids);
    await deployWorkflows({ workflows, api: n8n.api, dryRun: true });
    expect(n8n.calls.every((c) => c.startsWith('GET'))).toBe(true);

    const only = await deployWorkflows({ workflows, api: fakeN8n(ids).api, only: ['bp3-watchdog'] });
    expect(only.map((r) => r.key)).toEqual(['bp3-watchdog']);
    await expect(deployWorkflows({ workflows, api: n8n.api, only: ['nope'] })).rejects.toThrow(/Unknown workflow/);

    const badKey = createClient({ baseUrl: 'https://n8n.example', apiKey: 'wrong', fetchImpl: (async () => new Response('{"message":"unauthorized"}', { status: 401 })) as unknown as typeof fetch });
    await expect(deployWorkflows({ workflows, api: badKey })).rejects.toThrow(/401.*N8N_API_KEY/);
  });

  it('restores a backup', async () => {
    const n8n = fakeN8n(ids);
    const backup = { id: 'EMES0elQDjPxhY6Z', name: 'BP 1 - Publisher', active: true, nodes: [{ name: 'old' }], connections: {}, settings: { timezone: 'UTC', binaryMode: 'separate' } };
    await restoreWorkflow({ api: n8n.api, backupJson: backup });
    expect(n8n.store.get('EMES0elQDjPxhY6Z')!.nodes).toEqual([{ name: 'old' }]);
    expect(n8n.store.get('EMES0elQDjPxhY6Z')!.settings).toEqual({ timezone: 'UTC' });
  });
});
