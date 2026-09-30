import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from './db.ts';
import { translateDbError } from './db.ts';

/** In-process Postgres (WASM) for tests and the local dev server. */
export async function createMemoryDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;

  const wrap = (conn: PGlite | Transaction, isRoot: boolean): Db => ({
    query: async <T>(text: string, params: unknown[] = []) => {
      try {
        return (await conn.query(text, params)).rows as T[];
      } catch (err) {
        throw translateDbError(err);
      }
    },
    exec: async (text) => {
      await conn.exec(text);
    },
    tx: (fn) => {
      if (!isRoot) throw new Error('Nested transactions are not supported');
      return pg.transaction((t) => fn(wrap(t, false)));
    },
    close: async () => {
      if (isRoot) await pg.close();
    },
  });
  return wrap(pg, true);
}
