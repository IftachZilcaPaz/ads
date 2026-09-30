import { z } from 'zod';
import { CaptionResultSchema, composeCaption, type CaptionRequest } from '../../shared/captions.ts';
import type { Campaign, Product } from '../../shared/catalog.ts';
import { cloudinaryStill } from '../../shared/media.ts';
import { DomainError, toPost, type Post } from '../../shared/post.ts';
import { addDays, toLocal } from '../../shared/time.ts';
import type { Db } from '../db/db.ts';
import { HttpError } from '../http.ts';
import type { Store } from '../store.ts';
import type { Keyboard, Telegram } from './telegram.ts';
import { parseWhen, suggestedSlots } from './when.ts';

/** What n8n forwards from Telegram (media is already uploaded to Cloudinary). */
export const BotEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('media'),
    chat_id: z.coerce.string(),
    media_url: z.string().url().startsWith('https://'),
    is_video: z.coerce.boolean().default(false),
    text: z.string().max(4000).default(''),
  }),
  z.object({ kind: z.literal('text'), chat_id: z.coerce.string(), text: z.string().max(4000) }),
  z.object({
    kind: z.literal('button'),
    chat_id: z.coerce.string(),
    data: z.string().max(64),
    message_id: z.coerce.number().int(),
    query_id: z.string(),
  }),
  z.object({
    kind: z.literal('variants'),
    chat_id: z.coerce.string(),
    nonce: z.string().max(16),
    result: z.unknown().optional(),
    error: z.string().max(1000).optional(),
  }),
]);
export type BotEvent = z.input<typeof BotEventSchema>;

/** Returned to n8n: when set, n8n asks /api/captions and posts back a `variants` event. */
export interface BotReply {
  generate?: { nonce: string; request: CaptionRequest };
}

type Step = 'format' | 'campaign' | 'product' | 'brief' | 'writing' | 'pick' | 'own_caption' | 'when' | 'when_text' | 'confirm' | 'busy';

interface SessionData {
  brief: string;
  asked: { format?: boolean; campaign?: boolean; product?: boolean; brief?: boolean };
  /** The caption was given with "!" - no AI questions. */
  verbatim?: boolean;
  campaigns: { id: string; name: string }[];
  products: { id: string; name: string }[];
  variants: { angle: string; caption: string }[];
  publish_at: string;
  /** The message whose buttons are live; cleared when the question is answered. */
  question_id?: number;
}

interface Session {
  chat_id: string;
  nonce: string;
  post_id: string;
  step: Step;
  data: SessionData;
}

/** Steps where a typed message is the answer. */
const TEXT_STEPS: readonly Step[] = ['brief', 'own_caption', 'when_text'];
const CANCEL = /^(\/cancel|ביטול|בטל|עצור|stop)$/i;
const HELP = [
  'שלח לי תמונה או וידאו, ואשאל כמה שאלות קצרות:',
  '📐 פוסט או סטורי · 📣 קמפיין · 🏷 מוצר · ✍️ מה חשוב להגיד',
  'אחר כך אכתוב 3 גרסאות, תבחר אחת ותקבע מתי זה עולה.',
  '',
  'קיצורים בטקסט של התמונה:',
  '• #מזהה-קמפיין / #מזהה-מוצר - בלי לשאול',
  '• טקסט חופשי - בריף ל-AI',
  '• טקסט שמתחיל ב-! - הקפשן עצמו, בלי AI',
  '',
  '"ביטול" עוצר את השיחה (הטיוטה נשארת בלוח).',
].join('\n');

const btn = (nonce: string, label: string, ...parts: (string | number)[]) => ({ text: label, data: ['b', nonce, ...parts].join('|') });
const rows = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DIGITS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
const FORMATS = ['POST', 'REEL', 'STORY'] as const;
type Format = (typeof FORMATS)[number];
const FORMAT_LABEL: Record<Format, string> = { POST: '🖼 פוסט בפיד', REEL: '🎬 ריל', STORY: '📱 סטורי' };

export interface BotDeps {
  db: Db;
  store: Store;
  telegram: (token: string) => Telegram;
  now?: () => Date;
  random?: () => number;
}

/**
 * The Telegram conversation: a small state machine persisted in
 * `bot_sessions`. Every transition is a compare-and-set on (nonce, step), so
 * double taps and late AI results cannot advance a conversation twice.
 */
export class Bot {
  constructor(private readonly deps: BotDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async handle(raw: unknown): Promise<BotReply> {
    const event = BotEventSchema.parse(raw);
    const settings = await this.settings();
    if (!settings.telegram_bot_token) throw new HttpError(503, 'Missing setting telegram_bot_token (npm run db:set -- telegram_bot_token <token>)');
    if (settings.telegram_chat_id && event.chat_id !== settings.telegram_chat_id) return {};
    const ctx = { tg: this.deps.telegram(settings.telegram_bot_token), chat: event.chat_id, appUrl: (settings.app_url ?? '').replace(/\/+$/, '') };

    switch (event.kind) {
      case 'media':
        return this.onMedia(ctx, event.media_url, event.is_video, event.text);
      case 'text':
        return this.onText(ctx, event.text.trim());
      case 'button':
        return this.onButton(ctx, event.data, event.message_id, event.query_id);
      case 'variants':
        return this.onVariants(ctx, event.nonce, event.result, event.error);
    }
  }

  // ---------- events ----------

  private async onMedia(ctx: Ctx, mediaUrl: string, isVideo: boolean, text: string): Promise<BotReply> {
    const snap = await this.deps.store.snapshot();
    const campaigns = snap.campaigns.filter((c) => c.status === 'active');
    const products = snap.products.filter((p) => p.status === 'active');

    const verbatim = text.startsWith('!');
    const tags = [...text.matchAll(/#([a-z0-9][a-z0-9_-]{1,39})/gi)].map((m) => m[1]!.toLowerCase());
    const campaign = campaigns.find((c) => tags.includes(c.id));
    const product = products.find((p) => tags.includes(p.id));
    const brief = verbatim ? '' : text.replace(/#[a-z0-9][a-z0-9_-]{1,39}/gi, ' ').replace(/\s+/g, ' ').trim();

    const post = await this.deps.store.createPost({
      type: isVideo ? 'REEL' : 'POST',
      media_urls: mediaUrl,
      caption: verbatim ? text.slice(1).trim() : '',
      campaign_id: campaign?.id ?? '',
      product_id: product?.id ?? '',
      notes: brief ? clip(`מטלגרם: ${brief}`, 500) : 'מטלגרם',
    });

    const session: Session = {
      chat_id: ctx.chat,
      nonce: this.nonce(),
      post_id: post.id,
      step: 'format',
      data: {
        brief,
        asked: { campaign: !!campaign, product: !!product, brief: !!brief },
        verbatim,
        campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })).slice(0, 12),
        products: products.map((p) => ({ id: p.id, name: p.name })).slice(0, 12),
        variants: [],
        publish_at: '',
      },
    };
    // A new photo replaces any conversation in progress; its buttons go stale.
    await this.deps.db.query(
      `insert into bot_sessions (chat_id, nonce, post_id, step, data, updated_at) values ($1, $2, $3, $4, $5::text::jsonb, now())
       on conflict (chat_id) do update set nonce = excluded.nonce, post_id = excluded.post_id, step = excluded.step,
         data = excluded.data, updated_at = now()`,
      [session.chat_id, session.nonce, session.post_id, session.step, JSON.stringify(session.data)],
    );

    const tagged = [campaign && `📣 ${campaign.name}`, product && `🏷 ${product.name}`].filter(Boolean).join(' · ');
    await ctx.tg.send(ctx.chat, `📥 קיבלתי${tagged ? ` (${tagged})` : ''}. כמה שאלות קצרות:`);
    return this.next(ctx, session, post);
  }

  private async onText(ctx: Ctx, text: string): Promise<BotReply> {
    const session = await this.load(ctx.chat);
    if (CANCEL.test(text)) {
      if (session) await this.end(ctx, session);
      await ctx.tg.send(ctx.chat, session ? '👌 עצרתי. הטיוטה נשארה בלוח.' : '👌');
      return {};
    }
    if (!session || !TEXT_STEPS.includes(session.step)) {
      await ctx.tg.send(ctx.chat, session ? 'בחר אחת מהאפשרויות בהודעה האחרונה 👆 או כתוב "ביטול".' : HELP);
      return {};
    }

    if (session.step === 'brief') {
      const next = await this.advance(session, 'brief', { brief: clip(text, 1500) });
      if (!next) return {};
      await this.retire(ctx, session, `✍️ ${clip(text, 200)}`);
      return this.next(ctx, next);
    }
    if (session.step === 'own_caption') {
      const next = await this.advance(session, 'own_caption');
      if (!next) return {};
      await this.deps.store.editPost(session.post_id, { caption: text });
      return this.askWhen(ctx, next);
    }
    // when_text
    const when = parseWhen(text, this.now());
    if (!when.ok) {
      await ctx.tg.send(ctx.chat, `⚠️ ${when.error}`);
      return {};
    }
    const next = await this.advance(session, 'when_text', { publish_at: when.value });
    return next ? this.confirm(ctx, next) : {};
  }

  private async onButton(ctx: Ctx, data: string, messageId: number, queryId: string): Promise<BotReply> {
    const [, nonce, verb, arg = ''] = data.split('|');
    const session = await this.load(ctx.chat);
    if (!session || session.nonce !== nonce) {
      await ctx.tg.answer(queryId, 'השיחה הזו כבר הסתיימה');
      await ctx.tg.clearButtons(ctx.chat, messageId);
      return {};
    }
    await ctx.tg.answer(queryId);
    const d = session.data;

    switch (verb) {
      case 'fmt': {
        if (!(FORMATS as readonly string[]).includes(arg)) return {};
        const next = await this.advance(session, 'format');
        if (!next) return {};
        const post = await this.deps.store.editPost(session.post_id, { type: arg });
        await ctx.tg.edit(ctx.chat, messageId, FORMAT_LABEL[arg as Format]);
        return this.next(ctx, next, post);
      }
      case 'camp': {
        const picked = d.campaigns[Number(arg)];
        const next = await this.advance(session, 'campaign');
        if (!next) return {};
        await this.deps.store.editPost(session.post_id, { campaign_id: picked?.id ?? '' });
        await ctx.tg.edit(ctx.chat, messageId, `📣 קמפיין: ${picked?.name ?? 'בלי'}`);
        return this.next(ctx, next);
      }
      case 'prod': {
        const picked = d.products[Number(arg)];
        const next = await this.advance(session, 'product');
        if (!next) return {};
        await this.deps.store.editPost(session.post_id, { product_id: picked?.id ?? '' });
        await ctx.tg.edit(ctx.chat, messageId, `🏷 מוצר: ${picked?.name ?? 'בלי'}`);
        return this.next(ctx, next);
      }
      case 'brief': {
        const next = await this.advance(session, 'brief');
        if (!next) return {};
        await ctx.tg.edit(ctx.chat, messageId, '✍️ בלי בריף - ה-AI יחליט לפי התמונה');
        return this.next(ctx, next);
      }
      case 'pick': {
        if (arg === 'again') {
          const next = await this.advance(session, 'pick', {}, 'writing');
          if (!next) return {};
          await ctx.tg.clearButtons(ctx.chat, messageId);
          return this.write(ctx, next, true);
        }
        if (arg === 'own') {
          const next = await this.advance(session, 'pick', {}, 'own_caption');
          if (!next) return {};
          await ctx.tg.clearButtons(ctx.chat, messageId);
          await ctx.tg.send(ctx.chat, '✍️ שלח לי את הקפשן בדיוק כמו שתרצה שיעלה.');
          return {};
        }
        const variant = d.variants[Number(arg)];
        if (!variant) return {};
        const next = await this.advance(session, 'pick');
        if (!next) return {};
        await this.deps.store.editPost(session.post_id, { caption: variant.caption });
        await ctx.tg.clearButtons(ctx.chat, messageId);
        await ctx.tg.send(ctx.chat, `✅ נבחרה גרסה ${Number(arg) + 1}`);
        return this.askWhen(ctx, next);
      }
      case 'when': {
        if (arg === 'other') {
          const next = await this.advance(session, 'when', {}, 'when_text');
          if (!next) return {};
          await ctx.tg.edit(ctx.chat, messageId, '🕐 מתי? כתוב למשל: 19:30 · מחר 09:00 · 5.10 19:30');
          return {};
        }
        if (arg === 'draft') {
          if (!(await this.advance(session, 'when'))) return {};
          await ctx.tg.clearButtons(ctx.chat, messageId);
          return this.finishAsDraft(ctx, session);
        }
        const publishAt = arg === 'now' ? toLocal(this.now()) : fromCompact(arg);
        if (!publishAt) return {};
        const next = await this.advance(session, 'when', { publish_at: publishAt });
        if (!next) return {};
        await ctx.tg.edit(ctx.chat, messageId, `🗓 ${arg === 'now' ? 'עכשיו' : humanWhen(publishAt, this.now())}`);
        return this.confirm(ctx, next);
      }
      case 'ok':
        return this.onConfirm(ctx, session, arg, messageId);
      default:
        return {};
    }
  }

  private async onVariants(ctx: Ctx, nonce: string, result: unknown, error?: string): Promise<BotReply> {
    const session = await this.load(ctx.chat);
    if (!session || session.nonce !== nonce || session.step !== 'writing') return {};

    const parsed = CaptionResultSchema.safeParse(result);
    const variants = parsed.success
      ? parsed.data.variants.filter((v) => v.caption.trim()).map((v) => ({ angle: v.angle, caption: composeCaption(v) }))
      : [];
    if (!variants.length) {
      const next = await this.advance(session, 'writing', {}, 'pick');
      if (!next) return {};
      await this.ask(ctx, next, `⚠️ ה-AI לא הצליח לכתוב (${clip(error || 'אין תשובה', 200)}).`, [
        [btn(next.nonce, '🔄 נסה שוב', 'pick', 'again'), btn(next.nonce, '✍️ אכתוב בעצמי', 'pick', 'own')],
      ]);
      return {};
    }

    const next = await this.advance(session, 'writing', { variants: variants.slice(0, 3) }, 'pick');
    if (!next) return {};
    await this.showVariants(ctx, next);
    return {};
  }

  private async onConfirm(ctx: Ctx, session: Session, arg: string, messageId: number): Promise<BotReply> {
    if (arg === 'when') {
      const next = await this.advance(session, 'confirm', {}, 'when');
      if (!next) return {};
      await ctx.tg.clearButtons(ctx.chat, messageId);
      return this.askWhen(ctx, next);
    }
    if (arg === 'caption') {
      const next = await this.advance(session, 'confirm', {}, 'pick');
      if (!next) return {};
      await ctx.tg.clearButtons(ctx.chat, messageId);
      if (next.data.variants.length) await this.showVariants(ctx, next);
      else {
        await this.advance(next, 'pick', {}, 'own_caption');
        await ctx.tg.send(ctx.chat, '✍️ שלח לי את הקפשן בדיוק כמו שתרצה שיעלה.');
      }
      return {};
    }
    if (arg === 'draft') {
      if (!(await this.advance(session, 'confirm'))) return {};
      await ctx.tg.clearButtons(ctx.chat, messageId);
      return this.finishAsDraft(ctx, session);
    }
    if (arg !== 'approve') return {};

    // Claim the conversation first so a double tap cannot approve twice.
    if (!(await this.advance(session, 'confirm'))) return {};
    try {
      await this.deps.store.editPost(session.post_id, { publish_at: session.data.publish_at });
      const post = await this.deps.store.actOnPost(session.post_id, 'approve');
      await this.end(ctx, session);
      await ctx.tg.clearButtons(ctx.chat, messageId);
      const soon = post.publish_at <= toLocal(this.now());
      await ctx.tg.send(
        ctx.chat,
        soon
          ? `✅ מאושר! עולה בדקות הקרובות, ותקבל כאן 🎉 עם קישור.`
          : `✅ מאושר! יעלה ${humanWhen(post.publish_at, this.now())}, ותקבל כאן 🎉 עם קישור.${ctx.appUrl ? `\nהלוח: ${ctx.appUrl}` : ''}`,
      );
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // Invalid for Instagram (e.g. caption too long): keep the draft, say why, let them fix it.
      await this.save({ ...session, step: 'confirm' });
      await ctx.tg.send(ctx.chat, `⚠️ ${err.message}`);
    }
    return {};
  }

  // ---------- questions ----------

  /** Asks the next unanswered question, or starts writing once all are answered. */
  private async next(ctx: Ctx, session: Session, post?: Post): Promise<BotReply> {
    const d = session.data;
    const current = post ?? (await this.post(session.post_id));
    if (!d.asked.format) {
      const next = await this.move(session, 'format', { asked: { ...d.asked, format: true } });
      const feed = current.type === 'REEL' ? btn(next.nonce, '🎬 ריל', 'fmt', 'REEL') : btn(next.nonce, '🖼 פוסט בפיד', 'fmt', 'POST');
      await this.ask(ctx, next, '📐 פוסט או סטורי?', [[feed, btn(next.nonce, '📱 סטורי', 'fmt', 'STORY')]]);
      return {};
    }
    // A story has no caption on Instagram, and "!" already gave one: straight to timing.
    if (current.type === 'STORY' || d.verbatim) return this.askWhen(ctx, session);
    if (!d.asked.campaign && d.campaigns.length && !current.campaign_id) {
      const next = await this.move(session, 'campaign', { asked: { ...d.asked, campaign: true } });
      await this.ask(ctx, next, '📣 לאיזה קמפיין זה שייך?', [
        ...rows(d.campaigns.map((c, i) => btn(next.nonce, c.name, 'camp', i)), 2),
        [btn(next.nonce, 'בלי קמפיין', 'camp', '-')],
      ]);
      return {};
    }
    if (!d.asked.product && d.products.length && !current.product_id) {
      const next = await this.move(session, 'product', { asked: { ...d.asked, product: true } });
      await this.ask(ctx, next, '🏷 איזה מוצר מופיע כאן?', [
        ...rows(d.products.map((p, i) => btn(next.nonce, p.name, 'prod', i)), 2),
        [btn(next.nonce, 'בלי מוצר', 'prod', '-')],
      ]);
      return {};
    }
    if (!d.asked.brief) {
      const next = await this.move(session, 'brief', { asked: { ...d.asked, brief: true } });
      await this.ask(ctx, next, '✍️ מה חשוב להגיד בפוסט? כתוב משפט או שניים (למשל: לפני/אחרי, מבצע, סיפור הלקוח).', [
        [btn(next.nonce, '✨ תפתיע אותי', 'brief', 'skip')],
      ]);
      return {};
    }
    return this.write(ctx, await this.move(session, 'writing'), false);
  }

  /** Hands the AI call to n8n (it can wait longer than a function may run). */
  private async write(ctx: Ctx, session: Session, again: boolean): Promise<BotReply> {
    const [post, snap, examples] = await Promise.all([
      this.post(session.post_id),
      this.deps.store.snapshot(),
      this.deps.db.query<{ caption: string }>(
        `select caption from posts where status = 'published' and caption <> '' order by publish_at desc limit 4`,
      ),
    ]);
    const campaign: Campaign | undefined = snap.campaigns.find((c) => c.id === post.campaign_id);
    const product: Product | undefined = snap.products.find((p) => p.id === post.product_id);
    const brief = [session.data.brief, again ? 'כתוב זוויות שונות מהגרסאות הקודמות.' : ''].filter(Boolean).join('\n');
    await ctx.tg.send(ctx.chat, again ? '🔄 כותב גרסאות חדשות...' : '⏳ כותב 3 גרסאות, רגע...');
    return {
      generate: {
        nonce: session.nonce,
        request: {
          media: post.media_urls.split(',').filter(Boolean).slice(0, 10),
          post_type: post.type as CaptionRequest['post_type'],
          brief,
          campaign: campaign ?? null,
          product: product ?? null,
          brand: snap.brand,
          examples: examples.map((e) => clip(e.caption, 2000)),
          variants: 3,
        },
      },
    };
  }

  private async showVariants(ctx: Ctx, session: Session): Promise<void> {
    const vs = session.data.variants;
    const body = vs.map((v, i) => `${DIGITS[i]} ${v.angle}\n${v.caption}`).join('\n\n———\n\n');
    await this.ask(ctx, session, clip(`✨ בחר גרסה:\n\n${body}`, 4000), [
      vs.map((_, i) => btn(session.nonce, DIGITS[i]!, 'pick', i)),
      [btn(session.nonce, '🔄 גרסאות אחרות', 'pick', 'again'), btn(session.nonce, '✍️ אכתוב בעצמי', 'pick', 'own')],
    ]);
  }

  private async askWhen(ctx: Ctx, session: Session): Promise<BotReply> {
    const next = await this.move(session, 'when');
    const slots = suggestedSlots(this.now());
    await this.ask(ctx, next, '🗓 מתי לפרסם?', [
      ...rows(slots.map((slot) => btn(next.nonce, slot.label, 'when', compact(slot.value))), 3),
      [btn(next.nonce, '📤 עכשיו', 'when', 'now'), btn(next.nonce, '🕐 מועד אחר', 'when', 'other')],
      [btn(next.nonce, '📥 רק לשמור כטיוטה', 'when', 'draft')],
    ]);
    return {};
  }

  private async confirm(ctx: Ctx, session: Session): Promise<BotReply> {
    const post = await this.post(session.post_id);
    const snap = await this.deps.store.snapshot();
    const campaign = snap.campaigns.find((c) => c.id === post.campaign_id);
    const product = snap.products.find((p) => p.id === post.product_id);
    const when = session.data.publish_at <= toLocal(this.now()) ? 'עכשיו' : humanWhen(session.data.publish_at, this.now());
    const story = post.type === 'STORY';
    const summary = [
      `${FORMAT_LABEL[post.type as Format] ?? post.type} · 🗓 ${when}`,
      [campaign && `📣 ${campaign.name}`, product && `🏷 ${product.name}`].filter(Boolean).join(' · '),
      '',
      story ? '' : clip(post.caption, 700),
    ]
      .filter((line, i) => line || i === 2)
      .join('\n')
      .trim();
    const keyboard: Keyboard = [
      [btn(session.nonce, '✅ אשר ותזמן', 'ok', 'approve')],
      [btn(session.nonce, '🕐 שנה מועד', 'ok', 'when'), ...(story ? [] : [btn(session.nonce, '✍️ שנה קפשן', 'ok', 'caption')])],
      [btn(session.nonce, '📥 השאר כטיוטה', 'ok', 'draft')],
    ];
    const next = await this.move(session, 'confirm');
    const media = post.media_urls.split(',')[0] ?? '';
    let messageId: number;
    try {
      messageId = await ctx.tg.sendPhoto(ctx.chat, cloudinaryStill(media, 720), summary, keyboard);
    } catch {
      messageId = await ctx.tg.send(ctx.chat, summary, keyboard);
    }
    await this.save({ ...next, data: { ...next.data, question_id: messageId } });
    return {};
  }

  private async finishAsDraft(ctx: Ctx, session: Session): Promise<BotReply> {
    await this.end(ctx, session);
    await ctx.tg.send(ctx.chat, `📥 נשמר כטיוטה.${ctx.appUrl ? ` אפשר להמשיך מהלוח: ${ctx.appUrl}` : ''}`);
    return {};
  }

  /** Sends a question and remembers it, removing the buttons of the previous one. */
  private async ask(ctx: Ctx, session: Session, text: string, keyboard: Keyboard): Promise<void> {
    if (session.data.question_id) await ctx.tg.clearButtons(ctx.chat, session.data.question_id);
    const id = await ctx.tg.send(ctx.chat, text, keyboard);
    await this.save({ ...session, data: { ...session.data, question_id: id } });
  }

  /** Marks the current question as answered (typed answers). */
  private async retire(ctx: Ctx, session: Session, answer: string): Promise<void> {
    if (session.data.question_id) await ctx.tg.edit(ctx.chat, session.data.question_id, answer);
  }

  // ---------- persistence ----------

  private async settings(): Promise<Record<string, string>> {
    const rows = await this.deps.db.query<{ key: string; value: string }>(
      `select key, value from settings where key in ('telegram_bot_token', 'telegram_chat_id', 'app_url')`,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  }

  private async load(chat: string): Promise<Session | null> {
    const [row] = await this.deps.db.query<Session>('select chat_id, nonce, post_id, step, data from bot_sessions where chat_id = $1', [chat]);
    return row ?? null;
  }

  private async save(session: Session): Promise<void> {
    await this.deps.db.query('update bot_sessions set step = $3, data = $4::text::jsonb, updated_at = now() where chat_id = $1 and nonce = $2', [
      session.chat_id,
      session.nonce,
      session.step,
      JSON.stringify(session.data),
    ]);
  }

  /**
   * Compare-and-set: moves from `from` to `to` only if the conversation is
   * still (nonce, from). Returns null when someone else already moved it.
   * Answers move to 'busy' until the follow-up question is sent.
   */
  private async advance(session: Session, from: Step, patch: Partial<SessionData> = {}, to: Step = 'busy'): Promise<Session | null> {
    const data = { ...session.data, ...patch };
    const rows = await this.deps.db.query(
      `update bot_sessions set step = $4, data = $5::text::jsonb, updated_at = now()
        where chat_id = $1 and nonce = $2 and step = $3 returning chat_id`,
      [session.chat_id, session.nonce, from, to, JSON.stringify(data)],
    );
    return rows.length ? { ...session, step: to, data } : null;
  }

  /** Unconditional move within a transition the caller already won. */
  private async move(session: Session, to: Step, patch: Partial<SessionData> = {}): Promise<Session> {
    const next = { ...session, step: to, data: { ...session.data, ...patch } };
    await this.save(next);
    return next;
  }

  private async end(ctx: Ctx, session: Session): Promise<void> {
    if (session.data.question_id) await ctx.tg.clearButtons(ctx.chat, session.data.question_id);
    await this.deps.db.query('delete from bot_sessions where chat_id = $1 and nonce = $2', [session.chat_id, session.nonce]);
  }

  private async post(id: string): Promise<Post> {
    const [row] = await this.deps.db.query<Record<string, string>>('select * from posts where id = $1', [id]);
    if (!row) throw new DomainError('הטיוטה לא נמצאה');
    return toPost(row);
  }

  private nonce(): string {
    const random = this.deps.random ?? Math.random;
    return Array.from({ length: 6 }, () => Math.floor(random() * 36).toString(36)).join('');
  }
}

interface Ctx {
  tg: Telegram;
  chat: string;
  appUrl: string;
}

/** "2026-10-05 19:30" ⇄ "202610051930" (callback_data is limited to 64 bytes). */
const compact = (local: string) => local.replace(/\D/g, '');
function fromCompact(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
}

function humanWhen(local: string, now: Date): string {
  const today = toLocal(now).slice(0, 10);
  const [date, time] = local.split(' ') as [string, string];
  if (date === today) return `היום ב-${time}`;
  if (date === addDays(today, 1)) return `מחר ב-${time}`;
  const [, m, d] = date.split('-');
  return `ב-${d}.${m} ב-${time}`;
}
