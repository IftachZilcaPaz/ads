import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Toasts } from './components/Toasts.tsx';
import { useLocation, type Route } from './router.ts';
import { AppProvider, useApp } from './state.tsx';
import { Icon, type IconName } from './icons.tsx';
import { cx } from './ui.ts';
import { Board } from './views/Board.tsx';
import { BrandView } from './views/BrandView.tsx';
import { Calendar } from './views/Calendar.tsx';
import { Library } from './views/Library.tsx';
import { Login } from './views/Login.tsx';
import { Studio } from './views/Studio.tsx';

const NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: 'board', label: 'לוח', icon: 'board' },
  { route: 'calendar', label: 'יומן', icon: 'calendar' },
  { route: 'studio', label: 'סטודיו', icon: 'sparkles' },
  { route: 'library', label: 'קמפיינים ומוצרים', icon: 'megaphone' },
  { route: 'brand', label: 'מותג', icon: 'mic' },
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
  const { data, loadError, reload } = useApp();

  return (
    <>
      <header class="topbar">
        <a class="brand" href="#/board" aria-label="BP Social">
          <span class="brand-mark">
            <Icon name="camera" size={18} />
          </span>
          <span class="brand-text">
            <strong>BP Social</strong>
            <small>לוח פרסום לאינסטגרם</small>
          </span>
        </a>
        <nav>
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} class={cx(route === n.route && 'active')} aria-current={route === n.route ? 'page' : undefined}>
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div class="topbar-actions">
          <button type="button" class="icon round" title="רענון" aria-label="רענון" onClick={() => void reload()}>
            <Icon name="refresh" size={16} />
          </button>
          <button
            type="button"
            class="icon round"
            title="יציאה"
            aria-label="יציאה"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              onLogout();
            }}
          >
            <Icon name="logout" size={16} />
          </button>
          <a class="cta" href="#/studio" aria-label="פוסט חדש">
            <span>פוסט חדש</span>
            <span class="cta-arrow">
              <Icon name="arrow" size={14} class="ico ico-arrow" />
              <Icon name="plus" size={16} class="ico ico-plus" />
            </span>
          </a>
        </div>
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
        {data && route === 'brand' && <BrandView />}
      </main>
    </>
  );
}
