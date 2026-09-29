import { isValidLocal, normalizeLocal, toLocal } from './time.ts';

/**
 * A row of the `calendar` sheet tab. Every value is a string because that is
 * what Sheets (and n8n) exchange; typed helpers below interpret the fields.
 *
 * Column order: the first nine are the original sheet layout and must stay
 * first so existing n8n mappings keep working. New columns are appended.
 */
export const POST_COLUMNS = [
  'id',
  'publish_at',
  'type',
  'media_urls',
  'caption',
  'approval_mode',
  'status',
  'ig_media_id',
  'error',
  'campaign_id',
  'product_id',
  'approved_at',
  'approval_ref',
  'notes',
  'permalink',
  'created_at',
  'updated_at',
] as const;

export type PostColumn = (typeof POST_COLUMNS)[number];
export type Post = Record<PostColumn, string>;

export const POST_TYPES = ['POST', 'CAROUSEL', 'REEL', 'STORY'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const APPROVAL_MODES = ['approve', 'auto'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * Lifecycle:
 *   draft ──submit──▶ ready (awaiting me) ──approve──▶ ready (approved) ──n8n──▶ publishing ──▶ published | failed
 *                        │                                  ▲
 *                        └─n8n asks on Telegram─▶ pending_approval ─approve─┘   (reject ▶ rejected)
 *
 * A post is published ONLY when status=ready AND it is approved
 * (approved_at set, or approval_mode=auto) AND publish_at has passed.
 */
export const POST_STATUSES = [
  'draft',
  'ready',
  'pending_approval',
  'publishing',
  'published',
  'failed',
  'rejected',
  'archived',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const BUCKETS = ['draft', 'awaiting', 'approved', 'published', 'problem'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const IG_LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  mentions: 20,
  carouselMin: 2,
  carouselMax: 10,
} as const;

export class DomainError extends Error {
  constructor(message: string, readonly issues: string[] = [message]) {
    super(message);
    this.name = 'DomainError';
  }
}

export function emptyPost(): Post {
  return Object.fromEntries(POST_COLUMNS.map((c) => [c, ''])) as Post;
}

export function toPost(record: Record<string, string>): Post {
  const post = emptyPost();
  for (const column of POST_COLUMNS) post[column] = String(record[column] ?? '').trim();
  post.caption = String(record.caption ?? '');
  post.publish_at = normalizeLocal(post.publish_at);
  post.type = (post.type || 'POST').toUpperCase();
  post.status = post.status || 'draft';
  post.approval_mode = post.approval_mode || 'approve';
  return post;
}

export function mediaList(post: Pick<Post, 'media_urls'>): string[] {
  return post.media_urls
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

export function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url) || /\/video\/upload\//.test(url);
}

export function isApproved(post: Pick<Post, 'approval_mode' | 'approved_at'>): boolean {
  return post.approval_mode === 'auto' || post.approved_at.trim() !== '';
}

export function bucketOf(post: Pick<Post, 'status' | 'approval_mode' | 'approved_at'>): Bucket | null {
  switch (post.status as PostStatus) {
    case 'ready':
      return isApproved(post) ? 'approved' : 'awaiting';
    case 'pending_approval':
      return 'awaiting';
    case 'publishing':
    case 'published':
      return 'published';
    case 'failed':
    case 'rejected':
      return 'problem';
    case 'archived':
      return null;
    default:
      return 'draft';
  }
}

/** Replaces long dashes, which the account's style guide bans in captions. */
export function cleanCaption(caption: string): string {
  return caption.replace(/[—–]/g, '-').replace(/\r\n/g, '\n');
}

export function countHashtags(caption: string): number {
  return (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(caption: string): number {
  return (caption.match(/(^|\s)@[\w.]+/g) ?? []).length;
}

/**
 * Everything Instagram (and our publisher) needs before a post may be
 * scheduled. Returns human-readable (Hebrew) issues; empty means valid.
 */
export function scheduleIssues(post: Pick<Post, 'publish_at' | 'type' | 'media_urls' | 'caption'>): string[] {
  const issues: string[] = [];
  if (!isValidLocal(post.publish_at)) issues.push('חסר מועד פרסום תקין (YYYY-MM-DD HH:mm)');

  const type = post.type.toUpperCase();
  if (!(POST_TYPES as readonly string[]).includes(type)) {
    issues.push('סוג הפוסט חייב להיות POST / CAROUSEL / REEL / STORY');
  }

  const urls = mediaList(post);
  if (!urls.length) issues.push('חסרה תמונה או וידאו');
  if (urls.some((u) => !/^https:\/\/\S+$/.test(u))) issues.push('כל קישור מדיה חייב להתחיל ב-https://');

  const videos = urls.filter(isVideoUrl).length;
  if (type === 'POST' && urls.length > 1) issues.push('לכמה תמונות בחר "קרוסלה"');
  if (type === 'POST' && videos) issues.push('וידאו בפיד עולה כריל - בחר "ריל"');
  if (type === 'REEL' && (urls.length !== 1 || videos !== 1)) issues.push('ריל צריך בדיוק וידאו אחד');
  if (type === 'STORY' && urls.length !== 1) issues.push('סטורי צריך בדיוק קובץ אחד');
  if (type === 'CAROUSEL' && (urls.length < IG_LIMITS.carouselMin || urls.length > IG_LIMITS.carouselMax)) {
    issues.push(`קרוסלה צריכה ${IG_LIMITS.carouselMin}-${IG_LIMITS.carouselMax} פריטים`);
  }

  const caption = post.caption;
  if (caption.length > IG_LIMITS.captionChars) {
    issues.push(`הקפשן ארוך מדי (${caption.length}/${IG_LIMITS.captionChars} תווים)`);
  }
  if (countHashtags(caption) > IG_LIMITS.hashtags) issues.push(`יותר מ-${IG_LIMITS.hashtags} האשטגים`);
  if (countMentions(caption) > IG_LIMITS.mentions) issues.push(`יותר מ-${IG_LIMITS.mentions} תיוגים`);
  if (type !== 'STORY' && !caption.trim()) issues.push('חסר קפשן');
  return issues;
}

function assertSchedulable(post: Post): void {
  const issues = scheduleIssues(post);
  if (issues.length) throw new DomainError(issues[0]!, issues);
}

const LOCKED: readonly string[] = ['publishing', 'published', 'archived'];
const CONTENT_FIELDS = ['caption', 'media_urls', 'type'] as const;

export const EDITABLE_FIELDS = [
  'publish_at',
  'type',
  'media_urls',
  'caption',
  'approval_mode',
  'campaign_id',
  'product_id',
  'notes',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type PostChanges = Partial<Pick<Post, EditableField>>;

export function canEdit(post: Pick<Post, 'status'>): boolean {
  return !LOCKED.includes(post.status);
}

function normalizeChanges(changes: PostChanges): PostChanges {
  const out: PostChanges = {};
  for (const field of EDITABLE_FIELDS) {
    const value = changes[field];
    if (value === undefined) continue;
    out[field] = field === 'caption' ? cleanCaption(value) : value.trim();
  }
  if (out.type) out.type = out.type.toUpperCase();
  if (out.media_urls !== undefined) out.media_urls = mediaList({ media_urls: out.media_urls }).join(',');
  if (out.publish_at !== undefined) out.publish_at = normalizeLocal(out.publish_at);
  if (out.approval_mode && !(APPROVAL_MODES as readonly string[]).includes(out.approval_mode)) {
    throw new DomainError('מצב אישור לא חוקי');
  }
  return out;
}

/**
 * Applies user edits. An approval covers specific content, so changing the
 * caption/media/type revokes it; a Telegram request in flight is invalidated.
 */
export function applyEdit(post: Post, changes: PostChanges, now: Date = new Date()): Post {
  if (!canEdit(post)) throw new DomainError('פוסט שפורסם או בתהליך פרסום לא ניתן לעריכה');
  const clean = normalizeChanges(changes);
  const next: Post = { ...post, ...clean };

  const contentChanged = CONTENT_FIELDS.some((f) => clean[f] !== undefined && clean[f] !== post[f]);
  if (contentChanged) next.approved_at = '';
  if (post.status === 'pending_approval') {
    next.status = 'ready';
    next.approval_ref = '';
  }
  if (next.status === 'ready') assertSchedulable(next);
  next.updated_at = toLocal(now);
  return next;
}

export const POST_ACTIONS = ['submit', 'approve', 'unapprove', 'draft', 'archive'] as const;
export type PostAction = (typeof POST_ACTIONS)[number];

/** State transitions triggered from the board (drag & drop or buttons). */
export function transition(post: Post, action: PostAction, now: Date = new Date()): Post {
  const stamp = toLocal(now);
  const next: Post = { ...post, updated_at: stamp };

  switch (action) {
    case 'submit':
    case 'approve': {
      if (!canEdit(post)) throw new DomainError('הפוסט כבר פורסם או בתהליך פרסום');
      assertSchedulable(post);
      next.status = 'ready';
      next.error = '';
      next.approval_ref = '';
      if (action === 'approve') {
        next.approved_at = stamp;
      } else {
        next.approved_at = '';
        if (next.approval_mode === 'auto') next.approval_mode = 'approve';
      }
      return next;
    }
    case 'unapprove': {
      if (!canEdit(post)) throw new DomainError('הפוסט כבר פורסם או בתהליך פרסום');
      next.approved_at = '';
      if (next.approval_mode === 'auto') next.approval_mode = 'approve';
      return next;
    }
    case 'draft': {
      if (!canEdit(post)) throw new DomainError('הפוסט כבר פורסם או בתהליך פרסום');
      next.status = 'draft';
      next.approved_at = '';
      next.approval_ref = '';
      return next;
    }
    case 'archive': {
      if (post.status === 'publishing') throw new DomainError('הפוסט באמצע פרסום');
      next.status = 'archived';
      next.approval_ref = '';
      return next;
    }
  }
}

/** Which transition a board drop into `target` means. */
export function actionForDrop(target: Bucket): PostAction | null {
  switch (target) {
    case 'draft':
      return 'draft';
    case 'awaiting':
      return 'submit';
    case 'approved':
      return 'approve';
    default:
      return null;
  }
}

export function generatePostId(now: Date = new Date(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${toLocal(now).slice(0, 10)}-${suffix}`;
}

export interface NewPostInput extends PostChanges {
  id?: string;
  intent?: 'draft' | 'submit' | 'approve';
}

export function createPost(input: NewPostInput, now: Date = new Date(), id = generatePostId(now)): Post {
  const stamp = toLocal(now);
  const base: Post = {
    ...emptyPost(),
    id: input.id?.trim() || id,
    type: 'POST',
    approval_mode: 'approve',
    status: 'draft',
    created_at: stamp,
    updated_at: stamp,
  };
  const draft = { ...base, ...normalizeChanges(input) };
  if (!/^[\w-]{3,40}$/.test(draft.id)) throw new DomainError('מזהה לא חוקי (אותיות לועזיות, ספרות, - ו-_)');
  const intent = input.intent ?? 'draft';
  return intent === 'draft' ? draft : transition(draft, intent, now);
}
