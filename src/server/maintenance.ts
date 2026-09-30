import { isApproved, toPost, type Post } from '../shared/post.ts';
import type { Db } from './db/db.ts';

/**
 * Scheduled posts whose time has passed but that were never published.
 * Approved ones would go out on the publisher's next run; unapproved ones
 * would trigger an approval request right away.
 */
export async function overduePosts(db: Db): Promise<(Post & { approved: boolean })[]> {
  const rows = await db.query<Record<string, string>>(
    `select * from posts
      where status in ('ready', 'pending_approval') and publish_at <> '' and publish_at <= il_now()
      order by publish_at`,
  );
  return rows.map((r) => {
    const post = toPost(r);
    return { ...post, approved: isApproved(post) };
  });
}
