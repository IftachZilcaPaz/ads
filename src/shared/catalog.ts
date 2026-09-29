import { z } from 'zod';
import { LOCAL_DATE_RE } from './time.ts';

/** Short, URL/Telegram friendly ids (used as #tags when sending photos to the bot). */
export const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const text = (max: number) => z.string().trim().max(max).default('');
const optionalDate = z
  .string()
  .trim()
  .refine((v) => v === '' || LOCAL_DATE_RE.test(v), 'תאריך בפורמט YYYY-MM-DD')
  .default('');
const entityId = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === '' || ENTITY_ID_RE.test(v), 'מזהה: אותיות אנגליות קטנות, ספרות, - או _')
  .default('');

export const CAMPAIGN_STATUSES = ['active', 'paused', 'ended'] as const;

export const CampaignSchema = z.object({
  id: entityId,
  name: z.string().trim().min(1, 'חסר שם קמפיין').max(120),
  status: z.enum(CAMPAIGN_STATUSES).catch('active'),
  start_date: optionalDate,
  end_date: optionalDate,
  goal: text(500),
  audience: text(500),
  key_message: text(1000),
  offer: text(500),
  cta: text(200),
  hashtags: text(500),
  link: text(500),
  tone: text(300),
  notes: text(2000),
});
export type Campaign = z.infer<typeof CampaignSchema>;
export const CAMPAIGN_COLUMNS = Object.keys(CampaignSchema.shape) as (keyof Campaign)[];

export const PRODUCT_STATUSES = ['active', 'archived'] as const;

export const ProductSchema = z.object({
  id: entityId,
  name: z.string().trim().min(1, 'חסר שם מוצר').max(120),
  status: z.enum(PRODUCT_STATUSES).catch('active'),
  category: text(120),
  description: text(2000),
  benefits: text(1000),
  price: text(60),
  url: text(500),
  hashtags: text(500),
  notes: text(2000),
});
export type Product = z.infer<typeof ProductSchema>;
export const PRODUCT_COLUMNS = Object.keys(ProductSchema.shape) as (keyof Product)[];

export const BrandSchema = z.object({
  name: text(120),
  description: text(1000),
  audience: text(1000),
  voice: text(2000),
  do: text(2000),
  dont: text(2000),
  default_hashtags: text(500),
  cta: text(300),
  signature: text(300),
  emoji: z.enum(['none', 'light', 'rich']).catch('light'),
  language: z.enum(['he', 'en', 'he+en']).catch('he'),
});
export type Brand = z.infer<typeof BrandSchema>;
export const BRAND_KEYS = Object.keys(BrandSchema.shape) as (keyof Brand)[];

/** Coerces a raw sheet record into an entity, tolerating legacy/blank cells. */
export function parseEntity<T>(schema: z.ZodType<T>, record: Record<string, string>): T | null {
  const result = schema.safeParse(record);
  return result.success ? result.data : null;
}

export function generateEntityId(prefix: 'c' | 'p', random: () => number = Math.random): string {
  return `${prefix}-${Math.floor(random() * 36 ** 5)
    .toString(36)
    .padStart(5, '0')}`;
}

export function isCampaignLive(c: Campaign, today: string): boolean {
  if (c.status !== 'active') return false;
  if (c.start_date && today < c.start_date) return false;
  if (c.end_date && today > c.end_date) return false;
  return true;
}

export function splitHashtags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((t) => t.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .map((t) => `#${t}`),
    ),
  ];
}
