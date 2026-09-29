/**
 * All scheduling happens in Israel wall-clock time and is stored as the
 * sortable string "YYYY-MM-DD HH:mm" — the same format n8n compares against.
 * Keeping it as text (never a Date cell) avoids Sheets locale/timezone drift.
 */
export const TIME_ZONE = 'Asia/Jerusalem';
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Israel wall-clock "YYYY-MM-DD HH:mm" for the given instant. */
export function toLocal(date: Date = new Date()): string {
  // sv-SE renders "2026-09-01 18:30"; some engines emit "24:00" at midnight.
  return formatter.format(date).replace(' 24:', ' 00:');
}

export function localDate(date: Date = new Date()): string {
  return toLocal(date).slice(0, 10);
}

export function isValidLocal(value: string): boolean {
  if (!LOCAL_DATETIME_RE.test(value)) return false;
  const [d, t] = value.split(' ') as [string, string];
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const [hh, mm] = t.split(':').map(Number) as [number, number];
  if (m < 1 || m > 12 || hh > 23 || mm > 59) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Adds minutes to a local datetime string, preserving wall-clock semantics. */
export function addMinutesLocal(value: string, minutes: number): string {
  const [d, t] = value.split(' ') as [string, string];
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const [hh, mm] = t.split(':').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(y, m - 1, day, hh, mm + minutes));
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

/** Start of the week containing `date`; Israeli calendars start on Sunday. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - utc.getUTCDay());
  return utc.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Tolerates legacy values Sheets may have converted (e.g. "1/9/2026 18:30"). */
export function normalizeLocal(raw: string): string {
  const value = raw.trim().replace(/^'/, '');
  if (!value || LOCAL_DATETIME_RE.test(value)) return value;
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}`;
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s+(\d{1,2}):(\d{2})/.exec(value);
  if (dmy) {
    const [, d, m, y, hh, mm] = dmy as unknown as [string, string, string, string, string, string];
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${hh.padStart(2, '0')}:${mm}`;
  }
  return value;
}
