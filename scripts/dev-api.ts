/**
 * Local API for UI development without Google/Netlify:
 *   npm run dev:api   (port 8888)   +   npm run dev   (Vite, proxies /api)
 * Data lives in memory and is seeded with sample posts. Password: "dev".
 * Captions are canned unless ANTHROPIC_API_KEY is set.
 */
import { createServer } from 'node:http';
import { createApi } from '../src/server/api.ts';
import { handleCaptionRequest, defaultCaptionDeps } from '../src/server/captions-handler.ts';
import { MemorySheets } from '../src/server/memory-sheets.ts';
import { Store } from '../src/server/store.ts';
import { POST_COLUMNS } from '../src/shared/post.ts';
import { addDays, localDate } from '../src/shared/time.ts';

const PORT = Number(process.env.PORT ?? 8888);
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

const cannedCaptions = async (req: Request): Promise<Response> => {
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
  void req;
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? `localhost:${PORT}`;
  const request = new Request(`http://${host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD'].includes(req.method!) ? null : Buffer.concat(chunks),
  });
  const response = req.url?.startsWith('/api/captions')
    ? process.env.ANTHROPIC_API_KEY
      ? await handleCaptionRequest(request, defaultCaptionDeps)
      : await cannedCaptions(request)
    : await api.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}).listen(PORT, () => console.log(`dev API on http://localhost:${PORT} (password: ${process.env.APP_PASSWORD ?? 'dev'})`));
