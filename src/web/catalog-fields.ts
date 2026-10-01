import { CAMPAIGN_COLUMNS, PRODUCT_COLUMNS } from '../shared/catalog.ts';
import type { FieldSpec } from './components/EntityForm.tsx';

export type Row = Record<string, string>;

const ID_HINT = 'אותיות אנגליות קטנות/ספרות. אפשר לכתוב #המזהה בטלגרם כדי לשייך תמונה';

export const CAMPAIGN_FIELDS: FieldSpec<Row>[] = [
  { key: 'name', label: 'שם הקמפיין', placeholder: 'למשל: מבצע חגים' },
  { key: 'id', label: 'מזהה קצר (לא חובה)', placeholder: 'holidays', hint: ID_HINT },
  { key: 'status', label: 'סטטוס', kind: 'select', options: [['active', 'פעיל'], ['paused', 'מושהה'], ['ended', 'הסתיים']] },
  { key: 'cta', label: 'קריאה לפעולה', placeholder: 'שלחו הודעה לתיאום' },
  { key: 'start_date', label: 'התחלה', kind: 'date' },
  { key: 'end_date', label: 'סיום', kind: 'date' },
  { key: 'goal', label: 'מטרה', kind: 'textarea', placeholder: 'לידים לשיפוץ מטבחים לפני החגים' },
  { key: 'audience', label: 'קהל יעד', kind: 'textarea' },
  { key: 'key_message', label: 'מסר מרכזי', kind: 'textarea' },
  { key: 'offer', label: 'הצעה / מבצע', kind: 'textarea', hint: 'ה-AI לא ימציא מבצעים שלא כתובים כאן' },
  { key: 'tone', label: 'טון מיוחד לקמפיין', wide: true },
  { key: 'hashtags', label: 'האשטגים קבועים', wide: true, placeholder: '#שיפוץ #מטבח' },
  { key: 'link', label: 'קישור', kind: 'url', wide: true },
  { key: 'notes', label: 'הערות', kind: 'textarea' },
  {
    key: 'meta_campaign_id',
    label: 'מזהה הקמפיין ב-Meta (לא חובה)',
    placeholder: '120200000000000000',
    hint: 'מ-Ads Manager. מקשר את נתוני המודעות הממומנות לקמפיין הזה',
  },
];

export const PRODUCT_FIELDS: FieldSpec<Row>[] = [
  { key: 'name', label: 'שם המוצר / השירות' },
  { key: 'id', label: 'מזהה קצר (לא חובה)', hint: ID_HINT },
  { key: 'category', label: 'קטגוריה' },
  { key: 'price', label: 'מחיר', placeholder: 'החל מ-₪...' },
  { key: 'status', label: 'סטטוס', kind: 'select', options: [['active', 'פעיל'], ['archived', 'בארכיון']] },
  { key: 'url', label: 'קישור', kind: 'url' },
  { key: 'description', label: 'תיאור', kind: 'textarea' },
  { key: 'benefits', label: 'יתרונות מרכזיים', kind: 'textarea' },
  { key: 'hashtags', label: 'האשטגים', wide: true },
  { key: 'notes', label: 'הערות', kind: 'textarea' },
];

export function blank(columns: readonly string[]): Row {
  return Object.fromEntries(columns.map((c) => [c, ''])) as Row;
}

export { CAMPAIGN_COLUMNS, PRODUCT_COLUMNS };
