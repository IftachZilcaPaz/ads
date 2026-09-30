/**
 * In-memory backend for local UI development (no Google, no Netlify).
 * Mounted into the Vite dev server, so `npm run dev` is the only command.
 * Data is seeded with sample posts and resets on restart. Password: "dev".
 * Captions are canned unless ANTHROPIC_API_KEY is set.
 */
import { createApi } from './api.ts';
import { defaultCaptionDeps, handleCaptionRequest } from './captions-handler.ts';
import { MemorySheets } from './memory-sheets.ts';
import { Store } from './store.ts';
import { POST_COLUMNS } from '../shared/post.ts';
import { addDays, localDate } from '../shared/time.ts';

export function createDevBackend(): (req: Request) => Promise<Response> {
  process.env.SESSION_SECRET ??= 'dev-secret-dev-secret-dev-secret-dev-secret';
  process.env.API_TOKEN ??= 'dev-token';

  const sheets = new MemorySheets();
  const img = (id: string) => `https://picsum.photos/id/${id}/1080/1350`;
  const today = localDate();
  const seed: Record<string, string>[] = [
    { id: 'demo-1', publish_at: `${addDays(today, 1)} 19:00`, media_urls: img('1062'), caption: 'מטבח חדש בגבעתיים ✨ 6 שבועות, בדיוק לפי הלו״ז.\n\n#שיפוץ #מטבח', status: 'ready', approval_mode: 'approve', campaign_id: 'autumn' },
    { id: 'demo-2', publish_at: `${addDays(today, 2)} 09:00`, media_urls: `${img('1040')},${img('1041')}`, type: 'CAROUSEL', caption: 'לפני ואחרי 👀', status: 'ready', approval_mode: 'approve', approved_at: `${today} 10:00`, product_id: 'kitchen' },
    { id: 'demo-3', publish_at: '', media_urls: img('1080'), caption: '', status: 'draft' },
    { id: 'demo-4', publish_at: `${addDays(today, -2)} 19:00`, media_urls: img('1060'), caption: 'אמבטיה מושלמת. כל פרט נבחר בקפידה, מהאריחים ועד הברזים.', status: 'published', approval_mode: 'approve', approved_at: 'x', permalink: 'https://instagram.com/' },
    { id: 'demo-5', publish_at: `${addDays(today, -1)} 12:00`, media_urls: img('1050'), caption: 'נכשל', status: 'failed', error: 'Meta 9004: Media download failed' },
    { id: 'demo-6', publish_at: `${addDays(today, 4)} 20:30`, media_urls: img('1070'), caption: 'שאלה לקהל: איזה צבע הייתם בוחרים?', status: 'pending_approval', approval_mode: 'approve' },
  ];
  sheets.tabs.set('calendar', [
    [...POST_COLUMNS],
    ...seed.map((r) => POST_COLUMNS.map((c) => r[c] ?? (c === 'type' ? 'POST' : ''))),
  ]);
  sheets.tabs.set('campaigns', [
    ['id', 'name', 'status', 'start_date', 'end_date', 'goal', 'key_message', 'cta', 'hashtags'],
    ['autumn', 'שיפוצי סתיו', 'active', addDays(today, -10), addDays(today, 30), 'לידים לפני החגים', 'מסיימים לפני החורף', 'שלחו הודעה', '#שיפוצסתיו'],
  ]);
  sheets.tabs.set('products', [
    ['id', 'name', 'status', 'description', 'price'],
    ['kitchen', 'שיפוץ מטבח מלא', 'active', 'תכנון, פירוק, התקנה וגמר', 'החל מ-45,000 ₪'],
  ]);
  sheets.tabs.set('brand', [['key', 'value'], ['name', 'Reynovation'], ['voice', 'חם, מקצועי, בגובה העיניים']]);
  sheets.tabs.set('config', [['key', 'value'], ['cloudinary_cloud', 'demo'], ['cloudinary_preset', 'unsigned']]);

  const api = createApi({
    store: () => new Store(sheets),
    secrets: () => ({ sessionSecret: process.env.SESSION_SECRET!, apiToken: process.env.API_TOKEN }),
    password: () => process.env.APP_PASSWORD ?? 'dev',
  });

  const cannedCaptions = async (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (e: unknown) => c.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
        send({ type: 'progress', chars: 0 });
        await new Promise((r) => setTimeout(r, 1200));
        send({
          type: 'result',
          data: {
            image_notes: 'מטבח מודרני בגוונים בהירים עם אי מרכזי.',
            alt_text: 'מטבח לבן עם אי מרכזי',
            variants: [
              { angle: 'סיפור', caption: 'כשהם נכנסו לדירה, המטבח היה מ-1985.\nשישה שבועות אחרי - זה מה שחיכה להם.', hashtags: ['שיפוץמטבח', 'לפניואחרי'], why: 'סיפור אישי מושך הזדהות' },
              { angle: 'שאלה לקהל', caption: 'אי מרכזי: חובה או מותרות? 🤔\nספרו לנו בתגובות.', hashtags: ['עיצובמטבח'], why: 'מעודד תגובות' },
            ],
          },
        });
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  };

  return (request) =>
    new URL(request.url).pathname.startsWith('/api/captions')
      ? process.env.ANTHROPIC_API_KEY
        ? handleCaptionRequest(request, defaultCaptionDeps)
        : cannedCaptions()
      : api.handle(request);
}
