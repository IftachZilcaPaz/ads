import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { useHoldRefresh } from '../state.tsx';

interface Props {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: Props) {
  useHoldRefresh();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <header class="modal-head">
          <h3>{title}</h3>
          <button class="icon" onClick={onClose} aria-label="סגירה">
            ✕
          </button>
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer class="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
