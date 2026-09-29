/**
 * Board drag & drop, done with raw DOM for 60fps (no re-render while moving).
 * Mouse: drag starts after a 7px move. Touch: long-press (300ms) so normal
 * swipes keep scrolling the board.
 */
export interface DragOptions<T extends string> {
  source: T;
  canDrop: (target: T) => boolean;
  onDrop: (target: T) => void;
  onActive: (active: boolean) => void;
}

const COLUMN_SELECTOR = '[data-drop]';

export function attachDrag<T extends string>(card: HTMLElement, opts: DragOptions<T>): () => void {
  let clone: HTMLElement | null = null;
  let offset = { x: 0, y: 0 };
  let suppressClick = false;

  const columns = () => [...document.querySelectorAll<HTMLElement>(COLUMN_SELECTOR)];
  const targetAt = (x: number, y: number): HTMLElement | null => {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>(COLUMN_SELECTOR) ?? null;
    return col && opts.canDrop(col.dataset.drop as T) ? col : null;
  };

  function begin(x: number, y: number) {
    const rect = card.getBoundingClientRect();
    offset = { x: x - rect.left, y: y - rect.top };
    clone = card.cloneNode(true) as HTMLElement;
    clone.classList.add('drag-clone');
    clone.style.width = `${rect.width}px`;
    document.body.appendChild(clone);
    card.classList.add('ghost');
    document.body.classList.add('dragging');
    for (const col of columns()) if (opts.canDrop(col.dataset.drop as T)) col.classList.add('drop-target');
    navigator.vibrate?.(12);
    opts.onActive(true);
    move(x, y);
  }

  function move(x: number, y: number) {
    if (!clone) return;
    clone.style.left = `${x - offset.x}px`;
    clone.style.top = `${y - offset.y}px`;
    const board = card.closest<HTMLElement>('.board');
    if (board) {
      if (x < 60) board.scrollBy({ left: -14 });
      else if (x > window.innerWidth - 60) board.scrollBy({ left: 14 });
    }
    const hot = targetAt(x, y);
    for (const col of columns()) col.classList.toggle('drop-hot', col === hot);
  }

  function finish(x: number | null, y: number | null) {
    if (!clone) return;
    const target = x === null || y === null ? null : targetAt(x, y);
    clone.remove();
    clone = null;
    card.classList.remove('ghost');
    document.body.classList.remove('dragging');
    for (const col of columns()) col.classList.remove('drop-target', 'drop-hot');
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 350);
    opts.onActive(false);
    const key = target?.dataset.drop as T | undefined;
    if (key && key !== opts.source) opts.onDrop(key);
  }

  // ----- mouse -----
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return;
        started = true;
        begin(ev.clientX, ev.clientY);
      }
      move(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (started) finish(ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ----- touch: long press -----
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touchActive = false;
  let start = { x: 0, y: 0 };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || (e.target as HTMLElement).closest('button, a')) return;
    start = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    touchActive = false;
    timer = setTimeout(() => {
      touchActive = true;
      begin(start.x, start.y);
    }, 300);
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0]!;
    if (!touchActive) {
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) clearTimeout(timer);
      return;
    }
    e.preventDefault();
    move(t.clientX, t.clientY);
  };
  const onTouchEnd = (e: TouchEvent) => {
    clearTimeout(timer);
    if (!touchActive) return;
    touchActive = false;
    const t = e.changedTouches[0];
    finish(t?.clientX ?? null, t?.clientY ?? null);
  };
  const onTouchCancel = () => {
    clearTimeout(timer);
    if (touchActive) finish(null, null);
    touchActive = false;
  };
  const onClickCapture = (e: MouseEvent) => {
    if (suppressClick) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };
  const onContextMenu = (e: Event) => touchActive && e.preventDefault();

  card.addEventListener('pointerdown', onPointerDown);
  card.addEventListener('touchstart', onTouchStart, { passive: true });
  card.addEventListener('touchmove', onTouchMove, { passive: false });
  card.addEventListener('touchend', onTouchEnd);
  card.addEventListener('touchcancel', onTouchCancel);
  card.addEventListener('click', onClickCapture, true);
  card.addEventListener('contextmenu', onContextMenu);

  return () => {
    clearTimeout(timer);
    finish(null, null);
    card.removeEventListener('pointerdown', onPointerDown);
    card.removeEventListener('touchstart', onTouchStart);
    card.removeEventListener('touchmove', onTouchMove);
    card.removeEventListener('touchend', onTouchEnd);
    card.removeEventListener('touchcancel', onTouchCancel);
    card.removeEventListener('click', onClickCapture, true);
    card.removeEventListener('contextmenu', onContextMenu);
  };
}
