/**
 * Checks the Meta token stored in settings: which permissions it has, when it
 * expires, and which ad accounts it can reach (with the ready-to-run command
 * that saves one).
 *   npm run meta:check
 *   npm run meta:check -- --token <short-lived token from Graph API Explorer>
 *     exchanges it for a 60-day token (meta_app_id / meta_app_secret), saves it, then checks
 */
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { createMeta, GRAPH_VERSION } from '../src/server/meta.ts';
import { databaseUrl, fail } from './cli-env.ts';

const NEEDED: [scope: string, why: string][] = [
  ['instagram_basic', 'פרסום ופרטי החשבון'],
  ['instagram_content_publish', 'פרסום פוסטים'],
  ['instagram_manage_insights', 'נתונים אורגניים בדף הקמפיין'],
  ['ads_read', 'נתוני מודעות ממומנות'],
  ['ads_management', 'יצירת קמפיין מושהה ב-Meta'],
];

const tokenArg = process.argv.indexOf('--token');
const newToken = tokenArg >= 0 ? process.argv[tokenArg + 1]?.trim() : undefined;
if (tokenArg >= 0 && !newToken) fail('Usage: npm run meta:check -- --token <token>');

const db = createPostgresDb(databaseUrl());
try {
  const read = async () =>
    Object.fromEntries(
      (
        await db.query<{ key: string; value: string }>(
          `select key, value from settings where key in ('access_token', 'meta_ad_account_id', 'meta_app_id', 'meta_app_secret')`,
        )
      ).map((r) => [r.key, r.value.trim()]),
    );
  let settings = await read();

  if (newToken) {
    if (!settings.meta_app_id || !settings.meta_app_secret) fail('חסרים meta_app_id / meta_app_secret בהגדרות להחלפה לטוקן ארוך');
    const qs = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: settings.meta_app_id,
      client_secret: settings.meta_app_secret,
      fb_exchange_token: newToken,
    });
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${qs}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (!body.access_token) fail(`ההחלפה נכשלה: ${body.error?.message ?? res.status}`);
    for (const [key, value] of [
      ['access_token', body.access_token],
      ['access_token_refreshed_at', new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16)],
    ]) {
      await db.query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
    }
    console.log(`✅ New token saved (valid ~${Math.round((body.expires_in ?? 5_184_000) / 86400)} days; BP 4 keeps renewing it)`);
    settings = await read();
  }

  if (!settings.access_token) fail('אין access_token בהגדרות');
  const meta = createMeta(settings.access_token);

  // Works for user and system-user tokens inspecting themselves.
  const { data: info } = await meta.get<{
    data: { type?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] };
  }>('debug_token', { input_token: settings.access_token });

  console.log(`\nToken: ${info.is_valid ? '✅ valid' : '❌ NOT valid'} (${info.type ?? '?'})`);
  if (info.expires_at) console.log(`  expires: ${new Date(info.expires_at * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' })}`);
  else console.log('  expires: never (or long-lived page/system token)');

  const scopes = new Set(info.scopes ?? []);
  console.log('\nPermissions:');
  for (const [scope, why] of NEEDED) console.log(`  ${scopes.has(scope) ? '✅' : '❌'} ${scope.padEnd(28)} ${why}`);
  const missing = NEEDED.filter(([s]) => !scopes.has(s)).map(([s]) => s);

  console.log('\nAd accounts this token can use:');
  try {
    const { data: accounts } = await meta.get<{ data: { id: string; name: string; currency: string; account_status: number }[] }>(
      'me/adaccounts',
      { fields: 'id,name,currency,account_status', limit: '50' },
    );
    if (!accounts.length) console.log('  (none)');
    for (const a of accounts) {
      const active = a.account_status === 1 ? '' : ' (not active)';
      const current = settings.meta_ad_account_id?.replace(/^act_/, '') === a.id.replace(/^act_/, '') ? '  ← saved' : '';
      console.log(`  ${a.id.padEnd(22)} ${a.name} · ${a.currency}${active}${current}`);
    }
    if (accounts.length && !settings.meta_ad_account_id) {
      console.log(`\n  To use the first one:\n    npm run db:set -- meta_ad_account_id ${accounts[0]!.id}`);
    }
  } catch (err) {
    console.log(`  ⚠️ ${(err as Error).message}`);
  }

  if (missing.length) {
    console.log(`\nMissing: ${missing.join(', ')}`);
    console.log('Create a new token with them (see docs/setup.md → "טוקן של Meta") and save it:');
    console.log('  npm run db:set -- access_token <new token>');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.close();
}
