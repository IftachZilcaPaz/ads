import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Brand, Campaign, Product } from '../shared/catalog.ts';
import type { Post } from '../shared/post.ts';
import { api, ApiError, type Snapshot } from './api.ts';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'warn';
}

interface AppState {
  data: Snapshot | null;
  loadError: string | null;
  reload: () => Promise<void>;
  upsertPost: (post: Post) => void;
  removePosts: (ids: string[]) => void;
  upsertCampaign: (c: Campaign, previousId?: string) => void;
  upsertProduct: (p: Product, previousId?: string) => void;
  setBrand: (b: Brand) => void;
  toasts: Toast[];
  toast: (message: string, kind?: Toast['kind']) => void;
  /** Runs an async action and reports failures as a toast; returns undefined on error. */
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  /** Pauses background refresh (while a modal is open or a card is dragged). */
  holdRefresh: (on: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

function upsert<T>(list: T[], item: T, key: (t: T) => string, previousKey = key(item)): T[] {
  const i = list.findIndex((x) => key(x) === previousKey);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

const REFRESH_MS = 60_000;

export function AppProvider({ children }: { children: ComponentChildren }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const holds = useRef(0);
  const toastId = useRef(0);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  const reload = useCallback(async () => {
    try {
      setData(await api.bootstrap());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (success) toast(success);
        return result;
      } catch (err) {
        const msg = err instanceof ApiError && err.details.length > 1 ? `${err.message} (+${err.details.length - 1})` : err instanceof Error ? err.message : String(err);
        toast(msg, 'error');
        return undefined;
      }
    },
    [toast],
  );

  const holdRefresh = useCallback((on: boolean) => {
    holds.current = Math.max(0, holds.current + (on ? 1 : -1));
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (holds.current === 0 && document.visibilityState === 'visible') void reload();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && holds.current === 0 && void reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  const value = useMemo<AppState>(
    () => ({
      data,
      loadError,
      reload,
      toasts,
      toast,
      run,
      upsertPost: (post) => setData((d) => d && { ...d, posts: upsert(d.posts, post, (p) => p.id) }),
      removePosts: (ids) => {
        const gone = new Set(ids);
        setData((d) => d && { ...d, posts: d.posts.filter((p) => !gone.has(p.id)) });
      },
      upsertCampaign: (c, prev) => setData((d) => d && { ...d, campaigns: upsert(d.campaigns, c, (x) => x.id, prev ?? c.id) }),
      upsertProduct: (p, prev) => setData((d) => d && { ...d, products: upsert(d.products, p, (x) => x.id, prev ?? p.id) }),
      setBrand: (brand) => setData((d) => d && { ...d, brand }),
      holdRefresh,
    }),
    [data, loadError, reload, toasts, toast, run, holdRefresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Keeps background refresh paused while the calling component is mounted. */
export function useHoldRefresh(active = true): void {
  const { holdRefresh } = useApp();
  useEffect(() => {
    if (!active) return;
    holdRefresh(true);
    return () => holdRefresh(false);
  }, [active, holdRefresh]);
}
