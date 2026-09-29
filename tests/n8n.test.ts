import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCode } from '../n8n/src/nodes.mjs';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';

type Json = Record<string, unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Ctx {
  nodes?: Record<string, Json[]>;
  json?: Json;
  executionId?: string;
  http?: (req: { method: string; url: string; qs: Json }) => unknown;
}

/** Executes a code-node source the way n8n does ($, $json, this.helpers...). */
async function run(file: string, ctx: Ctx = {}): Promise<Json[]> {
  const src = loadCode(file);
  const $ = (name: string) => {
    const rows = ctx.nodes?.[name];
    if (!rows) throw new Error(`Node '${name}' not provided`);
    const items = rows.map((json) => ({ json }));
    return { all: () => items, first: () => items[0], item: items[0] };
  };
  const fn = new AsyncFunction('$', '$json', '$execution', src);
  const helpers = {
    httpRequest: async (req: { method: string; url: string; qs: Json }) => ({ statusCode: 200, body: ctx.http!(req) }),
  };
  const out = await fn.call({ helpers }, $, ctx.json, { id: ctx.executionId ?? '42' });
  const list = (Array.isArray(out) ? out : [out]) as { json: Json }[];
  return list.map((i) => i.json);
}

const CONFIG = [
  { key: 'ig_user_id', value: '1789' },
  { key: 'access_token', value: 'TOKEN' },
  { key: 'telegram_chat_id', value: '356' },
  { key: 'app_url', value: 'https://bp.example' },
  { key: 'app_api_token', value: 'api-tok' },
  { key: 'cloudinary_cloud', value: 'demo' },
  { key: 'cloudinary_preset', value: 'pre' },
];
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
const row = (over: Json): Json => ({
  id: 'p1',
  publish_at: '2026-09-29 11:00',
  type: 'POST',
  media_urls: IMG,
  caption: 'hello — world',
  approval_mode: 'approve',
  status: 'ready',
  approved_at: '',
  approval_ref: '',
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T09:00:00Z')); // 12:00 Israel
});
afterEach(() => vi.useRealTimers());

describe('publisher plan', () => {
  const plan = (rows: Json[], config = CONFIG) => run('publisher-plan.js', { nodes: { 'Load Config': config, 'Read Calendar': rows } });

  it('publishes only approved posts that are due', async () => {
    const out = await plan([
      row({ id: 'approved-due', approved_at: '2026-09-28 10:00' }),
      row({ id: 'auto-due', approval_mode: 'auto' }),
      row({ id: 'approved-future', approved_at: 'x', publish_at: '2026-09-29 12:30' }),
      row({ id: 'draft', status: 'draft', approved_at: 'x' }),
      row({ id: 'published', status: 'published', approved_at: 'x' }),
      row({ id: 'bad-date', approved_at: 'x', publish_at: '29/09/2026' }),
    ]);
    const publish = out.filter((o) => o.route === 'publish').map((o) => o.id);
    expect(publish).toEqual(['approved-due', 'auto-due']);
    expect(out[0]).toMatchObject({ caption: 'hello - world', access_token: 'TOKEN', ig_user_id: '1789' });
  });

  it('never publishes unapproved posts; asks for approval ahead of time', async () => {
    const out = await plan([
      row({ id: 'due-unapproved' }),
      row({ id: 'tonight', publish_at: '2026-09-29 21:00' }),
      row({ id: 'next-week', publish_at: '2026-10-06 21:00' }),
      row({ id: 'already-asked', status: 'pending_approval' }),
    ]);
    expect(out.every((o) => o.route === 'ask')).toBe(true);
    expect(out.map((o) => o.id)).toEqual(['due-unapproved', 'tonight']);
    expect(out[0]).toMatchObject({ overdue: true, preview_url: expect.stringContaining('/w_1080,c_limit') });
    expect(String(out[0]!.approval_ref)).toMatch(/^[a-z0-9]{4,6}$/);
  });

  it('respects approval_lead_hours from config', async () => {
    const out = await plan([row({ id: 'tonight', publish_at: '2026-09-29 21:00' })], [...CONFIG, { key: 'approval_lead_hours', value: '2' }]);
    expect(out).toEqual([]);
  });
});

describe('publisher claim verification', () => {
  const verify = (claimed: Json[], fresh: Json[]) =>
    run('claim-verify.js', {
      executionId: '77',
      nodes: { 'Load Config': CONFIG, 'Claim Posts': claimed, 'Re-read Calendar': fresh },
    });

  it('publishes only rows this execution still owns and that are still approved', async () => {
    const out = await verify(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        row({ id: 'a', status: 'publishing', approval_ref: 'claim:77', approved_at: 'x' }),
        row({ id: 'b', status: 'publishing', approval_ref: 'claim:77', approved_at: '' }),
        row({ id: 'c', status: 'publishing', approval_ref: 'claim:99', approved_at: 'x' }),
      ],
    );
    expect(out.map((o) => [o.id, o.claimed])).toEqual([
      ['a', true],
      ['b', false], // approval withdrawn → release back to ready
    ]);
    expect(out[0]).toMatchObject({ access_token: 'TOKEN', telegram_chat_id: '356' });
  });
});

describe('telegram routing', () => {
  const route = (update: Json) => run('telegram-route.js', { nodes: { 'Load Config': CONFIG, 'Telegram Trigger': [update] } });

  it('ignores anyone who is not the owner', async () => {
    expect(await route({ message: { chat: { id: 999 }, text: 'hi' } })).toEqual([]);
    expect(await route({ callback_query: { id: 'q', data: 'approve:p1:r', message: { chat: { id: 999 }, message_id: 1 } } })).toEqual([]);
  });

  it('classifies buttons, media and text', async () => {
    expect(await route({ callback_query: { id: 'q', data: 'approve:p1:r', message: { chat: { id: 356 }, message_id: 5 } } })).toEqual([
      { kind: 'callback', data: 'approve:p1:r', query_id: 'q', chat_id: '356', message_id: 5 },
    ]);
    const [photo] = await route({ message: { chat: { id: 356 }, caption: '#winter', photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
    expect(photo).toMatchObject({ kind: 'media', file_id: 'big', is_video: false, text: '#winter', cloudinary_cloud: 'demo' });
    const [doc] = await route({ message: { chat: { id: 356 }, document: { file_id: 'd', mime_type: 'video/mp4' } } });
    expect(doc).toMatchObject({ kind: 'media', file_id: 'd', is_video: true });
    const [text] = await route({ message: { chat: { id: 356 }, text: 'מה קורה' } });
    expect(text).toMatchObject({ kind: 'other', app_url: 'https://bp.example' });
  });
});

describe('approval buttons', () => {
  const decide = (data: string, rows: Json[]) =>
    run('callback-decide.js', {
      nodes: { 'Route Update': [{ data, query_id: 'q', chat_id: '356', message_id: 9 }], 'Read Calendar': rows },
    });

  it('rejects stale buttons (wrong ref, handled, or missing post)', async () => {
    expect((await decide('approve:p1:old', [row({ status: 'pending_approval', approval_ref: 'new' })]))[0]!.decision).toBe('stale');
    expect((await decide('approve:p1:r', [row({ status: 'ready', approval_ref: 'r' })]))[0]!.decision).toBe('stale');
    expect((await decide('approve:nope:r', []))[0]!.decision).toBe('stale');
  });

  it('approves for later, publishes now when overdue, or rejects', async () => {
    const future = row({ status: 'pending_approval', approval_ref: 'r', publish_at: '2026-09-30 19:00' });
    expect((await decide('approve:p1:r', [future]))[0]).toMatchObject({ decision: 'approve_later', approved_at: '2026-09-29 12:00' });
    const overdue = row({ status: 'pending_approval', approval_ref: 'r' });
    expect((await decide('approve:p1:r', [overdue]))[0]!.decision).toBe('publish_now');
    expect((await decide('reject:p1:r', [overdue]))[0]!.decision).toBe('reject');
  });

  it('still accepts buttons sent by the old workflow (no ref)', async () => {
    expect((await decide('approve:p1', [row({ status: 'pending_approval' })]))[0]!.decision).toBe('publish_now');
  });

  it('verifies the claim before acting (double taps)', async () => {
    const nodes = {
      'Load Config': CONFIG,
      Decide: [{ id: 'p1', decision: 'publish_now', edit_text: 'ok' }],
      'Re-read Calendar': [row({ approval_ref: 'claim:1' })],
    };
    expect((await run('callback-verify.js', { executionId: '2', nodes }))[0]!.decision).toBe('stale');
    expect((await run('callback-verify.js', { executionId: '1', nodes }))[0]).toMatchObject({ decision: 'publish_now', access_token: 'TOKEN' });
  });
});

describe('publish to instagram', () => {
  const base = { ...row({}), access_token: 'T', ig_user_id: 'IG' };

  it('creates, waits, publishes and fetches the permalink', async () => {
    const calls: string[] = [];
    const [out] = await run('publish-instagram.js', {
      json: base,
      http: ({ method, url, qs }) => {
        calls.push(`${method} ${url.replace('https://graph.facebook.com/v26.0/', '')}`);
        if (url.endsWith('/IG/media')) return { id: 'C1', qs };
        if (url.endsWith('/C1')) return { status_code: 'FINISHED' };
        if (url.endsWith('/media_publish')) return { id: 'M1' };
        if (url.endsWith('/M1')) return { permalink: 'https://instagram.com/p/x' };
        throw new Error(url);
      },
    });
    expect(out).toMatchObject({ status: 'published', ig_media_id: 'M1', permalink: 'https://instagram.com/p/x', error: '' });
    expect(calls).toEqual(['POST IG/media', 'GET C1', 'POST IG/media_publish', 'GET M1']);
  });

  it('reports Meta errors instead of throwing', async () => {
    const [out] = await run('publish-instagram.js', {
      json: base,
      http: () => ({ error: { code: 9004, message: 'Media download failed' } }),
    });
    expect(out).toMatchObject({ status: 'failed', error: 'Meta 9004: Media download failed' });
  });

  it('does not post twice', async () => {
    const [out] = await run('publish-instagram.js', { json: { ...base, ig_media_id: 'M0' }, http: () => { throw new Error('no calls'); } });
    expect(out).toMatchObject({ status: 'published', ig_media_id: 'M0' });
  });
});

describe('telegram media intake', () => {
  const nodes = (text: string, config = CONFIG) => ({
    'Load Config': config,
    'Route Update': [{ kind: 'media', text, is_video: false, chat_id: '356' }],
    'Upload to Cloudinary': [{ secure_url: IMG }],
    'Read Campaigns': [{ id: 'winter', name: 'חורף', key_message: 'חם' }],
    'Read Products': [{ id: 'kitchen', name: 'מטבח' }],
    'Read Brand': [{ key: 'voice', value: 'חם' }],
  });

  it('matches #tags to campaign/product and uses the rest as the AI brief', async () => {
    const [req] = await run('intake-request.js', { nodes: nodes('#Winter #kitchen לפני ואחרי') });
    expect(req).toMatchObject({ use_ai: true, campaign_id: 'winter', product_id: 'kitchen', brief: 'לפני ואחרי' });
    expect(req!.request).toMatchObject({ media: [IMG], campaign: { name: 'חורף' }, brand: { voice: 'חם' } });
  });

  it('keeps "!" text verbatim without AI', async () => {
    const [req] = await run('intake-request.js', { nodes: nodes('!הקפשן — שלי') });
    expect(req).toMatchObject({ use_ai: false, fallback_caption: 'הקפשן - שלי' });
  });

  it('builds the draft from the first AI variant, or falls back', async () => {
    const [req] = await run('intake-request.js', { nodes: nodes('בריף') });
    const ai = { variants: [{ angle: 'א', caption: 'גוף', hashtags: ['a', '#b'] }, { angle: 'ב', caption: 'אחר', hashtags: [] }] };
    const [draft] = await run('intake-draft.js', { json: ai, nodes: { 'Build Caption Request': [req!] } });
    expect(draft).toMatchObject({ caption: 'גוף\n\n#a #b', status: 'draft', ai_used: true, type: 'POST' });
    expect(String(draft!.alternatives)).toContain('אחר');

    const [fallback] = await run('intake-draft.js', { json: { error: { message: 'timeout' } }, nodes: { 'Build Caption Request': [req!] } });
    expect(fallback).toMatchObject({ caption: 'בריף', ai_used: false, ai_error: 'timeout' });
  });
});

describe('watchdog', () => {
  const check = (rows: Json[]) => run('watchdog.js', { nodes: { 'Load Config': CONFIG, 'Read Calendar': rows } });

  it('is silent when all is well', async () => {
    expect(await check([row({ status: 'published' })])).toEqual([]);
  });

  it('reports stuck posts and tomorrow digest', async () => {
    const [out] = await check([
      row({ id: 'missed', publish_at: '2026-09-29 10:00', approved_at: 'x' }),
      row({ id: 'waiting', status: 'pending_approval', publish_at: '2026-09-29 09:00' }),
      row({ id: 'tmr-ok', publish_at: '2026-09-30 19:00', approved_at: 'x' }),
      row({ id: 'tmr-wait', publish_at: '2026-09-30 09:00' }),
    ]);
    const text = String(out!.text);
    expect(text).toContain('מאושר ולא עלה: missed');
    expect(text).toContain('מחכה לאישור שלך ועבר הזמן: waiting');
    expect(text).toMatch(/מאושרים:\n• 19:00 tmr-ok/);
    expect(text).toMatch(/לא יעלו בלי אישור\):\n• 09:00 tmr-wait/);
    expect(text).toContain('https://bp.example');
  });
});

describe('token refresh', () => {
  it('persists the new token and refuses silent failures', async () => {
    const out = await run('token-rows.js', { json: { access_token: 'NEW', expires_in: 5184000 } });
    expect(out.map((o) => o.key)).toEqual(['access_token', 'access_token_refreshed_at']);
    expect(out[0]).toMatchObject({ value: 'NEW', days: 60 });
    await expect(run('token-rows.js', { json: { error: { message: 'bad' } } })).rejects.toThrow(/exchange failed/);
  });
});

describe('workflow definitions', () => {
  it('committed JSON is in sync with the source', () => {
    expect(() => execFileSync('node', ['scripts/build-n8n.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(Object.entries(WORKFLOWS))('%s only references nodes that exist', (_, wf) => {
    const names = new Set(wf.nodes.map((n) => n.name));
    const text = JSON.stringify(wf.nodes.map((n) => n.parameters));
    const refs = [...text.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)].map((m) => m[1]!);
    for (const ref of refs) expect(names, `${wf.name} → $('${ref}')`).toContain(ref);
    for (const [from, { main }] of Object.entries(wf.connections)) {
      expect(names).toContain(from);
      for (const out of main) for (const link of out) expect(names).toContain(link.node);
    }
  });

  it('writes to Sheets as RAW text and routes failures to the error workflow', () => {
    for (const wf of Object.values(WORKFLOWS)) {
      for (const n of wf.nodes) {
        const op = (n.parameters as { operation?: string }).operation;
        if (n.type === 'n8n-nodes-base.googleSheets' && op) {
          expect((n.parameters as { options: Json }).options, `${wf.name}/${n.name}`).toMatchObject({ cellFormat: 'RAW' });
        }
      }
      if (wf.id !== 'cPELz1Hlnup9oEir') expect(wf.settings.errorWorkflow).toBe('cPELz1Hlnup9oEir');
    }
  });
});
