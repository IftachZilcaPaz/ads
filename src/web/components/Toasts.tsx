import { useApp } from '../state.tsx';

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
