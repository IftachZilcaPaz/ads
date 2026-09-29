import { useCallback, useMemo, useState } from 'preact/hooks';
import type { Post, PostAction } from '../shared/post.ts';
import { api } from './api.ts';
import { useApp } from './state.tsx';

const ACTION_MESSAGES: Record<PostAction, string> = {
  approve: 'אושר ✅ יעלה בזמן',
  submit: 'ממתין לאישור שלך',
  unapprove: 'האישור בוטל - לא יעלה עד שתאשר',
  draft: 'הוחזר לטיוטות',
  archive: 'הועבר לארכיון',
};

/** Board/calendar actions with optimistic-free, server-confirmed updates. */
export function usePostActions() {
  const { run, upsertPost, toast } = useApp();
  return useCallback(
    async (post: Post, action: PostAction) => {
      const updated = await run(() => api.act(post.id, action), ACTION_MESSAGES[action]);
      if (!updated) return;
      upsertPost(updated);
      if (post.status === 'pending_approval' && action !== 'approve') {
        toast('בקשת האישור שנשלחה בטלגרם בוטלה', 'warn');
      }
    },
    [run, upsertPost, toast],
  );
}

export interface PostFilter {
  campaign: string;
  product: string;
  query: string;
}

export function usePostFilter(posts: Post[]) {
  const [filter, setFilter] = useState<PostFilter>({ campaign: '', product: '', query: '' });
  const filtered = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return posts.filter(
      (p) =>
        (!filter.campaign || p.campaign_id === filter.campaign) &&
        (!filter.product || p.product_id === filter.product) &&
        (!q || p.caption.toLowerCase().includes(q) || p.id.includes(q) || p.notes.toLowerCase().includes(q)),
    );
  }, [posts, filter]);
  return { filter, setFilter, filtered };
}
