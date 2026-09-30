/**
 * Posts whose publish time has passed but were never published.
 *   npm run db:overdue                  list them (nothing changes)
 *   npm run db:overdue -- --draft       move them all back to drafts
 *   npm run db:overdue -- --archive     archive them all
 */
import { createPostgresDb } from '../src/server/db/postgres.ts';
import { overduePosts } from '../src/server/maintenance.ts';
import { Store } from '../src/server/store.ts';
import { databaseUrl, fail } from './cli-env.ts';

const action = process.argv.includes('--archive') ? 'archive' : process.argv.includes('--draft') ? 'draft' : null;
const db = createPostgresDb(databaseUrl());

try {
  const posts = await overduePosts(db);
  if (!posts.length) {
    console.log('✅ No overdue posts');
  } else {
    for (const p of posts) {
      const tag = p.approved ? 'APPROVED - would publish now' : p.status === 'pending_approval' ? 'waiting in Telegram' : 'not approved';
      console.log(`• ${p.publish_at}  ${p.id}  [${tag}]  ${p.caption.replace(/\s+/g, ' ').slice(0, 50)}`);
    }
    if (!action) {
      console.log(`\n${posts.length} overdue. Nothing changed. Add -- --draft or -- --archive to move them all.`);
    } else {
      const { updated, failed } = await new Store(db).bulkAct(posts.map((p) => p.id), action);
      console.log(`\n✅ ${updated.length} moved to ${action === 'draft' ? 'drafts' : 'archive'}`);
      for (const f of failed) console.log(`⚠️ ${f.id}: ${f.error}`);
    }
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.close();
}
