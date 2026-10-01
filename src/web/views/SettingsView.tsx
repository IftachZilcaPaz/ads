import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type ConnectionsStatus, type MetaOptions } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useApp } from '../state.tsx';
import { cx } from '../ui.ts';

const DAY = 86_400;

function expiryText(expiresAt: number): { text: string; warn: boolean } {
  if (!expiresAt) return { text: 'לא פג', warn: false };
  const days = Math.floor((expiresAt - Date.now() / 1000) / DAY);
  const date = new Date(expiresAt * 1000).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  if (days < 0) return { text: `פג ב-${date}`, warn: true };
  return { text: `בתוקף עד ${date} (עוד ${days} ימים)`, warn: days < 10 };
}

/** Settings → connections: what is connected today, and the controls to (re)connect Meta. */
export function SettingsView({ query }: { query: URLSearchParams }) {
  const { run, toast } = useApp();
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await run(() => api.connections());
    if (next) setStatus(next);
    setLoading(false);
  }, [run]);

  useEffect(() => {
    void load();
    // Returning from the Facebook login dialog.
    if (query.get('meta') === 'connected') toast('החיבור ל-Meta עודכן ✅');
    const error = query.get('meta_error');
    if (error) toast(error, 'error');
    if (query.has('meta') || error) history.replaceState(null, '', '#/settings');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div class="settings-page">
      <header class="page-head">
        <span class="eyebrow">הגדרות</span>
        <h1>
          חיבורים <em>והרשאות</em>
        </h1>
        <p class="muted">מה מחובר עכשיו, לאיזה חשבון, ואילו הרשאות יש. מכאן גם מתחברים מחדש כשמשהו חסר.</p>
      </header>

      {!status && <p class="progress-note">{loading ? <><i class="spinner" /> בודק חיבורים...</> : 'לא הצלחתי לטעון את החיבורים.'}</p>}
      {status && <MetaPanel status={status} onChange={setStatus} onRefresh={load} loading={loading} />}
      {status && <OtherConnections status={status} />}
    </div>
  );
}

function MetaPanel({
  status,
  onChange,
  onRefresh,
  loading,
}: {
  status: ConnectionsStatus;
  onChange: (s: ConnectionsStatus) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const { run, toast } = useApp();
  const meta = status.meta;
  const token = meta.token;
  const missing = token?.scopes.filter((s) => !s.granted) ?? [];
  const missingPublishing = missing.filter((s) => s.publishing);
  const state = !token ? 'off' : !token.valid || meta.error || missingPublishing.length || token.wrong_app ? 'bad' : missing.length ? 'partial' : 'ok';
  const expiry = token ? expiryText(token.expires_at) : null;

  const [options, setOptions] = useState<MetaOptions | null>(null);
  const [app, setApp] = useState({ meta_app_id: meta.app_id, meta_app_secret: '', meta_login_config_id: meta.login_config_id });
  const [pasted, setPasted] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(changes: Record<string, string>, message: string) {
    setBusy(true);
    const next = await run(() => api.saveMetaSettings(changes), message);
    setBusy(false);
    if (next) onChange(next);
    return !!next;
  }

  async function loadOptions() {
    const next = await run(() => api.metaOptions());
    if (next) setOptions(next);
  }

  async function connectToken() {
    setBusy(true);
    const next = await run(() => api.connectMetaToken(pasted), 'הטוקן הוחלף לטוקן ארוך ונשמר ✅');
    setBusy(false);
    if (!next) return;
    onChange(next);
    setPasted('');
    setShowToken(false);
  }

  const redirectUri = `${location.origin}/api/connections/meta/callback`;

  return (
    <section class="panel">
      <div class="conn-head">
        <span class={cx('conn-state', state)}>{state === 'ok' ? '✅' : state === 'partial' ? '🟡' : state === 'bad' ? '⚠️' : '⚪'}</span>
        <div>
          <h2 class="panel-title">Meta · אינסטגרם ופייסבוק</h2>
          <p class="muted small">
            {state === 'ok' && 'מחובר עם כל ההרשאות.'}
            {state === 'partial' && 'מחובר. הפרסום עובד, אבל חסרות הרשאות לחלק מהיכולות.'}
            {state === 'bad' && (meta.error || (token?.wrong_app ? 'הטוקן שייך לאפליקציה אחרת מזו שבהגדרות: חידוש הטוקן ייכשל.' : 'חסרות הרשאות פרסום, או שהטוקן לא תקף.'))}
            {state === 'off' && 'עוד לא מחובר.'}
          </p>
        </div>
        <button type="button" class="icon round" title="בדוק שוב" aria-label="בדוק שוב" disabled={loading} onClick={onRefresh}>
          <Icon name="refresh" size={16} />
        </button>
      </div>

      {token && (
        <div class="metric-grid">
          <div class="metric">
            <strong class="metric-text">{token.app_name || '?'}</strong>
            <span>אפליקציה · {token.app_id}</span>
          </div>
          <div class={cx('metric', expiry?.warn && 'warn')}>
            <strong class="metric-text">{token.valid ? 'תקף' : 'לא תקף'}</strong>
            <span>{expiry?.text}</span>
          </div>
          <div class="metric">
            <strong class="metric-text">{meta.instagram ? `@${meta.instagram.username || meta.instagram.id}` : 'לא נבחר'}</strong>
            <span>חשבון אינסטגרם</span>
          </div>
          <div class="metric">
            <strong class="metric-text">{meta.ad_account ? meta.ad_account.name || meta.ad_account.id : 'לא נבחר'}</strong>
            <span>חשבון מודעות {meta.ad_account?.currency && `· ${meta.ad_account.currency}`}</span>
          </div>
        </div>
      )}

      {token && (
        <>
          <h3 class="sub-title">הרשאות</h3>
          <ul class="scope-list">
            {token.scopes.map((s) => (
              <li key={s.scope} class={cx(!s.granted && 'missing')}>
                <span>{s.granted ? '✅' : '❌'}</span>
                <code>{s.scope}</code>
                <span class="muted small">
                  {s.label}
                  {s.publishing && ' · חובה לפרסום'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 class="sub-title">חיבור מחדש</h3>
      <div class="row wrap">
        <a class={cx('btn-3d', !meta.oauth_ready && 'disabled')} href={meta.oauth_ready ? '/api/connections/meta/login' : undefined} aria-disabled={!meta.oauth_ready}>
          התחברות עם פייסבוק
        </a>
        <button type="button" onClick={() => setShowToken(!showToken)}>
          הדבקת טוקן
        </button>
        {token && (
          <button type="button" onClick={() => void loadOptions()}>
            בחירת חשבונות
          </button>
        )}
      </div>
      <p class="muted small">
        בהתחברות מבקשים את כל ההרשאות{missing.length ? ` (חסרות עכשיו: ${missing.map((m) => m.scope).join(', ')})` : ''}. טוקן חדש בלי הרשאות פרסום לא נשמר, והחיבור הקיים נשאר.
      </p>

      {showToken && (
        <div class="inline-form">
          <input placeholder="טוקן מ-Graph API Explorer" value={pasted} onInput={(e) => setPasted(e.currentTarget.value)} />
          <button type="button" class="primary" disabled={busy || pasted.trim().length < 20} onClick={() => void connectToken()}>
            שמירה
          </button>
        </div>
      )}

      {options && (
        <div class="grid2">
          <label class="field">
            <span>חשבון אינסטגרם</span>
            <select
              value={meta.instagram?.id ?? ''}
              onChange={(e) => e.currentTarget.value && void save({ ig_user_id: e.currentTarget.value }, 'חשבון האינסטגרם נשמר')}
            >
              <option value="">בחר...</option>
              {options.instagram.map((o) => (
                <option key={o.id} value={o.id}>
                  @{o.username} · {o.page}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>חשבון מודעות</span>
            <select
              value={meta.ad_account?.id ?? ''}
              onChange={(e) => e.currentTarget.value && void save({ meta_ad_account_id: e.currentTarget.value }, 'חשבון המודעות נשמר')}
            >
              <option value="">בחר...</option>
              {options.ad_accounts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.currency}
                  {o.active ? '' : ' (לא פעיל)'}
                </option>
              ))}
            </select>
          </label>
          {!options.instagram.length && <p class="muted small">לא נמצאו חשבונות אינסטגרם עסקיים שמחוברים לדף.</p>}
        </div>
      )}

      <details class="app-details">
        <summary>אפליקציית Meta (App ID, App Secret)</summary>
        <div class="grid2">
          <label class="field">
            <span>App ID</span>
            <input inputMode="numeric" value={app.meta_app_id} onInput={(e) => setApp({ ...app, meta_app_id: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>App Secret</span>
            <input
              type="password"
              autoComplete="off"
              placeholder={meta.app_secret_set ? '•••••••• שמור. השאר ריק כדי לא לשנות' : 'מ-App settings ← Basic'}
              value={app.meta_app_secret}
              onInput={(e) => setApp({ ...app, meta_app_secret: e.currentTarget.value })}
            />
          </label>
          <label class="field">
            <span>Configuration ID (לא חובה)</span>
            <input
              inputMode="numeric"
              placeholder="רק לאפליקציות עם Facebook Login for Business"
              value={app.meta_login_config_id}
              onInput={(e) => setApp({ ...app, meta_login_config_id: e.currentTarget.value })}
            />
          </label>
        </div>
        <div class="row wrap">
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={async () => {
              const changes: Record<string, string> = { meta_app_id: app.meta_app_id.trim(), meta_login_config_id: app.meta_login_config_id.trim() };
              if (app.meta_app_secret.trim()) changes.meta_app_secret = app.meta_app_secret.trim();
              if (await save(changes, 'פרטי האפליקציה נשמרו')) setApp({ ...app, meta_app_secret: '' });
            }}
          >
            שמירה
          </button>
        </div>
        <p class="muted small">
          כדי ש"התחברות עם פייסבוק" תעבוד, מוסיפים באפליקציה (Facebook Login for Business ← Settings ← Valid OAuth Redirect URIs) את הכתובת:
        </p>
        <div class="copy-row">
          <code>{redirectUri}</code>
          <button
            type="button"
            class="small"
            onClick={() => {
              void navigator.clipboard?.writeText(redirectUri);
              toast('הכתובת הועתקה');
            }}
          >
            העתקה
          </button>
        </div>
      </details>
    </section>
  );
}

function OtherConnections({ status }: { status: ConnectionsStatus }) {
  const rows: { name: string; ok: boolean; detail: string; fix: string }[] = [
    {
      name: 'בוט טלגרם',
      ok: status.telegram.bot_token_set && status.telegram.chat_id_set,
      detail: [status.telegram.bot_token_set ? 'טוקן בוט ✓' : 'חסר טוקן בוט', status.telegram.chat_id_set ? 'צ׳אט ✓' : 'חסר chat id'].join(' · '),
      fix: 'npm run db:set -- telegram_bot_token / telegram_chat_id',
    },
    {
      name: 'Cloudinary (העלאת מדיה)',
      ok: !!status.cloudinary.cloud && !!status.cloudinary.preset,
      detail: status.cloudinary.cloud ? `${status.cloudinary.cloud} · ${status.cloudinary.preset || 'חסר preset'}` : 'לא מוגדר',
      fix: 'npm run db:set -- cloudinary_cloud / cloudinary_preset',
    },
    {
      name: 'Claude (קפשנים ותוכניות)',
      ok: status.claude.configured,
      detail: status.claude.configured ? 'מפתח מוגדר' : 'חסר ANTHROPIC_API_KEY',
      fix: 'Netlify ← Environment variables',
    },
    {
      name: 'כתובת האפליקציה',
      ok: !!status.app_url,
      detail: status.app_url || 'לא מוגדרת (n8n צריך אותה)',
      fix: 'npm run db:set -- app_url https://...',
    },
  ];
  return (
    <section class="panel">
      <h2 class="panel-title">חיבורים נוספים</h2>
      <ul class="conn-list">
        {rows.map((r) => (
          <li key={r.name}>
            <span>{r.ok ? '✅' : '⚠️'}</span>
            <div>
              <strong>{r.name}</strong>
              <p class="muted small">{r.detail}</p>
              {!r.ok && <p class="small ltr-id">{r.fix}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
