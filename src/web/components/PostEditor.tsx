import type { Post } from '../../shared/post.ts';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { Modal } from './Modal.tsx';
import { PostForm } from './PostForm.tsx';

interface Props {
  post: Post | null;
  initial?: Partial<Post>;
  onClose: () => void;
}

export function PostEditor({ post, initial, onClose }: Props) {
  const { run, upsertPost } = useApp();
  const title = post ? (post.status === 'published' ? `פורסם · ${post.id}` : `עריכה · ${post.id}`) : 'פוסט חדש';

  async function duplicate() {
    const copy = await run(() => api.duplicate(post!.id), 'נוצר עותק בטיוטות');
    if (copy) {
      upsertPost(copy);
      onClose();
    }
  }

  async function archive() {
    if (!confirm('להעביר לארכיון? (לא מוחק פוסט שכבר עלה לאינסטגרם)')) return;
    const archived = await run(() => api.act(post!.id, 'archive'), 'הועבר לארכיון');
    if (archived) {
      upsertPost(archived);
      onClose();
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        post && (
          <div class="row">
            <button type="button" onClick={() => void duplicate()}>
              ⧉ שכפול
            </button>
            {post.status !== 'publishing' && post.status !== 'archived' && (
              <button type="button" class="danger-text" onClick={() => void archive()}>
                🗄 ארכיון
              </button>
            )}
          </div>
        )
      }
    >
      <PostForm post={post} initial={initial} onDone={onClose} />
    </Modal>
  );
}
