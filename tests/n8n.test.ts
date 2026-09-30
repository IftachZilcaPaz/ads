import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCode } from '../n8n/src/nodes.mjs';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';

type Json = Record<string, unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Ctx {
  nodes?: Record<string, Json[]>;
  input?: Json[];
  json?: Json;
  executionId?: string;
  http?: (req: { method: string; url: string; qs: Json }) => unknown;
}

/** Executes a code-node source the way n8n does ($, $json, this.helpers...). */
async function run(file: string, ctx: Ctx = {}): Promise<Json[]> {
  const src = loadCode(file, { ITEM: '$json' });
  const $ = (name: string) => {
    const rows = ctx.nodes?.[name];
    if (!rows) throw new Error(`Node '${name}' not provided`);
    const items = rows.map((json) => ({ json }));
    return { all: () => items, first: () => items[0], item: items[0] };
  };
  const fn = new AsyncFunction('$', '$input', '$json', '$execution', src);
  const helpers = {
    httpRequest: async (req: { method: string; url: string; qs: Json }) => ({ statusCode: 200, body: ctx.http!(req) }),
  };
  const $input = { all: () => (ctx.input ?? []).map((json) => ({ json })) };
  const out = await fn.call({ helpers }, $, $input, ctx.json, { id: ctx.executionId ?? '42' });
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

describe('publisher preparation', () => {
  it('attaches Meta credentials to claimed rows', async () => {
    const out = await run('prepare-publish.js', { nodes: { 'Load Config': CONFIG }, input: [row({ status: 'publishing' })] });
    expect(out[0]).toMatchObject({ id: 'p1', caption: 'hello - world', access_token: 'TOKEN', ig_user_id: '1789', telegram_chat_id: '356' });
  });

  it('builds approval requests with a preview still and overdue flag', async () => {
    const out = await run('prepare-ask.js', {
      nodes: { 'Load Config': CONFIG },
      input: [row({ status: 'pending_approval', approval_ref: 'abc123' }), row({ id: 'p2', publish_at: '2026-09-30 19:00', media_urls: `${IMG},${IMG}` })],
    });
    expect(out[0]).toMatchObject({ overdue: true, media_count: 1, telegram_chat_id: '356', preview_url: expect.stringContaining('/w_1080,c_limit') });
    expect(out[1]).toMatchObject({ overdue: false, media_count: 2 });
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
      { kind: 'callback', action: 'approve', id: 'p1', ref: 'r', query_id: 'q', chat_id: '356', message_id: 5 },
    ]);
    const [legacy] = await route({ callback_query: { id: 'q', data: 'reject:p9', message: { chat: { id: 356 }, message_id: 5 } } });
    expect(legacy).toMatchObject({ action: 'reject', id: 'p9', ref: '' });
    const [photo] = await route({ message: { chat: { id: 356 }, caption: '#winter', photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
    expect(photo).toMatchObject({ kind: 'media', file_id: 'big', is_video: false, text: '#winter', cloudinary_cloud: 'demo' });
    const [doc] = await route({ message: { chat: { id: 356 }, document: { file_id: 'd', mime_type: 'video/mp4' } } });
    expect(doc).toMatchObject({ kind: 'media', file_id: 'd', is_video: true });
    const [text] = await route({ message: { chat: { id: 356 }, text: 'מה קורה' } });
    expect(text).toMatchObject({ kind: 'other', app_url: 'https://bp.example' });
  });
});

describe('approval buttons', () => {
  const decision = (result: Json) =>
    run('callback-decision.js', {
      nodes: {
        'Load Config': CONFIG,
        'Route Update': [{ id: 'p1', query_id: 'q', chat_id: '356', message_id: 9 }],
        Decide: [{ result }],
      },
    });

  it('turns decide_approval results into Telegram texts', async () => {
    expect((await decision({ ...row({}), decision: 'approve_later', publish_at: '2026-10-01 19:00' }))[0]).toMatchObject({
      decision: 'approve_later',
      answer: 'מאושר ✅',
      edit_text: '✅ p1 אושר ויעלה ב-2026-10-01 19:00',
      message_id: 9,
    });
    expect((await decision({ ...row({}), decision: 'reject' }))[0]!.edit_text).toContain('נדחה');
  });

  it('carries credentials for publish_now; unknown results are stale', async () => {
    expect((await decision({ ...row({ status: 'publishing' }), decision: 'publish_now' }))[0]).toMatchObject({
      decision: 'publish_now',
      access_token: 'TOKEN',
      caption: 'hello - world',
    });
    expect((await decision({ decision: 'stale', reason: 'missing', id: 'p1' }))[0]).toMatchObject({ decision: 'stale', answer: 'הבקשה הזאת כבר לא בתוקף' });
    expect((await decision({}))[0]!.decision).toBe('stale');
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

  it('sends images in a shape Instagram accepts', async () => {
    const sent: string[] = [];
    const http = ({ url, qs }: { url: string; qs: Json }) => {
      if (url.endsWith('/IG/media')) {
        sent.push(String(qs.image_url));
        return { id: 'C1' };
      }
      if (url.endsWith('/C1')) return { status_code: 'FINISHED' };
      if (url.endsWith('/media_publish')) return { id: 'M1' };
      return {};
    };
    await run('publish-instagram.js', { json: { ...base, media_urls: 'https://res.cloudinary.com/demo/image/upload/v17/folder/tall.PNG' }, http });
    await run('publish-instagram.js', { json: { ...base, type: 'STORY' }, http });
    await run('publish-instagram.js', { json: { ...base, media_urls: 'https://cdn.example/x.jpg' }, http });
    expect(sent).toEqual([
      'https://res.cloudinary.com/demo/image/upload/if_ar_lt_0.8/c_pad,ar_4:5,b_auto/if_end/if_ar_gt_1.91/c_pad,ar_1.91,b_auto/if_end/c_limit,w_1440/q_auto:good/v17/folder/tall.jpg',
      'https://res.cloudinary.com/demo/image/upload/c_limit,w_1440/q_auto:good/v1/a.jpg',
      'https://cdn.example/x.jpg',
    ]);
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
    'Read Catalog': [
      { campaigns: [{ id: 'winter', name: 'חורף', key_message: 'חם' }], products: [{ id: 'kitchen', name: 'מטבח' }], brand: { voice: 'חם' } },
    ],
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

  it('talks to Postgres only (no Sheets) and routes failures to the error workflow', () => {
    for (const wf of Object.values(WORKFLOWS)) {
      for (const n of wf.nodes) {
        expect(n.type, `${wf.name}/${n.name}`).not.toBe('n8n-nodes-base.googleSheets');
        if (n.type === 'n8n-nodes-base.postgres') {
          expect(n.credentials).toEqual({ postgres: { id: '__PG_CREDENTIAL_ID__', name: 'BP Postgres' } });
          expect(String(n.parameters.query)).not.toMatch(/\$\{|\{\{/); // values go through parameters, never string interpolation
        }
      }
      if (wf.id !== 'cPELz1Hlnup9oEir') expect(wf.settings.errorWorkflow).toBe('cPELz1Hlnup9oEir');
    }
  });
});
