import { ConflictError, UpstreamError } from '../errors.ts';

export type Row = Record<string, unknown>;

/** The narrow database surface the app needs; implemented by postgres.js and PGlite. */
export interface Db {
  /** One parameterized statement ($1, $2...). */
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Several statements, no parameters (migrations). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in a transaction; nested calls are not supported. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

export function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return !!code && CONNECTION_CODES.has(code);
}

/** Normalizes driver errors into the app's error types. */
export function translateDbError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23505') return new ConflictError('הרשומה כבר קיימת');
  if (isConnectionError(err)) {
    console.error(err);
    return new UpstreamError('מסד הנתונים לא זמין כרגע, נסה שוב');
  }
  return err;
}
