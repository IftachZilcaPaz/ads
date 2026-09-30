import { createApi } from './api.ts';
import { createPostgresDb } from './db/postgres.ts';
import { readEnv, requireEnv } from './env.ts';
import type { AuthSecrets } from './session.ts';
import { Store } from './store.ts';

/** Lazily wired singleton: reused across invocations of a warm instance. */
let store: Store | null = null;

function getStore(): Store {
  store ??= new Store(createPostgresDb(requireEnv('DATABASE_URL')));
  return store;
}

export function authSecrets(): AuthSecrets {
  return { sessionSecret: requireEnv('SESSION_SECRET'), apiToken: readEnv('API_TOKEN') };
}

export const api = createApi({
  store: getStore,
  secrets: authSecrets,
  password: () => requireEnv('APP_PASSWORD'),
});
