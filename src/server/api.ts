import { z } from 'zod';
import { EDITABLE_FIELDS, POST_ACTIONS, type PostChanges } from '../shared/post.ts';
import { HttpError, json, readJson, Router } from './http.ts';
import {
  clearedSessionCookie,
  createSessionToken,
  isAuthorized,
  secretsEqual,
  sessionCookie,
  type AuthSecrets,
} from './session.ts';
import { BotEventSchema, type Bot } from './bot/bot.ts';
import { ApplyPostsSchema, SavePlanSchema, type CampaignService } from './campaigns.ts';
import type { Store } from './store.ts';

export interface ApiDeps {
  store: () => Store;
  secrets: () => AuthSecrets;
  password: () => string;
  /** Telegram conversation, driven by n8n (Bearer API_TOKEN). */
  bot?: () => Bot;
  /** AI plans, Meta campaign creation and insights. */
  campaigns?: () => CampaignService;
}

const LoginSchema = z.object({ password: z.string().min(1).max(200) });

const postFields = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, z.string().max(5000).optional()])) as Record<
  (typeof EDITABLE_FIELDS)[number],
  z.ZodOptional<z.ZodString>
>;
const PostChangesSchema = z.object(postFields).strict();
const NewPostSchema = PostChangesSchema.extend({
  id: z.string().max(40).optional(),
  intent: z.enum(['draft', 'submit', 'approve']).optional(),
}).strict();
const BulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(POST_ACTIONS),
});
const RecordSchema = z.record(z.string(), z.unknown());

/** Naive per-instance brute-force brake; the password should still be strong. */
const failedLogins = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;

function clientKey(req: Request): string {
  return req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function createApi(deps: ApiDeps): Router {
  const router = new Router(deps.secrets);
  const campaigns = () => {
    if (!deps.campaigns) throw new HttpError(404, 'Not found');
    return deps.campaigns();
  };

  router
    .add(
      'POST',
      '/api/login',
      async ({ req }) => {
        const key = clientKey(req);
        const state = failedLogins.get(key);
        if (state && state.count >= MAX_FAILURES && state.until > Date.now()) {
          throw new HttpError(429, 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה');
        }
        const { password } = await readJson(req, LoginSchema);
        const { sessionSecret } = deps.secrets();
        if (!(await secretsEqual(sessionSecret, password, deps.password()))) {
          const next = { count: (state && state.until > Date.now() ? state.count : 0) + 1, until: Date.now() + LOCK_MS };
          failedLogins.set(key, next);
          await new Promise((r) => setTimeout(r, 400));
          throw new HttpError(401, 'סיסמה שגויה');
        }
        failedLogins.delete(key);
        const token = await createSessionToken(sessionSecret);
        return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token) } });
      },
      { public: true },
    )
    .add('POST', '/api/logout', async () => json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } }), {
      public: true,
    })
    .add(
      'GET',
      '/api/session',
      async ({ req }) => json({ authenticated: await isAuthorized(req, deps.secrets()) }),
      { public: true },
    )

    .add('GET', '/api/bootstrap', async () => json(await deps.store().snapshot()))

    .add('POST', '/api/posts', async ({ req }) => {
      const input = await readJson(req, NewPostSchema);
      return json(await deps.store().createPost(input), { status: 201 });
    })
    .add('PATCH', '/api/posts/:id', async ({ req, params }) => {
      const changes: PostChanges = await readJson(req, PostChangesSchema);
      return json(await deps.store().editPost(params.id!, changes));
    })
    .add('POST', '/api/posts/:id/duplicate', async ({ params }) =>
      json(await deps.store().duplicatePost(params.id!), { status: 201 }),
    )
    .add('POST', '/api/posts/:id/:action', async ({ params }) => {
      const action = z.enum(POST_ACTIONS).safeParse(params.action);
      if (!action.success) throw new HttpError(404, 'Unknown action');
      return json(await deps.store().actOnPost(params.id!, action.data));
    })
    .add('POST', '/api/posts-bulk', async ({ req }) => {
      const { ids, action } = await readJson(req, BulkSchema);
      return json(await deps.store().bulkAct(ids, action));
    })

    .add('POST', '/api/campaigns', async ({ req }) =>
      json(await deps.store().saveCampaign(await readJson(req, RecordSchema)), { status: 201 }),
    )
    .add('PUT', '/api/campaigns/:id', async ({ req, params }) =>
      json(await deps.store().saveCampaign(await readJson(req, RecordSchema), params.id)),
    )
    .add('POST', '/api/products', async ({ req }) =>
      json(await deps.store().saveProduct(await readJson(req, RecordSchema)), { status: 201 }),
    )
    .add('PUT', '/api/products/:id', async ({ req, params }) =>
      json(await deps.store().saveProduct(await readJson(req, RecordSchema), params.id)),
    )
    .add('PUT', '/api/brand', async ({ req }) => json(await deps.store().saveBrand(await readJson(req, RecordSchema))))

    .add('GET', '/api/campaigns/:id/insights', async ({ req, params }) =>
      json(await campaigns().insights(params.id!, new URL(req.url).searchParams.has('refresh'))),
    )
    .add('PUT', '/api/campaigns/:id/plan', async ({ req, params }) =>
      json(await campaigns().savePlan(params.id!, await readJson(req, SavePlanSchema))),
    )
    .add('POST', '/api/campaigns/:id/plan/posts', async ({ req, params }) =>
      json(await campaigns().applyPosts(params.id!, await readJson(req, ApplyPostsSchema)), { status: 201 }),
    )
    .add('POST', '/api/campaigns/:id/meta', async ({ params }) => json(await campaigns().createInMeta(params.id!), { status: 201 }))

    .add('POST', '/api/bot', async ({ req }) => {
      if (!deps.bot) throw new HttpError(404, 'Not found');
      return json(await deps.bot().handle(await readJson(req, BotEventSchema)));
    });

  return router;
}
