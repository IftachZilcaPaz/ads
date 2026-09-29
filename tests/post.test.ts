import { describe, expect, it } from 'vitest';
import {
  DomainError,
  actionForDrop,
  applyEdit,
  bucketOf,
  createPost,
  emptyPost,
  isApproved,
  scheduleIssues,
  toPost,
  transition,
  type Post,
} from '../src/shared/post.ts';
import { addMinutesLocal, isValidLocal, normalizeLocal, toLocal, weekStart } from '../src/shared/time.ts';

const NOW = new Date('2026-09-29T09:00:00Z'); // 12:00 in Israel (IDT, UTC+3)
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
const IMG2 = 'https://res.cloudinary.com/demo/image/upload/v1/b.jpg';
const VID = 'https://res.cloudinary.com/demo/video/upload/v1/c.mp4';

function post(over: Partial<Post> = {}): Post {
  return {
    ...emptyPost(),
    id: '2026-09-29-abcd',
    publish_at: '2026-10-01 19:00',
    type: 'POST',
    media_urls: IMG,
    caption: 'שלום עולם',
    approval_mode: 'approve',
    status: 'draft',
    ...over,
  };
}

describe('time', () => {
  it('formats Israel wall-clock time', () => {
    expect(toLocal(NOW)).toBe('2026-09-29 12:00');
    expect(toLocal(new Date('2026-12-01T10:00:00Z'))).toBe('2026-12-01 12:00'); // IST, UTC+2
  });
  it('validates calendar dates strictly', () => {
    expect(isValidLocal('2026-02-29 10:00')).toBe(false);
    expect(isValidLocal('2028-02-29 10:00')).toBe(true);
    expect(isValidLocal('2026-09-01 24:00')).toBe(false);
  });
  it('normalizes legacy sheet formats', () => {
    expect(normalizeLocal("'2026-09-01 18:30")).toBe('2026-09-01 18:30');
    expect(normalizeLocal('1/9/2026 18:30:00')).toBe('2026-09-01 18:30');
    expect(normalizeLocal('2026-09-01T18:30:00')).toBe('2026-09-01 18:30');
  });
  it('does calendar arithmetic', () => {
    expect(addMinutesLocal('2026-09-30 23:30', 45)).toBe('2026-10-01 00:15');
    expect(weekStart('2026-09-29')).toBe('2026-09-27'); // Sunday
  });
});

describe('approval & buckets', () => {
  it('treats auto mode and approved_at as approval', () => {
    expect(isApproved(post())).toBe(false);
    expect(isApproved(post({ approval_mode: 'auto' }))).toBe(true);
    expect(isApproved(post({ approved_at: '2026-09-29 12:00' }))).toBe(true);
  });
  it('maps statuses to board columns', () => {
    expect(bucketOf(post())).toBe('draft');
    expect(bucketOf(post({ status: 'ready' }))).toBe('awaiting');
    expect(bucketOf(post({ status: 'ready', approved_at: 'x' }))).toBe('approved');
    expect(bucketOf(post({ status: 'pending_approval' }))).toBe('awaiting');
    expect(bucketOf(post({ status: 'publishing' }))).toBe('published');
    expect(bucketOf(post({ status: 'rejected' }))).toBe('problem');
    expect(bucketOf(post({ status: 'archived' }))).toBeNull();
    expect(bucketOf(post({ status: 'weird' }))).toBe('draft');
  });
  it('maps drops to actions', () => {
    expect(actionForDrop('approved')).toBe('approve');
    expect(actionForDrop('awaiting')).toBe('submit');
    expect(actionForDrop('published')).toBeNull();
  });
});

describe('scheduleIssues', () => {
  it('accepts a valid post', () => {
    expect(scheduleIssues(post())).toEqual([]);
  });
  it('enforces type/media rules', () => {
    expect(scheduleIssues(post({ media_urls: `${IMG},${IMG2}` }))).toContain('לכמה תמונות בחר "קרוסלה"');
    expect(scheduleIssues(post({ type: 'CAROUSEL' }))[0]).toMatch(/קרוסלה צריכה/);
    expect(scheduleIssues(post({ type: 'CAROUSEL', media_urls: `${IMG},${VID}` }))).toEqual([]);
    expect(scheduleIssues(post({ type: 'REEL' }))).toContain('ריל צריך בדיוק וידאו אחד');
    expect(scheduleIssues(post({ type: 'REEL', media_urls: VID }))).toEqual([]);
    expect(scheduleIssues(post({ media_urls: 'http://insecure/x.jpg' }))).toContain('כל קישור מדיה חייב להתחיל ב-https://');
    expect(scheduleIssues(post({ type: 'STORY', caption: '' }))).toEqual([]);
  });
  it('enforces Instagram caption limits', () => {
    expect(scheduleIssues(post({ caption: 'x'.repeat(2201) }))[0]).toMatch(/ארוך מדי/);
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    expect(scheduleIssues(post({ caption: tags }))).toContain('יותר מ-30 האשטגים');
    expect(scheduleIssues(post({ publish_at: '' }))[0]).toMatch(/מועד/);
  });
});

describe('transitions', () => {
  it('approve stamps approval and makes the post ready', () => {
    const next = transition(post({ status: 'pending_approval', approval_ref: 'r1', error: 'x' }), 'approve', NOW);
    expect(next).toMatchObject({ status: 'ready', approved_at: '2026-09-29 12:00', approval_ref: '', error: '' });
  });
  it('submit clears approval (awaiting me) and turns auto into approve', () => {
    const next = transition(post({ approval_mode: 'auto', approved_at: 'x' }), 'submit', NOW);
    expect(next).toMatchObject({ status: 'ready', approved_at: '', approval_mode: 'approve' });
    expect(bucketOf(next)).toBe('awaiting');
  });
  it('refuses to schedule invalid posts', () => {
    expect(() => transition(post({ media_urls: '' }), 'approve', NOW)).toThrow(DomainError);
  });
  it('locks published and publishing posts', () => {
    expect(() => transition(post({ status: 'published' }), 'draft', NOW)).toThrow(DomainError);
    expect(() => transition(post({ status: 'publishing' }), 'archive', NOW)).toThrow(DomainError);
    expect(transition(post({ status: 'published' }), 'archive', NOW).status).toBe('archived');
  });
});

describe('applyEdit', () => {
  it('revokes approval when content changes', () => {
    const approved = post({ status: 'ready', approved_at: 'x' });
    expect(applyEdit(approved, { caption: 'חדש' }, NOW).approved_at).toBe('');
    expect(applyEdit(approved, { publish_at: '2026-10-02 10:00' }, NOW).approved_at).toBe('x');
    expect(applyEdit(approved, { caption: approved.caption }, NOW).approved_at).toBe('x');
  });
  it('invalidates an in-flight Telegram approval request', () => {
    const next = applyEdit(post({ status: 'pending_approval', approval_ref: 'abc' }), { notes: 'n' }, NOW);
    expect(next).toMatchObject({ status: 'ready', approval_ref: '' });
  });
  it('cleans long dashes and validates scheduled posts', () => {
    expect(applyEdit(post(), { caption: 'a — b – c' }, NOW).caption).toBe('a - b - c');
    expect(() => applyEdit(post({ status: 'ready' }), { media_urls: '' }, NOW)).toThrow(DomainError);
    expect(applyEdit(post(), { media_urls: '' }, NOW).media_urls).toBe('');
  });
});

describe('createPost', () => {
  it('creates drafts with generated ids', () => {
    const p = createPost({ caption: 'x' }, NOW, '2026-09-29-zzzz');
    expect(p).toMatchObject({ id: '2026-09-29-zzzz', status: 'draft', approval_mode: 'approve', created_at: '2026-09-29 12:00' });
  });
  it('can create an already approved post', () => {
    const p = createPost({ publish_at: '2026-10-01 19:00', media_urls: IMG, caption: 'x', intent: 'approve' }, NOW);
    expect(bucketOf(p)).toBe('approved');
  });
  it('rejects unsafe ids', () => {
    expect(() => createPost({ id: '../etc' }, NOW)).toThrow(DomainError);
  });
  it('parses legacy rows', () => {
    expect(toPost({ id: 'a', type: 'reel', publish_at: "'2026-09-01 18:30" })).toMatchObject({
      type: 'REEL',
      status: 'draft',
      approval_mode: 'approve',
      publish_at: '2026-09-01 18:30',
    });
  });
});
