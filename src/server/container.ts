import { createApi } from './api.ts';
import { readEnv, requireEnv } from './env.ts';
import { ServiceAccountTokenProvider, parseServiceAccount } from './google-auth.ts';
import type { AuthSecrets } from './session.ts';
import { SheetsClient } from './sheets.ts';
import { Store } from './store.ts';

/** Lazily wired singletons: reused across invocations of a warm instance. */
let store: Store | null = null;

function getStore(): Store {
  if (!store) {
    const sa = parseServiceAccount(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON'));
    store = new Store(new SheetsClient(requireEnv('SPREADSHEET_ID'), new ServiceAccountTokenProvider(sa)));
  }
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
