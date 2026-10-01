import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Toasts } from './components/Toasts.tsx';
import { useLocation, type Route } from './router.ts';
import { AppProvider, useApp } from './state.tsx';
import { Icon, type IconName } from './icons.tsx';
import { cx, greeting } from './ui.ts';
import { Board } from './views/Board.tsx';
import { BrandView } from './views/BrandView.tsx';
import { Calendar } from './views/Calendar.tsx';
import { CampaignView } from './views/CampaignView.tsx';
import { Library } from './views/Library.tsx';
import { Login } from './views/Login.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { Studio } from './views/Studio.tsx';

const NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: 'board', label: 'לוח', icon: 'board' },
  { route: 'calendar', label: 'יומן', icon: 'calendar' },
  { route: 'studio', label: 'סטודיו', icon: 'sparkles' },
  { route: 'library', label: 'קמפיינים ומוצרים', icon: 'megaphone' },
  { route: 'brand', label: 'מותג', icon: 'mic' },
  { route: 'settings', label: 'הגדרות', icon: 'settings' },
];

type AuthState = 'checking' | 'in' | 'out';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api
      .session()
      .then((s) => setAuth(s.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('out'));
  }, []);

  if (auth === 'checking') return <div class="splash">טוען...</div>;
  if (auth === 'out') return <Login onSuccess={() => setAuth('in')} />;
  return (
    <AppProvider>
      <Shell onLogout={() => setAuth('out')} />
      <Toasts />
    </AppProvider>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { route, query } = useLocation();
  // A campaign page lives under "campaigns and products" in the navigation.
  const navRoute = route === 'campaign' ? 'library' : route;
  const { data, loadError, reload } = useApp();

  const logout = async () => {
    await api.logout().catch(() => undefined);
    onLogout();
  };

  return (
    <div class="shell">
      <aside class="sidebar">
        <a class="side-brand" href="#/board">
          <span class="avatar">
            <Icon name="camera" size={30} />
          </span>
          <strong>{greeting()}!</strong>
          <small>BP Social</small>
        </a>
        <nav class="side-nav">
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} class={cx(navRoute === n.route && 'active')} aria-current={navRoute === n.route ? 'page' : undefined}>
              <Icon name={n.icon} size={20} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div class="side-promo">
          <span class="promo-icon">
            <Icon name="sparkles" size={26} />
          </span>
          <strong>עוזר הקפשנים</strong>
          <p>תמונה ← קפשן בקול של המותג</p>
          <a class="btn-3d" href="#/studio">
            פוסט חדש
          </a>
        </div>
        <div class="side-tools">
          <button type="button" class="icon round" title="רענון" aria-label="רענון" onClick={() => void reload()}>
            <Icon name="refresh" size={16} />
          </button>
          <button type="button" class="icon round" title="יציאה" aria-label="יציאה" onClick={() => void logout()}>
            <Icon name="logout" size={16} />
          </button>
        </div>
      </aside>

      <header class="mobile-top">
        <span class="avatar small">
          <Icon name="camera" size={18} />
        </span>
        <strong>BP Social</strong>
        <button type="button" class="icon round" aria-label="רענון" onClick={() => void reload()}>
          <Icon name="refresh" size={16} />
        </button>
        <button type="button" class="icon round" aria-label="יציאה" onClick={() => void logout()}>
          <Icon name="logout" size={16} />
        </button>
      </header>

      <main class={cx('page', `page-${route}`)}>
        {loadError && (
          <p class="notice error">
            {loadError}{' '}
            <button type="button" onClick={() => void reload()}>
              נסה שוב
            </button>
          </p>
        )}
        {!data && !loadError && <div class="splash">טוען את הלוח...</div>}
        {data && route === 'board' && <Board />}
        {data && route === 'calendar' && <Calendar />}
        {data && route === 'studio' && <Studio query={query} />}
        {data && route === 'library' && <Library />}
        {data && route === 'campaign' && <CampaignView id={query.get('id') ?? ''} />}
        {data && route === 'brand' && <BrandView />}
        {data && route === 'settings' && <SettingsView query={query} />}
      </main>
    </div>
  );
}
