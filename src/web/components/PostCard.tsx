import { useEffect, useRef } from 'preact/hooks';
import { actionForDrop, bucketOf, canEdit, mediaList, type Bucket, type Post, type PostAction, type PostType } from '../../shared/post.ts';
import { attachDrag } from '../drag.ts';
import { useApp } from '../state.tsx';
import { TYPE_LABEL, cx, formatWhen, isOverdue, isVideoUrl, thumbUrl } from '../ui.ts';

interface Props {
  post: Post;
  onOpen: (post: Post) => void;
  onAction: (post: Post, action: PostAction) => void;
  /** Selection mode: a click toggles the card instead of opening it, and dragging is off. */
  selection?: { selected: boolean; onToggle: (post: Post) => void };
}

const DROPPABLE: Bucket[] = ['draft', 'awaiting', 'approved'];

export function PostCard({ post, onOpen, onAction, selection }: Props) {
  const { data, holdRefresh } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const bucket = bucketOf(post)!;
  const movable = canEdit(post);
  const media = mediaList(post);
  const first = media[0];
  const campaign = data?.campaigns.find((c) => c.id === post.campaign_id);
  const product = data?.products.find((p) => p.id === post.product_id);

  useEffect(() => {
    if (!movable || selection || !ref.current) return;
    return attachDrag<Bucket>(ref.current, {
      source: bucket,
      canDrop: (target) => DROPPABLE.includes(target) && target !== bucket,
      onDrop: (target) => {
        const action = actionForDrop(target);
        if (action) onAction(post, action);
      },
      onActive: holdRefresh,
    });
  }, [post, bucket, movable, onAction, holdRefresh, !!selection]);

  const overdue = (bucket === 'awaiting' || bucket === 'approved') && isOverdue(post.publish_at);
  const activate = () => (selection ? selection.onToggle(post) : onOpen(post));

  return (
    <div
      ref={ref}
      class={cx('card', movable && !selection && 'movable', selection && 'selectable', selection?.selected && 'selected')}
      onClick={activate}
      role={selection ? 'checkbox' : 'button'}
      aria-checked={selection ? selection.selected : undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (selection && e.key === ' ')) {
          e.preventDefault();
          activate();
        }
      }}
    >
      {first && (
        <div class="thumb">
          <img src={thumbUrl(first)} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
          {media.length > 1 && <span class="media-badge">1/{media.length}</span>}
          {isVideoUrl(first) && <span class="media-badge play">▶</span>}
        </div>
      )}
      <div class="meta">
        {selection && <span class="check" aria-hidden="true">{selection.selected ? '✓' : ''}</span>}
        <span class="badge">{TYPE_LABEL[post.type as PostType] ?? post.type}</span>
        {post.approval_mode === 'auto' && <span class="badge accent">אישור קבוע</span>}
        {post.status === 'pending_approval' && <span class="badge warn">בטלגרם</span>}
        <span class={cx('when', overdue && 'overdue')}>{formatWhen(post.publish_at)}</span>
      </div>
      {(campaign || product) && (
        <div class="meta">
          {campaign && <span class="tag">📣 {campaign.name}</span>}
          {product && <span class="tag">🏷 {product.name}</span>}
        </div>
      )}
      {post.caption && <div class="cap">{post.caption}</div>}
      {post.error && bucket === 'problem' && <div class="err">{post.error}</div>}

      {!selection && (
      <div class="card-actions">
        {bucket === 'draft' && (
          <button type="button" onClick={(e) => (e.stopPropagation(), onAction(post, 'submit'))}>
            לאישור שלי
          </button>
        )}
        {(bucket === 'awaiting' || bucket === 'problem') && (
          <button type="button" class="approve" onClick={(e) => (e.stopPropagation(), onAction(post, 'approve'))}>
            ✅ אשר
          </button>
        )}
        {bucket === 'approved' && post.approval_mode !== 'auto' && (
          <button type="button" onClick={(e) => (e.stopPropagation(), onAction(post, 'unapprove'))}>
            ↩ בטל אישור
          </button>
        )}
        {post.permalink && (
          <a href={post.permalink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            באינסטגרם ↗
          </a>
        )}
      </div>
      )}
    </div>
  );
}
