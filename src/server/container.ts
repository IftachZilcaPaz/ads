import { createApi } from './api.ts';
import { Bot } from './bot/bot.ts';
import { createTelegram } from './bot/telegram.ts';
import { CampaignService } from './campaigns.ts';
import { ConnectionService } from './connections.ts';
import type { Db } from './db/db.ts';
import { createPostgresDb } from './db/postgres.ts';
import { createMeta } from './meta.ts';
import { readEnv, requireEnv } from './env.ts';
import type { AuthSecrets } from './session.ts';
import { Store } from './store.ts';

/** Lazily wired singleton: reused across invocations of a warm instance. */
let db: Db | null = null;
let store: Store | null = null;
let bot: Bot | null = null;

function getDb(): Db {
  db ??= createPostgresDb(requireEnv('DATABASE_URL'));
  return db;
}

function getStore(): Store {
  store ??= new Store(getDb());
  return store;
}

function getBot(): Bot {
  bot ??= new Bot({ db: getDb(), store: getStore(), telegram: (token) => createTelegram(token) });
  return bot;
}

export function authSecrets(): AuthSecrets {
  return { sessionSecret: requireEnv('SESSION_SECRET'), apiToken: readEnv('API_TOKEN') };
}

export const api = createApi({
  store: getStore,
  secrets: authSecrets,
  password: () => requireEnv('APP_PASSWORD'),
  bot: getBot,
  campaigns: () => new CampaignService({ db: getDb(), store: getStore(), meta: (token) => createMeta(token) }),
  connections: () =>
    new ConnectionService({
      db: getDb(),
      meta: (token) => createMeta(token),
      secret: () => requireEnv('SESSION_SECRET'),
      claudeConfigured: () => !!readEnv('ANTHROPIC_API_KEY'),
    }),
});
