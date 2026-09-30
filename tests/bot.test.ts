import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bot, type BotEvent } from '../src/server/bot/bot.ts';
import type { Keyboard, Telegram } from '../src/server/bot/telegram.ts';
import { parseWhen, suggestedSlots } from '../src/server/bot/when.ts';
import { Store } from '../src/server/store.ts';
import { insertRows, testDb } from './helpers/db.ts';

const CHAT = '356';
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
// 2026-10-01 10:00 in Israel (UTC+3).
const NOW = new Date('2026-10-01T07:00:00Z');

type Sent = { id: number; text: string; keyboard?: Keyboard; photo?: string };

function fakeTelegram() {
  const sent: Sent[] = [];
  const edits: { id: number; text: string }[] = [];
  const cleared: number[] = [];
  const answers: (string | undefined)[] = [];
  let seq = 100;
  const tg: Telegram = {
    send: async (_chat, text, keyboard) => (sent.push({ id: ++seq, text, keyboard }), seq),
    sendPhoto: async (_chat, photo, text, keyboard) => (sent.push({ id: ++seq, text, keyboard, photo }), seq),
    edit: async (_chat, id, text) => void edits.push({ id, text }),
    clearButtons: async (_chat, id) => void cleared.push(id),
    answer: async (_q, text) => void answers.push(text),
  };
  return { tg, sent, edits, cleared, answers, last: () => sent[sent.length - 1]! };
}

let ctx: Awaited<ReturnType<typeof testDb>>;
let store: Store;
let tg: ReturnType<typeof fakeTelegram>;
let bot: Bot;

const send = (e: Omit<BotEvent, 'chat_id'> & Record<string, unknown>) => bot.handle({ chat_id: CHAT, ...e } as BotEvent);
/** Presses the button with this label on the latest message that has it. */
function press(label: string) {
  const msg = [...tg.sent].reverse().find((m) => m.keyboard?.flat().some((b) => b.text === label));
  const button = msg?.keyboard?.flat().find((b) => b.text === label);
  if (!msg || !button) throw new Error(`no button "${label}" in: ${JSON.stringify(tg.sent.map((m) => m.keyboard?.flat().map((b) => b.text)))}`);
  return send({ kind: 'button', data: button.data, message_id: msg.id, query_id: 'q' });
}
const variants = (n = 3) => ({
  image_notes: 'x',
  alt_text: 'x',
  variants: Array.from({ length: n }, (_, i) => ({ angle: `זווית ${i + 1}`, caption: `קפשן ${i + 1}`, hashtags: ['בית'], why: '' })),
});
const onlyPost = async () => (await store.snapshot()).posts.find((p) => p.notes.startsWith('מטלגרם'))!;

beforeAll(async () => {
  ctx = await testDb();
  store = new Store(ctx.db);
});

beforeEach(async () => {
  await ctx.reset();
  await insertRows(ctx.db, 'settings', [
    { key: 'telegram_bot_token', value: 'TOKEN' },
    { key: 'telegram_chat_id', value: CHAT },
    { key: 'app_url', value: 'https://bp.example/' },
  ]);
  await insertRows(ctx.db, 'campaigns', [
    { id: 'winter', name: 'חורף', status: 'active' },
    { id: 'old', name: 'ישן', status: 'ended' },
  ]);
  await insertRows(ctx.db, 'products', [{ id: 'kitchen', name: 'מטבח', status: 'active' }]);
  tg = fakeTelegram();
  let seed = 0;
  bot = new Bot({ db: ctx.db, store, telegram: () => tg.tg, now: () => NOW, random: () => (seed = (seed + 0.137) % 1) });
});

describe('telegram conversation', () => {
  it('asks campaign → product → brief, then writes, picks, schedules and approves', async () => {
    expect(await send({ kind: 'media', media_url: IMG, text: '' })).toEqual({});
    expect(tg.last().text).toContain('לאיזה קמפיין');
    // Only active campaigns are offered.
    expect(tg.last().keyboard!.flat().map((b) => b.text)).toEqual(['חורף', 'בלי קמפיין']);

    await press('חורף');
    expect(tg.edits.at(-1)!.text).toBe('📣 קמפיין: חורף');
    expect(tg.last().text).toContain('איזה מוצר');

    await press('מטבח');
    expect(tg.last().text).toContain('מה חשוב להגיד');

    const reply = await send({ kind: 'text', text: 'לפני ואחרי שיפוץ' });
    expect(reply.generate).toBeDefined();
    expect(reply.generate!.request).toMatchObject({
      media: [IMG],
      post_type: 'POST',
      brief: 'לפני ואחרי שיפוץ',
      campaign: { id: 'winter' },
      product: { id: 'kitchen' },
      variants: 3,
    });
    expect(tg.last().text).toContain('כותב 3 גרסאות');

    await send({ kind: 'variants', nonce: reply.generate!.nonce, result: variants() });
    expect(tg.last().text).toContain('1️⃣ זווית 1\nקפשן 1\n\n#בית');

    await press('2️⃣');
    expect((await onlyPost()).caption).toBe('קפשן 2\n\n#בית');
    expect(tg.last().text).toBe('🗓 מתי לפרסם?');
    // 10:00 now: today 12:00 and 19:00, tomorrow 09:00.
    expect(tg.last().keyboard![0]!.map((b) => b.text)).toEqual(['היום 12:00', 'היום 19:00', 'מחר 09:00']);

    await press('היום 19:00');
    const confirm = tg.last();
    expect(confirm.photo).toContain('/image/upload/w_720,c_limit');
    expect(confirm.text).toContain('🗓 היום ב-19:00');
    expect(confirm.text).toContain('📣 חורף · 🏷 מטבח');

    await press('✅ אשר ותזמן');
    const post = await onlyPost();
    expect(post).toMatchObject({ status: 'ready', publish_at: '2026-10-01 19:00', campaign_id: 'winter', product_id: 'kitchen' });
    expect(post.approved_at).not.toBe('');
    expect(tg.last().text).toContain('✅ מאושר! יעלה היום ב-19:00');
    expect(await ctx.db.query('select * from bot_sessions')).toEqual([]);
  });

  it('skips questions answered by #tags and uses !text verbatim', async () => {
    await send({ kind: 'media', media_url: IMG, text: '#winter #kitchen' });
    expect(tg.sent[0]!.text).toBe('📥 קיבלתי (📣 חורף · 🏷 מטבח). כמה שאלות קצרות:');
    expect(tg.last().text).toContain('מה חשוב להגיד');

    tg.sent.length = 0;
    await send({ kind: 'media', media_url: IMG, text: '!הקפשן שלי בדיוק' });
    expect(tg.last().text).toBe('🗓 מתי לפרסם?');
  });

  it('handles "now", free-text times, and invalid times', async () => {
    await send({ kind: 'media', media_url: IMG, text: '!קפשן' });
    await press('🕐 מועד אחר');
    await send({ kind: 'text', text: '08:00' });
    expect(tg.last().text).toContain('כבר עברה היום');
    await send({ kind: 'text', text: 'מחר ב-8:30' });
    expect(tg.last().text).toContain('🗓 מחר ב-08:30');

    await press('🕐 שנה מועד');
    await press('📤 עכשיו');
    await press('✅ אשר ותזמן');
    expect(tg.last().text).toContain('עולה בדקות הקרובות');
  });

  it('can save as a draft, retry the AI, or take a typed caption', async () => {
    const first = await send({ kind: 'media', media_url: IMG, text: '#winter #kitchen שיפוץ' });
    await send({ kind: 'variants', nonce: first.generate!.nonce, error: 'overloaded' });
    expect(tg.last().text).toContain('overloaded');

    const again = await press('🔄 נסה שוב');
    expect(again.generate!.request.brief).toContain('זוויות שונות');
    await send({ kind: 'variants', nonce: again.generate!.nonce, result: variants(2) });
    await press('✍️ אכתוב בעצמי');
    await send({ kind: 'text', text: 'כתבתי לבד' });
    expect((await onlyPost()).caption).toBe('כתבתי לבד');

    await press('📥 רק לשמור כטיוטה');
    expect((await onlyPost()).status).toBe('draft');
    expect(tg.last().text).toContain('https://bp.example');
  });

  it('ignores stale buttons, double taps, late AI results and strangers', async () => {
    const first = await send({ kind: 'media', media_url: IMG, text: '!א' });
    const oldWhen = tg.last();
    await send({ kind: 'media', media_url: IMG, text: '!ב' }); // new conversation

    await send({ kind: 'button', data: oldWhen.keyboard![1]![0]!.data, message_id: oldWhen.id, query_id: 'q' });
    expect(tg.answers.at(-1)).toBe('השיחה הזו כבר הסתיימה');

    await press('📤 עכשיו');
    const before = tg.sent.length;
    await press('📤 עכשיו'); // same message tapped again
    expect(tg.sent.length).toBe(before);

    expect(await send({ kind: 'variants', nonce: first.generate?.nonce ?? 'zzz', result: variants() })).toEqual({});

    await bot.handle({ kind: 'text', chat_id: '999', text: 'hi' });
    expect(tg.sent.length).toBe(before);
  });

  it('explains itself and can be cancelled', async () => {
    await send({ kind: 'text', text: 'היי' });
    expect(tg.last().text).toContain('שלח לי תמונה');
    await send({ kind: 'media', media_url: IMG, text: '' });
    await send({ kind: 'text', text: 'ביטול' });
    expect(tg.last().text).toContain('עצרתי');
    expect((await onlyPost()).status).toBe('draft');
  });

  it('asks for the bot token when it is missing', async () => {
    await ctx.db.query(`delete from settings where key = 'telegram_bot_token'`);
    await expect(send({ kind: 'text', text: 'x' })).rejects.toThrow(/telegram_bot_token/);
  });
});

describe('when parsing', () => {
  it('understands the usual ways of writing a time', () => {
    expect(parseWhen('19:30', NOW)).toEqual({ ok: true, value: '2026-10-01 19:30' });
    expect(parseWhen('מחר 9:05', NOW)).toEqual({ ok: true, value: '2026-10-02 09:05' });
    expect(parseWhen('מחרתיים ב-19.00', NOW)).toEqual({ ok: true, value: '2026-10-03 19:00' });
    expect(parseWhen('5.10 19:30', NOW)).toEqual({ ok: true, value: '2026-10-05 19:30' });
    expect(parseWhen('1.1 10:00', NOW)).toEqual({ ok: true, value: '2027-01-01 10:00' });
    expect(parseWhen('2026-12-24 20:00', NOW)).toEqual({ ok: true, value: '2026-12-24 20:00' });
    expect(parseWhen('31.02 10:00', NOW).ok).toBe(false);
    expect(parseWhen('אתמול', NOW).ok).toBe(false);
  });

  it('suggests only slots at least 30 minutes away', () => {
    expect(suggestedSlots(new Date('2026-10-01T15:45:00Z')).map((s) => s.label)).toEqual(['מחר 09:00', 'מחר 19:00']);
  });
});
