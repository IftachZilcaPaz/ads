import { addDays, isValidLocal, normalizeLocal, toLocal } from '../../shared/time.ts';

const DAY_WORDS: Record<string, number> = { היום: 0, מחר: 1, מחרתיים: 2 };
const pad = (n: string | number) => String(n).padStart(2, '0');

export type ParsedWhen = { ok: true; value: string } | { ok: false; error: string };

/**
 * Free-text publish time, Israel wall clock. Accepts "19:30", "מחר 9:00",
 * "מחרתיים 19:00", "5.10 19:30", "05/10/2026 19:30" and "2026-10-05 19:30".
 */
export function parseWhen(input: string, now: Date = new Date()): ParsedWhen {
  const text = input.trim().replace(/\s+/g, ' ').replace(/(^| )ב-?(?=\d)/g, '$1');
  const nowLocal = toLocal(now);
  const today = nowLocal.slice(0, 10);
  let value = '';

  const relative = /^(?:(היום|מחרתיים|מחר) ?)?(\d{1,2})[:.](\d{2})$/.exec(text);
  const dated = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))? (\d{1,2})[:.](\d{2})$/.exec(text);
  if (relative) {
    const [, word, hh, mm] = relative as unknown as [string, string | undefined, string, string];
    value = `${addDays(today, word ? DAY_WORDS[word]! : 0)} ${pad(hh)}:${mm}`;
    if (!word && value <= nowLocal) return { ok: false, error: `${pad(hh)}:${mm} כבר עברה היום. כתוב למשל "מחר ${pad(hh)}:${mm}"` };
  } else if (dated) {
    const [, d, m, y, hh, mm] = dated as unknown as [string, string, string, string | undefined, string, string];
    const year = y ? (y.length === 2 ? `20${y}` : y) : today.slice(0, 4);
    value = `${year}-${pad(m)}-${pad(d)} ${pad(hh)}:${mm}`;
    // "5.1" in December means next January.
    if (!y && value <= nowLocal) value = `${Number(year) + 1}${value.slice(4)}`;
  } else {
    value = normalizeLocal(text);
  }

  if (!isValidLocal(value)) return { ok: false, error: 'לא הבנתי את המועד. דוגמאות: 19:30 · מחר 09:00 · 5.10 19:30' };
  if (value <= nowLocal) return { ok: false, error: 'המועד הזה כבר עבר. בחר מועד עתידי' };
  return { ok: true, value };
}

/** A few sensible upcoming slots: the next of 12:00/19:00 today, then tomorrow morning and evening. */
export function suggestedSlots(now: Date = new Date()): { label: string; value: string }[] {
  const nowLocal = toLocal(now);
  const today = nowLocal.slice(0, 10);
  const tomorrow = addDays(today, 1);
  const soon = toLocal(new Date(now.getTime() + 30 * 60_000));
  const slots = [
    { label: 'היום 12:00', value: `${today} 12:00` },
    { label: 'היום 19:00', value: `${today} 19:00` },
    { label: 'מחר 09:00', value: `${tomorrow} 09:00` },
    { label: 'מחר 19:00', value: `${tomorrow} 19:00` },
  ];
  return slots.filter((s) => s.value >= soon).slice(0, 3);
}
