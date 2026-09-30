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
import type { Db } from './db/db.ts';
import { ConflictError, NotFoundError } from './errors.ts';

/** Settings the browser may see. Never the Meta token or API secrets. */
const PUBLIC_SETTING_KEYS = ['cloudinary_cloud', 'cloudinary_preset'] as const;
export type PublicSettings = Record<(typeof PUBLIC_SETTING_KEYS)[number], string>;

export interface Snapshot {
  posts: Post[];
  campaigns: Campaign[];
  products: Product[];
  brand: Brand;
  settings: PublicSettings;
}

const quoted = (keys: readonly string[]) => keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');

/** Everything the app shows, in one round trip. */
const SNAPSHOT_SQL = `
select
  (select coalesce(jsonb_agg(to_jsonb(p) order by p.publish_at, p.id), '[]'::jsonb) from posts p where p.status <> 'archived') as posts,
  (select coalesce(jsonb_agg(to_jsonb(c) order by c.name), '[]'::jsonb) from campaigns c) as campaigns,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.name), '[]'::jsonb) from products x) as products,
  (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from brand) as brand,
  (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from settings where key in (${quoted(PUBLIC_SETTING_KEYS)})) as settings`;

const POST_UPDATE_COLUMNS = POST_COLUMNS.filter((c) => c !== 'id');
const UPDATE_POST_SQL = `update posts set ${POST_UPDATE_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`;
const INSERT_POST_SQL = `insert into posts (${POST_COLUMNS.join(', ')}) values (${POST_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
  on conflict (id) do nothing returning id`;

type CatalogKind = 'campaigns' | 'products';
const CATALOG = {
  campaigns: { schema: CampaignSchema, prefix: 'c', columns: CAMPAIGN_COLUMNS as readonly string[] },
  products: { schema: ProductSchema, prefix: 'p', columns: PRODUCT_COLUMNS as readonly string[] },
} as const;

/**
 * Repository over Postgres. Post mutations lock the row (SELECT ... FOR
 * UPDATE), so they serialize with n8n's claim/decide functions: a post can't
 * be edited or unapproved while it is being published, and vice versa.
 */
export class Store {
  constructor(private readonly db: Db) {}

  async snapshot(): Promise<Snapshot> {
    const [row] = await this.db.query<{
      posts: Record<string, string>[];
      campaigns: Record<string, string>[];
      products: Record<string, string>[];
      brand: Record<string, string>;
      settings: Record<string, string>;
    }>(SNAPSHOT_SQL);
    const settings = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, (row!.settings[k] ?? '').trim()])) as PublicSettings;
    return {
      posts: row!.posts.map(toPost),
      campaigns: row!.campaigns.map((r) => parseEntity(CampaignSchema, r)).filter((c): c is Campaign => !!c),
      products: row!.products.map((r) => parseEntity(ProductSchema, r)).filter((p): p is Product => !!p),
      brand: BrandSchema.parse(row!.brand),
      settings,
    };
  }

  // ---------- posts ----------

  private async insertPost(db: Db, post: Post): Promise<Post> {
    const rows = await db.query(INSERT_POST_SQL, POST_COLUMNS.map((c) => post[c]));
    if (!rows.length) throw new ConflictError(`כבר קיים פוסט עם המזהה ${post.id}`);
    return post;
  }

  createPost(input: NewPostInput): Promise<Post> {
    return this.insertPost(this.db, createPost(input));
  }

  private async lockPost(db: Db, id: string): Promise<Post> {
    const [row] = await db.query<Record<string, string>>('select * from posts where id = $1 for update', [id]);
    if (!row) throw new NotFoundError(`לא נמצא: ${id}`);
    return toPost(row);
  }

  private async savePost(db: Db, post: Post): Promise<void> {
    await db.query(UPDATE_POST_SQL, [post.id, ...POST_UPDATE_COLUMNS.map((c) => post[c])]);
  }

  private mutatePost(id: string, fn: (post: Post) => Post): Promise<Post> {
    return this.db.tx(async (t) => {
      const next = fn(await this.lockPost(t, id));
      await this.savePost(t, next);
      return next;
    });
  }

  editPost(id: string, changes: PostChanges): Promise<Post> {
    return this.mutatePost(id, (post) => applyEdit(post, changes));
  }

  actOnPost(id: string, action: PostAction): Promise<Post> {
    return this.mutatePost(id, (post) => transition(post, action));
  }

  /** Applies an action to many posts in one transaction. Invalid ones are reported, not fatal. */
  bulkAct(ids: string[], action: PostAction): Promise<{ updated: Post[]; failed: { id: string; error: string }[] }> {
    return this.db.tx(async (t) => {
      const updated: Post[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const id of new Set(ids)) {
        try {
          const next = transition(await this.lockPost(t, id), action);
          await this.savePost(t, next);
          updated.push(next);
        } catch (err) {
          if (!(err instanceof DomainError || err instanceof NotFoundError)) throw err;
          failed.push({ id, error: err.message });
        }
      }
      return { updated, failed };
    });
  }

  async duplicatePost(id: string): Promise<Post> {
    const [row] = await this.db.query<Record<string, string>>('select * from posts where id = $1', [id]);
    if (!row) throw new NotFoundError(`לא נמצא: ${id}`);
    const source = toPost(row);
    return this.insertPost(
      this.db,
      createPost({
        type: source.type,
        media_urls: source.media_urls,
        caption: source.caption,
        approval_mode: source.approval_mode,
        campaign_id: source.campaign_id,
        product_id: source.product_id,
        notes: source.notes,
        intent: 'draft',
      }),
    );
  }

  // ---------- campaigns / products ----------

  saveCampaign(input: Record<string, unknown>, existingId?: string): Promise<Campaign> {
    return this.saveCatalogItem('campaigns', input, existingId).then((r) => CampaignSchema.parse(r));
  }

  saveProduct(input: Record<string, unknown>, existingId?: string): Promise<Product> {
    return this.saveCatalogItem('products', input, existingId).then((r) => ProductSchema.parse(r));
  }

  private async saveCatalogItem(kind: CatalogKind, input: Record<string, unknown>, existingId?: string): Promise<Record<string, string>> {
    const { schema, prefix, columns } = CATALOG[kind];
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message);
      throw new DomainError(issues[0] ?? 'נתונים לא תקינים', issues);
    }
    const item: Record<string, string> = { ...parsed.data };
    const fields = columns.filter((c) => c !== 'id');

    if (existingId) {
      const rows = await this.db.query(
        `update ${kind} set ${fields.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning id`,
        [existingId, ...fields.map((c) => item[c] ?? '')],
      );
      if (!rows.length) throw new NotFoundError(`לא נמצא: ${existingId}`);
      return { ...item, id: existingId };
    }

    const created: Record<string, string> = { ...item, id: item.id || generateEntityId(prefix) };
    const rows = await this.db.query(
      `insert into ${kind} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (id) do nothing returning id`,
      columns.map((c) => created[c] ?? ''),
    );
    if (!rows.length) throw new ConflictError(`המזהה ${created.id} כבר קיים`);
    return created;
  }

  // ---------- brand ----------

  async saveBrand(input: Record<string, unknown>): Promise<Brand> {
    const parsed = BrandSchema.safeParse(input);
    if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? 'נתונים לא תקינים');
    const brand = parsed.data;
    await this.db.tx(async (t) => {
      for (const key of BRAND_KEYS) {
        await t.query('insert into brand (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [
          key,
          String(brand[key]),
        ]);
      }
    });
    return brand;
  }
}
