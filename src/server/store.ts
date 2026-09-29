import {
  BRAND_KEYS,
  BrandSchema,
  CAMPAIGN_COLUMNS,
  CampaignSchema,
  PRODUCT_COLUMNS,
  ProductSchema,
  generateEntityId,
  parseEntity,
  type Brand,
  type Campaign,
  type Product,
} from '../shared/catalog.ts';
import {
  DomainError,
  POST_COLUMNS,
  applyEdit,
  createPost,
  toPost,
  transition,
  type NewPostInput,
  type Post,
  type PostAction,
  type PostChanges,
} from '../shared/post.ts';
import { a1, type SheetsPort } from './sheets.ts';
import { ConflictError, diffUpdates, ensureTabs, findRow, parseGrid, rowValues, type Table, type TabSpec } from './table.ts';

export const TABS = {
  calendar: 'calendar',
  campaigns: 'campaigns',
  products: 'products',
  brand: 'brand',
  config: 'config',
} as const;

const SPECS: TabSpec[] = [
  { name: TABS.calendar, columns: POST_COLUMNS },
  { name: TABS.campaigns, columns: CAMPAIGN_COLUMNS },
  { name: TABS.products, columns: PRODUCT_COLUMNS },
  { name: TABS.brand, columns: ['key', 'value'] },
  { name: TABS.config, columns: ['key', 'value'] },
];

/** Config keys that are safe to expose to the browser. Never the Meta token. */
const PUBLIC_CONFIG_KEYS = ['cloudinary_cloud', 'cloudinary_preset'] as const;
export type PublicSettings = Record<(typeof PUBLIC_CONFIG_KEYS)[number], string>;

export interface Snapshot {
  posts: Post[];
  campaigns: Campaign[];
  products: Product[];
  brand: Brand;
  settings: PublicSettings;
}

type CatalogKind = 'campaigns' | 'products';
const CATALOG = {
  campaigns: { schema: CampaignSchema, prefix: 'c' },
  products: { schema: ProductSchema, prefix: 'p' },
} as const;

function kvRecord(table: Table): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { record } of table.rows) out[(record.key ?? '').trim()] = record.value ?? '';
  return out;
}

/**
 * Repository over the spreadsheet. Every operation reads fresh data (the
 * sheet is small and is also written by n8n), then writes the minimal diff.
 */
export class Store {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly sheets: SheetsPort) {}

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= ensureTabs(this.sheets, SPECS).catch((err: unknown) => {
      this.schemaReady = null;
      throw err;
    });
    return this.schemaReady;
  }

  private async read(names: string[], keyColumns: Record<string, string> = {}): Promise<Table[]> {
    await this.ensureSchema();
    const grids = await this.sheets.batchGet(names.map((n) => a1(n)));
    return names.map((n, i) => parseGrid(n, grids[i] ?? [], keyColumns[n] ?? 'id'));
  }

  private async readOne(name: string, keyColumn = 'id'): Promise<Table> {
    const [table] = await this.read([name], { [name]: keyColumn });
    return table!;
  }

  async snapshot(): Promise<Snapshot> {
    const [calendar, campaigns, products, brand, config] = await this.read(
      [TABS.calendar, TABS.campaigns, TABS.products, TABS.brand, TABS.config],
      { [TABS.brand]: 'key', [TABS.config]: 'key' },
    );
    const cfg = kvRecord(config!);
    return {
      posts: calendar!.rows.map((r) => toPost(r.record)),
      campaigns: campaigns!.rows.map((r) => parseEntity(CampaignSchema, r.record)).filter((c): c is Campaign => !!c),
      products: products!.rows.map((r) => parseEntity(ProductSchema, r.record)).filter((p): p is Product => !!p),
      brand: BrandSchema.parse(kvRecord(brand!)),
      settings: Object.fromEntries(PUBLIC_CONFIG_KEYS.map((k) => [k, (cfg[k] ?? '').trim()])) as PublicSettings,
    };
  }

  // ---------- posts ----------

  async createPost(input: NewPostInput): Promise<Post> {
    const table = await this.readOne(TABS.calendar);
    const post = createPost(input);
    if (table.rows.some((r) => r.record.id === post.id)) throw new ConflictError(`כבר קיים פוסט עם המזהה ${post.id}`);
    await this.sheets.append(a1(TABS.calendar), [rowValues(table.headers, post)]);
    return post;
  }

  private async mutatePost(id: string, fn: (post: Post) => Post): Promise<Post> {
    const table = await this.readOne(TABS.calendar);
    const row = findRow(table, id);
    const next = fn(toPost(row.record));
    await this.sheets.batchUpdate(diffUpdates(table, row, next));
    return next;
  }

  editPost(id: string, changes: PostChanges): Promise<Post> {
    return this.mutatePost(id, (post) => applyEdit(post, changes));
  }

  actOnPost(id: string, action: PostAction): Promise<Post> {
    return this.mutatePost(id, (post) => transition(post, action));
  }

  /** Applies an action to many posts in one read + one write. Invalid ones are reported, not fatal. */
  async bulkAct(ids: string[], action: PostAction): Promise<{ updated: Post[]; failed: { id: string; error: string }[] }> {
    const table = await this.readOne(TABS.calendar);
    const updated: Post[] = [];
    const failed: { id: string; error: string }[] = [];
    const writes = [];
    for (const id of new Set(ids)) {
      try {
        const row = findRow(table, id);
        const next = transition(toPost(row.record), action);
        writes.push(...diffUpdates(table, row, next));
        updated.push(next);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.sheets.batchUpdate(writes);
    return { updated, failed };
  }

  async duplicatePost(id: string): Promise<Post> {
    const table = await this.readOne(TABS.calendar);
    const source = toPost(findRow(table, id).record);
    const copy = createPost({
      type: source.type,
      media_urls: source.media_urls,
      caption: source.caption,
      approval_mode: source.approval_mode,
      campaign_id: source.campaign_id,
      product_id: source.product_id,
      notes: source.notes,
      intent: 'draft',
    });
    await this.sheets.append(a1(TABS.calendar), [rowValues(table.headers, copy)]);
    return copy;
  }

  // ---------- campaigns / products ----------

  saveCampaign(input: Record<string, unknown>, existingId?: string): Promise<Campaign> {
    return this.saveCatalogItem('campaigns', input, existingId).then((r) => CampaignSchema.parse(r));
  }

  saveProduct(input: Record<string, unknown>, existingId?: string): Promise<Product> {
    return this.saveCatalogItem('products', input, existingId).then((r) => ProductSchema.parse(r));
  }

  private async saveCatalogItem(
    kind: CatalogKind,
    input: Record<string, unknown>,
    existingId?: string,
  ): Promise<Record<string, string>> {
    const { schema, prefix } = CATALOG[kind];
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message);
      throw new DomainError(issues[0] ?? 'נתונים לא תקינים', issues);
    }
    const item: Record<string, string> = { ...parsed.data };
    const table = await this.readOne(kind);

    if (existingId) {
      const row = findRow(table, existingId);
      const next = { ...item, id: existingId };
      await this.sheets.batchUpdate(diffUpdates(table, row, next));
      return next;
    }

    const id = item.id || generateEntityId(prefix);
    if (table.rows.some((r) => r.record.id === id)) throw new ConflictError(`המזהה ${id} כבר קיים`);
    const created = { ...item, id };
    await this.sheets.append(a1(kind), [rowValues(table.headers, created)]);
    return created;
  }

  // ---------- brand ----------

  async saveBrand(input: Record<string, unknown>): Promise<Brand> {
    const parsed = BrandSchema.safeParse(input);
    if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'נתונים לא תקינים');
    const brand = parsed.data;
    const table = await this.readOne(TABS.brand, 'key');

    const updates = [];
    const appends: string[][] = [];
    for (const key of BRAND_KEYS) {
      const value = String(brand[key]);
      const row = table.rows.find((r) => r.record.key === key);
      if (row) updates.push(...diffUpdates(table, row, { key, value }));
      else appends.push(rowValues(table.headers, { key, value }));
    }
    await this.sheets.batchUpdate(updates);
    if (appends.length) await this.sheets.append(a1(TABS.brand), appends);
    return brand;
  }
}
