/**
 * "Why didn't my post go up?" in one command: what the database holds for
 * recent/upcoming posts, which settings n8n needs, and what n8n last did.
 *   npm run doctor
 */
import { createClient } from '../n8n/src/deploy.mjs';
import { WORKFLOWS } from '../n8n/src/workflows.mjs';
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { isApproved, toPost, type Post } from '../src/shared/post.ts';
import { databaseUrl, env } from './cli-env.ts';

const REQUIRED_SETTINGS = ['access_token', 'ig_user_id', 'telegram_chat_id', 'app_url', 'app_api_token'];

const one = (s: string, n = 40) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function explain(p: Post, now: string): string {
  const approved = isApproved(p);
  switch (p.status) {
    case 'ready':
      if (!approved) return 'not approved yet - Telegram request comes within the lead window';
      return p.publish_at <= now ? 'approved and due - publishes on the next 15-minute run' : 'approved, waiting for its time';
    case 'pending_approval':
      return 'waiting for your ✅ in Telegram';
    case 'publishing':
      return 'claimed by n8n - should finish within minutes; if it stays, check BP 1 executions';
    case 'failed':
      return `FAILED: ${one(p.error, 120)}`;
    default:
      return p.status;
  }
}

async function checkDatabase(): Promise<void> {
  const db = createPostgresDb(databaseUrl());
  try {
    const [row] = await db.query<{ now: string }>('select il_now() as now');
    const now = row!.now;
    console.log(`  Israel time in DB: ${now}  (your clock: ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16)})`);

    const rows = await db.query<Record<string, string>>(
      `select * from posts
        where status in ('ready', 'pending_approval', 'publishing', 'failed')
           or (publish_at <> '' and publish_at between il_now(-1440) and il_now(1440))
        order by publish_at limit 20`,
    );
    const posts = rows.map(toPost);
    console.log(posts.length ? '\n  Posts (active, or within ±24h):' : '\n  No active posts.');
    for (const p of posts) {
      console.log(`  • ${p.publish_at || '(no time)'}  ${p.id}  [${p.status}]  ${explain(p, now)}`);
      console.log(`      ${one(p.caption)}`);
    }

    const settingRows = await db.query<{ key: string; value: string }>('select key, value from settings');
    const settings = new Map(settingRows.map((r) => [r.key, r.value.trim()]));
    const missing = REQUIRED_SETTINGS.filter((k) => !settings.get(k));
    console.log(missing.length ? `\n  ⚠️ Missing settings: ${missing.join(', ')}  (npm run db:set -- <key> <value>)` : '\n  ✅ Settings n8n needs are present');
  } finally {
    await db.close();
  }
}

type Execution = { id: string; status?: string; finished?: boolean; startedAt: string; mode: string };

async function checkN8n(): Promise<void> {
  if (!env.N8N_URL || !env.N8N_API_KEY) {
    console.log('  (skipped: N8N_URL / N8N_API_KEY not in .env)');
    return;
  }
  const api = createClient({ baseUrl: env.N8N_URL, apiKey: env.N8N_API_KEY });
  const when = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16);

  for (const wf of Object.values(WORKFLOWS) as { id: string; name: string }[]) {
    const current = (await api('GET', `/workflows/${wf.id}`)) as { active: boolean };
    const { data } = (await api('GET', `/executions?workflowId=${wf.id}&limit=5`)) as { data: Execution[] };
    const runs = data.map((e) => `${when(e.startedAt)} ${e.status ?? (e.finished ? 'success' : 'error')}`);
    const state = wf.id === 'cPELz1Hlnup9oEir' ? 'runs on errors' : current.active ? 'active' : '❌ NOT ACTIVE';
    console.log(`  ${wf.name}: ${state}`);
    console.log(`      last runs: ${runs.length ? runs.join(' | ') : 'none yet'}`);

    const failed = data.find((e) => e.status === 'error' || e.status === 'crashed');
    if (failed) {
      const detail = (await api('GET', `/executions/${failed.id}?includeData=true`)) as {
        data?: { resultData?: { error?: { message?: string; node?: { name?: string } }; lastNodeExecuted?: string } };
      };
      const r = detail.data?.resultData;
      console.log(`      ⚠️ last error (${when(failed.startedAt)}) at "${r?.error?.node?.name ?? r?.lastNodeExecuted ?? '?'}": ${one(r?.error?.message ?? 'unknown', 200)}`);
    }
  }
}

for (const [title, check] of [['Database', checkDatabase], ['n8n', checkN8n]] as const) {
  console.log(`\n${title}`);
  try {
    await check();
  } catch (err) {
    console.log(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
  }
}
