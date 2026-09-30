import {
  BRAND_KEYS,
  CAMPAIGN_COLUMNS,
  CampaignSchema,
  PRODUCT_COLUMNS,
  ProductSchema,
  generateEntityId,
  parseEntity,
} from '../shared/catalog.ts';
import { APPROVAL_MODES, POST_COLUMNS, POST_STATUSES, POST_TYPES, cleanCaption, toPost, type Post } from '../shared/post.ts';
import { isValidLocal } from '../shared/time.ts';
import type { ZodType } from 'zod';
import type { Db } from './db/db.ts';

/** Raw tab grids as returned by Sheets (row 0 = headers). Missing tabs → []. */
export type SheetGrids = Record<'calendar' | 'campaigns' | 'products' | 'brand' | 'config', string[][]>;

export interface ImportReport {
  posts: number;
  campaigns: number;
  products: number;
  brand: number;
  settings: number;
  skipped: string[];
}

function records(grid: string[][]): Record<string, string>[] {
  const headers = (grid[0] ?? []).map((h) => h.trim());
  return grid.slice(1).map((cells) => Object.fromEntries(headers.filter(Boolean).map((h) => [h, cells[headers.indexOf(h)] ?? ''])));
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Coerces a legacy sheet row into something the schema's CHECKs accept. */
export function sanitizePost(record: Record<string, string>): Post | null {
  const post = toPost(record);
  if (!/^\S{1,64}$/.test(post.id)) return null;
  return {
    ...post,
    caption: cleanCaption(post.caption),
    publish_at: isValidLocal(post.publish_at) ? post.publish_at : '',
    type: oneOf(post.type, POST_TYPES, 'POST'),
    status: oneOf(post.status, POST_STATUSES, 'draft'),
    approval_mode: oneOf(post.approval_mode, APPROVAL_MODES, 'approve'),
  };
}

async function upsert(db: Db, table: string, key: string, rows: Record<string, string>[], columns: readonly string[], overwrite: boolean) {
  const conflict = overwrite
    ? `do update set ${columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ')}`
    : 'do nothing';
  let written = 0;
  for (const row of rows) {
    const res = await db.query(
      `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (${key}) ${conflict} returning ${key}`,
      columns.map((c) => row[c] ?? ''),
    );
    written += res.length;
  }
  return written;
}

/**
 * Copies the Google Sheet into Postgres. Idempotent: existing rows are kept
 * unless `overwrite` is set, so it is safe to run again.
 */
export async function importSheet(
  db: Db,
  grids: SheetGrids,
  opts: { overwrite?: boolean; apiToken?: string } = {},
): Promise<ImportReport> {
  const overwrite = !!opts.overwrite;
  const skipped: string[] = [];

  const posts: Post[] = [];
  for (const r of records(grids.calendar)) {
    if (!Object.values(r).some((v) => v.trim())) continue;
    const post = sanitizePost(r);
    if (post) posts.push(post);
    else skipped.push(`calendar: invalid id "${r.id ?? ''}"`);
  }

  const catalog = (grid: string[][], schema: ZodType<Record<string, string>>, prefix: 'c' | 'p', tab: string) =>
    records(grid).flatMap((r) => {
      if (!Object.values(r).some((v) => v.trim())) return [];
      const item = parseEntity(schema, r);
      if (!item) {
        skipped.push(`${tab}: invalid row "${r.name ?? r.id ?? ''}"`);
        return [];
      }
      return [{ ...item, id: item.id || generateEntityId(prefix) }];
    });

  const kv = (grid: string[][]) =>
    records(grid)
      .map((r) => ({ key: (r.key ?? '').trim(), value: String(r.value ?? '').trim() }))
      .filter((r) => r.key);

  const settings = kv(grids.config);
  if (opts.apiToken && !settings.some((s) => s.key === 'app_api_token')) settings.push({ key: 'app_api_token', value: opts.apiToken });
  const brand = kv(grids.brand).filter((r) => (BRAND_KEYS as string[]).includes(r.key));

  return db.tx(async (t) => ({
    posts: await upsert(t, 'posts', 'id', posts, POST_COLUMNS, overwrite),
    campaigns: await upsert(t, 'campaigns', 'id', catalog(grids.campaigns, CampaignSchema, 'c', 'campaigns'), CAMPAIGN_COLUMNS, overwrite),
    products: await upsert(t, 'products', 'id', catalog(grids.products, ProductSchema, 'p', 'products'), PRODUCT_COLUMNS, overwrite),
    brand: await upsert(t, 'brand', 'key', brand, ['key', 'value'], overwrite),
    settings: await upsert(t, 'settings', 'key', settings, ['key', 'value'], overwrite),
    skipped,
  }));
}
