import { useEffect, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler } from './api.ts';
import { Toasts } from './components/Toasts.tsx';
import { useLocation, type Route } from './router.ts';
import { AppProvider, useApp } from './state.tsx';
import { cx } from './ui.ts';
import { Board } from './views/Board.tsx';
import { BrandView } from './views/BrandView.tsx';
import { Calendar } from './views/Calendar.tsx';
import { Library } from './views/Library.tsx';
import { Login } from './views/Login.tsx';
import { Studio } from './views/Studio.tsx';

const NAV: { route: Route; label: string }[] = [
  { route: 'board', label: '🗂 לוח' },
  { route: 'calendar', label: '📅 יומן' },
  { route: 'studio', label: '✨ סטודיו' },
  { route: 'library', label: '📣 קמפיינים ומוצרים' },
  { route: 'brand', label: '🎙 מותג' },
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
        <nav>
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} class={cx(route === n.route && 'active')}>
              {n.label}
            </a>
          ))}
        </nav>
        <div class="topbar-actions">
          <button type="button" class="icon" title="רענון" onClick={() => void reload()}>
            🔄
          </button>
          <button
            type="button"
            class="icon"
            title="יציאה"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              onLogout();
            }}
          >
            ⎋
          </button>
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
