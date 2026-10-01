/**
 * Local backend for UI development: a real Postgres schema running in-process
 * (PGlite), seeded with sample data. No Railway, Google or Netlify needed.
 * Mounted into the Vite dev server, so `npm run dev` is the only command.
 * Data resets on restart. Password: "dev". Captions are canned unless
 * ANTHROPIC_API_KEY is set.
 */
import { createApi } from './api.ts';
import { defaultCaptionDeps, handleCaptionRequest } from './captions-handler.ts';
import { handlePlanRequest } from './plan-service.ts';
import { CampaignService } from './campaigns.ts';
import { ConnectionService } from './connections.ts';
import { createMeta } from './meta.ts';
import type { Db } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { loadMigrations } from './db/migrations-fs.ts';
import { createMemoryDb } from './db/pglite.ts';
import { Store } from './store.ts';
import { addDays, localDate } from '../shared/time.ts';

/** Inserts rows given as column → value objects (dev/test seeding only). */
export async function insertRows(db: Db, table: string, rows: Record<string, string>[]): Promise<void> {
  for (const row of rows) {
    const cols = Object.keys(row);
    await db.query(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  }
}

export async function createDevBackend(): Promise<(req: Request) => Promise<Response>> {
  process.env.SESSION_SECRET ??= 'dev-secret-dev-secret-dev-secret-dev-secret';
  process.env.API_TOKEN ??= 'dev-token';

  const db = await createMemoryDb();
  await migrate(db, loadMigrations());
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
  await insertRows(db, 'posts', seed);
  await insertRows(db, 'campaigns', [
    { id: 'autumn', name: 'שיפוצי סתיו', status: 'active', start_date: addDays(today, -10), end_date: addDays(today, 30), goal: 'לידים לפני החגים', key_message: 'מסיימים לפני החורף', cta: 'שלחו הודעה', hashtags: '#שיפוצסתיו' },
  ]);
  await insertRows(db, 'products', [
    { id: 'kitchen', name: 'שיפוץ מטבח מלא', status: 'active', description: 'תכנון, פירוק, התקנה וגמר', price: 'החל מ-45,000 ₪' },
  ]);
  await insertRows(db, 'brand', [
    { key: 'name', value: 'Reynovation' },
    { key: 'voice', value: 'חם, מקצועי, בגובה העיניים' },
  ]);
  await insertRows(db, 'settings', [
    { key: 'cloudinary_cloud', value: 'demo' },
    { key: 'cloudinary_preset', value: 'unsigned' },
  ]);

  const store = new Store(db);
  const api = createApi({
    store: () => store,
    secrets: () => ({ sessionSecret: process.env.SESSION_SECRET!, apiToken: process.env.API_TOKEN }),
    password: () => process.env.APP_PASSWORD ?? 'dev',
    campaigns: () => new CampaignService({ db, store, meta: (token) => createMeta(token) }),
    connections: () =>
      new ConnectionService({
        db,
        meta: (token) => createMeta(token),
        secret: () => process.env.SESSION_SECRET!,
        claudeConfigured: () => !!process.env.ANTHROPIC_API_KEY,
      }),
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

  /** Without an API key, a plausible plan spread over the requested dates. */
  const cannedPlan = async (request: Request): Promise<Response> => {
    const input = (await request.json()) as { start_date: string; end_date: string; posts_count?: number; include_ads?: boolean };
    const n = Math.min(input.posts_count ?? 6, 12);
    const days = Math.max(1, Math.round((Date.parse(input.end_date) - Date.parse(input.start_date)) / 86_400_000));
    const types = ['REEL', 'CAROUSEL', 'POST', 'STORY'] as const;
    const posts = Array.from({ length: n }, (_, i) => ({
      date: addDays(input.start_date, Math.floor((i * days) / n)),
      time: i % 2 ? '08:30' : '19:30',
      type: types[i % types.length],
      idea: ['סרטון לפני/אחרי של מטבח שסיימנו', '5 תמונות של שלבי העבודה', 'צילום של הצוות בעבודה', 'סקר: איזה גוון ארונות?'][i % 4],
      caption: ['מטבח מ-1985 שקיבל חיים חדשים.\nשישה שבועות, אפס הפתעות.', 'ככה נראה שיפוץ מטבח מבפנים - שלב אחרי שלב.', 'הצוות שלנו, בלי פילטרים.', 'לבן או עץ? ספרו לנו.'][i % 4],
      hashtags: ['שיפוץמטבח', 'שיפוצסתיו'],
      product_id: i % 2 ? 'kitchen' : '',
      why: ['חשיפה', 'ערך', 'אמון', 'מעורבות'][i % 4],
    }));
    const ads = input.include_ads
      ? {
          objective: 'OUTCOME_LEADS',
          objective_why: 'המטרה היא פניות לפני החגים',
          daily_budget_ils: 50,
          duration_days: Math.min(days, 21),
          audience: { age_min: 30, age_max: 60, genders: 'all', locations: ['תל אביב', 'רמת גן'], interests: ['עיצוב פנים', 'שיפוץ'], description: 'בעלי דירות במרכז ששוקלים שיפוץ' },
          ad_copies: [
            { primary_text: 'מטבח חדש לפני החורף? מתכננים, מפרקים ומתקינים - בלוח זמנים שמחזיק.', headline: 'שיפוץ מטבח בלי הפתעות', description: 'תיאום פגישה', cta: 'SEND_MESSAGE' },
            { primary_text: 'ראיתם את המטבח הזה לפני? גם הלקוחות שלנו לא האמינו.', headline: 'לפני ואחרי', description: 'שלחו הודעה', cta: 'CONTACT_US' },
          ],
          creative_tips: ['סרטון אנכי של 10-15 שניות', 'לפני/אחרי בפריים הראשון'],
          kpis: ['עלות לליד מתחת ל-60 ₪', 'CTR מעל 1%'],
        }
      : null;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (e: unknown) => c.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
        send({ type: 'progress', chars: 0 });
        await new Promise((r) => setTimeout(r, 1200));
        send({ type: 'result', data: { summary: 'חשיפה דרך תוצאות אמיתיות, אחר כך אמון, ובסוף הצעה ברורה לפני החגים.', posts, ads } });
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  };

  return (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/captions')) {
      return process.env.ANTHROPIC_API_KEY ? handleCaptionRequest(request, defaultCaptionDeps) : cannedCaptions();
    }
    if (path.startsWith('/api/plan')) return process.env.ANTHROPIC_API_KEY ? handlePlanRequest(request) : cannedPlan(request);
    return api.handle(request);
  };
}
