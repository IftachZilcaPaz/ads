/** Meta permissions this system uses, why, and whether publishing depends on them. */
export interface MetaScope {
  scope: string;
  label: string;
  /** Without it the publisher stops working, so a new token must keep it. */
  publishing?: boolean;
}

export const META_SCOPES: readonly MetaScope[] = [
  { scope: 'instagram_basic', label: 'פרטי חשבון האינסטגרם', publishing: true },
  { scope: 'instagram_content_publish', label: 'פרסום פוסטים', publishing: true },
  { scope: 'pages_show_list', label: 'גישה לדף שמחובר לאינסטגרם', publishing: true },
  { scope: 'pages_read_engagement', label: 'קריאת הדף' },
  { scope: 'instagram_manage_insights', label: 'נתונים אורגניים בדף הקמפיין' },
  { scope: 'ads_read', label: 'נתוני מודעות ממומנות' },
  { scope: 'ads_management', label: 'יצירת קמפיין מושהה ב-Meta' },
  { scope: 'business_management', label: 'גישה לנכסי העסק' },
];

export const PUBLISHING_SCOPES = META_SCOPES.filter((s) => s.publishing).map((s) => s.scope);
