import postgres from 'postgres';
import { isConnectionError, translateDbError, type Db } from './db.ts';

type Sql = postgres.Sql | postgres.TransactionSql;

/** SSL on by default; Railway's public proxy uses a self-signed certificate. */
function sslOption(url: string): postgres.Options<{}>['ssl'] {
  const mode = process.env.DATABASE_SSL ?? new URL(url).searchParams.get('sslmode') ?? 'prefer';
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return 'verify-full';
  return mode === 'require' ? 'require' : 'prefer';
}

function wrap(sql: Sql, root: postgres.Sql | null): Db {
  const run = async <T>(fn: () => Promise<T>, retry: boolean): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      // One retry for a dropped connection (serverless instances are frozen between requests).
      if (retry && isConnectionError(err)) {
        try {
          return await fn();
        } catch (again) {
          throw translateDbError(again);
        }
      }
      throw translateDbError(err);
    }
  };
  return {
    query: <T>(text: string, params: unknown[] = []) =>
      run(() => sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]) as unknown as Promise<T[]>, !!root),
    exec: (text) => run(async () => void (await sql.unsafe(text)), !!root),
    tx: (fn) => {
      if (!root) throw new Error('Nested transactions are not supported');
      return run(() => root.begin((t) => fn(wrap(t, null))) as Promise<never>, false);
    },
    close: async () => void (await root?.end({ timeout: 5 })),
  };
}

/**
 * Production client. One connection per warm function instance is plenty:
 * each Netlify function instance serves one request at a time.
 */
export function createPostgresDb(url: string): Db {
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslOption(url),
    onnotice: () => {},
  });
  return wrap(sql, sql);
}
