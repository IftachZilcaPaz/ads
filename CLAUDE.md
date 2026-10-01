# CLAUDE.md: BP Social

Instagram publishing system for the owner's business (Reynovation). The owner writes in Hebrew, so reply in Hebrew. All UI text is Hebrew/RTL. This repo is **public**: never commit secrets, tokens, the spreadsheet id or the Telegram chat id.

## What it does
- **Board app** (Netlify): kanban (טיוטות → ממתין לאישור שלי → מאושר ומתוזמן → פורסם / נכשל-נדחה), calendar, studio (upload media + Claude captions), campaigns & products library, a **campaign page** (stats + AI campaign builder), brand voice. Installable as a PWA.
- **Core rule: nothing publishes without approval.** Approval = `approved_at` set, or `approval_mode='auto'`. Editing caption/media/type revokes approval; moving the time does not.
- **n8n** (on Railway): publishes on time, asks for approval in Telegram, nightly watchdog, Meta token refresh, error alerts.
- **Telegram bot**: send a photo/video → the app runs a Q&A: post or story → campaign → product → brief → 3 AI variants → when → preview → approve. A story skips the caption questions.
- **Settings → connections** (`#/settings`): Meta status (app, token validity/expiry, ✅/❌ per scope, Instagram account, ad account), reconnect with "Continue with Facebook" (OAuth, signed state, `config_id` for Login-for-Business apps) or by pasting an Explorer token, pickers for the Instagram/ad account, app id/secret (secret write-only), and the status of Telegram/Cloudinary/Claude/app_url. Same guard as `meta:check` (`src/server/meta-token.ts`, shared).
- **Import from Meta** (campaigns tab): lists the ad account's campaigns and creates the picked ones locally, already linked (`meta_campaign_id`).
- **Campaign page** (`#/campaign?id=…`): board status, organic Instagram insights per published post, paid Meta Ads insights, and "build with AI": an organic post plan (→ drafts) plus a Meta ads plan (→ a **PAUSED** campaign + ad set in Meta; ads themselves are added in Ads Manager).

## Architecture
```
Browser (Preact SPA, RTL) ──► Netlify
   /api/*          Node function  (netlify/functions/api.mts → src/server/api.ts)
   /api/captions   Edge function  (streams NDJSON; Claude captions)
   /api/plan       Edge function  (streams NDJSON; Claude campaign plan)
        │
        ▼
   Postgres on Railway (service "bp-db", same project as n8n)
        ▲
   n8n (Railway): BP1 Publisher, BP2 Telegram Hub, BP3 Watchdog, BP4 Token Refresh, BP5 Error Alert
Browser ──► Cloudinary (unsigned direct upload)        n8n ──► Instagram Graph API / Telegram
```
- `src/shared/`: domain shared by server and browser: `post.ts` (lifecycle, transitions, IG validation), `time.ts` (Israel wall-clock `YYYY-MM-DD HH:mm` as text), `catalog.ts`, `captions.ts` (prompt), `campaign-plan.ts` (plan schema + prompt), `media.ts` (`cloudinaryStill`, `igImage`).
- `src/server/`: `store.ts` (Postgres repo, `SELECT … FOR UPDATE`), `api.ts` (routes), `session.ts` (HMAC cookie / Bearer `API_TOKEN`), `ai.ts` + `ai-handler.ts` (shared structured Claude call + NDJSON handler), `captions-*.ts`, `plan-service.ts`, `campaigns.ts` (plans, Meta create, insights + `insights_cache`), `meta.ts` (Graph client), `bot/` (Telegram conversation state machine, `bot_sessions`, CAS on `(nonce, step)`), `db/` (postgres.js, PGlite, migrator), `dev-backend.ts` (in-process PGlite + seed + canned AI when no key).
- `db/migrations/`: `001_init` (tables + atomic SQL for n8n: `claim_due_posts`, `request_approvals`, `decide_approval`, `finish_publish`, `insert_draft`, `il_now`), `002_bot` (`bot_sessions`), `003_campaign_insights` (`campaigns.meta_campaign_id`, `campaign_plans`, `insights_cache`).
- `n8n/`: `code/*.js` are the Code-node bodies (`// @include _common.js`, `@@VAR@@`), `src/workflows.mjs` defines the 5 workflows, `workflows/*.json` are generated and committed (`n8n:check` keeps them in sync). Placeholders `__PG_CREDENTIAL_ID__` and `__TELEGRAM_CHAT_ID__` are filled from `.env` at deploy time.
- Claude: model `claude-opus-5-5`, `client.beta.messages.stream` + `betaZodOutputFormat`, `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`. Captions use effort `medium` (env `CLAUDE_EFFORT`); plans use `high`.
- UI theme: "clay"/3D: slate background, navy side rail (bottom tab bar on mobile), teal pills, Varela Round + Heebo (self-hosted via @fontsource; CSP allows only 'self').

## Accounts & infrastructure (identifiers only, no secrets)
- **GitHub**: `IftachZilcaPaz/ads` (public). I develop on `claude/hopeful-hamilton-0bg1w5`; the owner merges to `main` locally with `git fetch origin && git merge --ff-only origin/claude/hopeful-hamilton-0bg1w5 && git push`. Netlify builds from `main`.
- **Netlify**: https://ads-reynovation.netlify.app (= `app_url`), built from GitHub `main`; env vars `APP_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL` (public Railway URL + `?sslmode=require`), `ANTHROPIC_API_KEY`, `API_TOKEN`.
- **Railway**: Postgres `bp-db` in the **same project as n8n**. n8n's Postgres credential uses the internal host `postgres.railway.internal:5432`; Netlify and the local CLI use `DATABASE_PUBLIC_URL` (`*.proxy.rlwy.net`) + `?sslmode=require`. Local scripts reject `*.railway.internal`.
- **n8n**: deployed through its public API (`npm run n8n:deploy`, no Enterprise needed). Workflow ids are stable (BP1 `EMES0elQDjPxhY6Z`, BP2 `RbzKFcz4zIHRiJJl`, BP3 `sE2eyZ6EJD3PjYwY`, BP4 `tjCHfryj2pTghgZl`, BP5 `cPELz1Hlnup9oEir` = error workflow). The Telegram credential in n8n is `ReynovationSocial`. A deploy overwrites UI edits; backups go to `n8n/backups/` (gitignored).
- **Meta**:
  - App **"Reynovation Publisher"**, App ID `1979053692811794`, Business type, Development mode (fine, the owner is admin). This is the app the token belongs to: `meta_app_id`/`meta_app_secret` in settings must be this app, because BP4 renews the token with them. Products: Facebook Login for Business, Marketing API.
  - The token is a long-lived **USER** token with `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `ads_read`, `ads_management`, `business_management`. Set up 2026-10-01, valid until 2026-11-30; BP4 renews it on the 1st and 15th.
  - Ad accounts the token can see: **Reynovation Ads** `act_1098596072521598` (the business account → `meta_ad_account_id`) and Iftach Zilca `act_253062559` (personal; not used).
  - A different app, **"Reynovation"** (new use-case dashboard, WhatsApp), is NOT used by this system. Ads/Instagram use cases were added there during setup by mistake and are harmless. The owner's Instagram flights bot lives in yet another app; keep it separate.
- **Telegram**: one bot; its webhook belongs to n8n (BP2 trigger). The app sends bot messages itself using `telegram_bot_token`. Only `telegram_chat_id` (the owner) is served.
- **Cloudinary**: unsigned preset (`cloudinary_cloud`, `cloudinary_preset`). The publisher sends `igImage()` URLs: JPEG, max width 1440, feed images padded (never cropped) into 4:5…1.91:1.
- **Google Sheet**: the original data source, imported once with `db:import-sheet`; now only a backup. The import service-account key was meant to be deleted afterwards.

### `settings` table keys
`access_token`, `access_token_refreshed_at`, `ig_user_id`, `meta_app_id`, `meta_app_secret`, `meta_login_config_id` (optional, for Facebook Login for Business), `meta_ad_account_id`, `telegram_bot_token`, `telegram_chat_id`, `app_url`, `app_api_token` (= Netlify `API_TOKEN`), `cloudinary_cloud`, `cloudinary_preset`, `approval_lead_hours` (default 12). Only `cloudinary_*` ever reach the browser. Set with `npm run db:set -- <key> <value>` (secrets are masked when listed).

## Commands
```bash
npm run dev            # http://localhost:5199 (password: dev), PGlite + seed, canned AI without a key. Never use port 3000.
npm run check          # typecheck + tests + build
npm run n8n:build | n8n:check | n8n:deploy [-- --dry-run | --only bp1-publisher]
N8N_PUBLISH_EVERY_MINUTES=2 npm run n8n:deploy -- --only bp1-publisher   # faster cadence for testing (unset + redeploy = 15)
npm run db:migrate     # apply db/migrations to DATABASE_URL
npm run db:set [-- key value]
npm run db:overdue [-- --draft | --archive]   # posts whose time passed
npm run doctor         # why a post didn't publish: posts, missing settings, n8n runs + last error
npm run meta:check [-- --token <Explorer token>]   # token app/expiry/permissions/ad accounts; --token exchanges to 60 days and saves (refuses a token that can't publish)
TEST_DATABASE_URL=postgresql://… npx vitest run --no-file-parallelism   # DB tests against real Postgres (CI does this)
```
- Scripts run TS via `node --experimental-transform-types` (parameter properties need transform, not strip).
- `.env` (gitignored) holds local values; `.env.example` documents them in Hebrew.

## Gotchas learned the hard way
- **postgres.js double-encodes a JS string bound to a `jsonb` parameter.** Bind as text and cast: `$1::text::jsonb`.
- Instagram rejects feed images outside 4:5…1.91:1 (Meta 36003) and non-JPEG: always publish through `igImage()`.
- The Publisher runs every 15 min at :00/:15/:30/:45; a post goes out on the first run after its time.
- Telegram callback data ≤ 64 bytes: bot buttons are `b|<nonce>|<verb>|<arg>`; approval buttons are `action:id:ref`.
- Netlify Node functions time out quickly, so long Claude calls go through edge functions (streaming) or through n8n (the bot's AI roundtrip).
- A Meta token belongs to the app that created it. Graph API Explorer must use **Reynovation Publisher**, and a new token must keep the Instagram scopes or publishing breaks (`meta:check --token` guards this).
- Old-style Meta apps have **Products**, not **Use cases**.
- PGlite boot can be slow on a busy machine; vitest `hookTimeout` is 30s.

## Conventions
- Production-quality TypeScript, SOLID/DRY; match the surrounding style; Hebrew user-facing strings; no long dashes (— –) in generated captions.
- Every change: `npm run check` (+ `n8n:build` when n8n code changes) and the DB tests against real Postgres when SQL changes, then commit and push to the dev branch, then give the owner the merge/deploy commands.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: …`. No model ids anywhere else in the repo. No PRs unless asked.

## History (what was built, in order)
1. Took over 5 n8n workflows + an Apps Script kanban on a Google Sheet; rebuilt them as this repo (Preact app on Netlify + n8n), with approval-gated publishing and Claude captions per campaign/product/brand.
2. Moved the data from Sheets to Postgres on Railway (Supabase was out of free projects); atomic SQL functions for n8n; one-time sheet import; n8n deploy via public API.
3. Ops tooling: `db:overdue` (cleared overdue posts before cutover), `doctor`, configurable publisher cadence.
4. First real publish failed on aspect ratio → `igImage()` padding. Then it published successfully.
5. UI: light glass redesign, then a 3D "clay" redesign with a side rail / mobile tab bar; PWA install.
6. Telegram Q&A bot (app-side state machine), then "post or story?" as the first question.
7. Campaign page: AI campaign builder (organic plan → drafts, ads plan → paused Meta campaign), organic + paid insights; `meta:check`; the token re-issued on Reynovation Publisher with ads scopes; ad account Reynovation Ads.

## Roadmap (agreed, not started)
See `docs/roadmap.md`: GitHub Action auto-deploy (migrate + n8n deploy on `main`), and Telegram albums → one carousel draft.

### Before selling this to other businesses (owner's requirement)
Status: the two items below now exist **for the single owner** (Settings → connections). What remains for selling is multi-tenancy (see the last paragraph) and Meta App Review.
Today everything is single-tenant and configured from the CLI (`db:set`, `meta:check`, Graph API Explorer). To sell it, two things are **required**:
1. **A settings screen for the Meta connection**: the customer enters their own `meta_app_id` / `meta_app_secret` (or connects through our app), then picks their Instagram account, Facebook page and ad account from lists (`me/accounts`, `me/adaccounts`). No CLI, no Graph API Explorer. Prefer "Login with Facebook" (OAuth) inside the app over pasting tokens; the app secret stays server-side only.
2. **A permissions check in the UI** (the in-app version of `npm run meta:check`): which app the token belongs to, token validity and expiry, ✅/❌ per required scope (`instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `ads_read`, `ads_management`, `business_management`), with a "reconnect" button that re-requests missing scopes. Keep the `meta:check --token` guard: never replace a token that can publish with one that can't.

Also needed for multi-tenant (not yet designed): per-customer data isolation (tenant id on every table, or a database per customer), per-customer Telegram bot and n8n credentials (or moving the n8n jobs into the app), Meta App Review + Live mode for `instagram_*`/`ads_*` with Advanced Access (Development mode only works for app admins), and billing.
