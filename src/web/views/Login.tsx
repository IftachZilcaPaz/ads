import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main class="login">
      <form
        class="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.login(password);
            onSuccess();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span class="brand-mark big">
          <Icon name="camera" size={24} />
        </span>
        <span class="eyebrow">BP Social</span>
        <h1>
          לוח <em>הפרסום</em>
        </h1>
        <label class="field">
          <span>סיסמה</span>
          <input type="password" autoComplete="current-password" autoFocus value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
        </label>
        {error && <p class="err">{error}</p>}
        <button class="primary" disabled={busy || !password}>
          {busy ? 'מתחבר...' : 'כניסה'}
        </button>
      </form>
    </main>
  );
}
