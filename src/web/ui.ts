import { cloudinaryStill } from '../shared/media.ts';
import { isVideoUrl, type Bucket, type PostType } from '../shared/post.ts';
import { addDays, localDate, toLocal } from '../shared/time.ts';

export const BUCKET_META: Record<Bucket, { title: string; hint: string; color: string }> = {
  draft: { title: 'טיוטות', hint: 'לא יעלו לעולם', color: 'var(--c-draft)' },
  awaiting: { title: 'ממתין לאישור שלי', hint: 'לא יעלו בלי אישור', color: 'var(--c-awaiting)' },
  approved: { title: 'מאושר ומתוזמן', hint: 'יעלו אוטומטית בזמן', color: 'var(--c-approved)' },
  published: { title: 'פורסם', hint: '', color: 'var(--c-published)' },
  problem: { title: 'נכשל / נדחה', hint: 'דורש טיפול', color: 'var(--c-problem)' },
};

export const TYPE_LABEL: Record<PostType, string> = {
  POST: 'פוסט',
  CAROUSEL: 'קרוסלה',
  REEL: 'ריל',
  STORY: 'סטורי',
};

const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const WEEKDAY_HEADERS = WEEKDAYS;

export function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** "היום 19:00" / "מחר 09:30" / "יום ה׳ 02.10 19:00". */
export function formatWhen(local: string): string {
  if (!local) return 'ללא מועד';
  const [date, time] = local.split(' ') as [string, string];
  const today = localDate();
  const [, m, d] = date.split('-');
  if (date === today) return `היום ${time}`;
  if (date === addDays(today, 1)) return `מחר ${time}`;
  if (date === addDays(today, -1)) return `אתמול ${time}`;
  return `יום ${weekday(date)} ${d}.${m} ${time}`;
}

export function isOverdue(local: string): boolean {
  return !!local && local <= toLocal();
}

export function thumbUrl(url: string, width = 480): string {
  return cloudinaryStill(url, width);
}

export { isVideoUrl };

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function pluralPosts(n: number): string {
  return n === 1 ? 'פוסט אחד' : `${n} פוסטים`;
}
