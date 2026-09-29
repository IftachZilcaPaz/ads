import type { Brand } from '../../shared/catalog.ts';
import { api } from '../api.ts';
import { EntityForm, type FieldSpec } from '../components/EntityForm.tsx';
import { useApp } from '../state.tsx';

const FIELDS: FieldSpec<Record<string, string>>[] = [
  { key: 'name', label: 'שם העסק', placeholder: 'Reynovation' },
  { key: 'signature', label: 'חתימה קבועה (לא חובה)', placeholder: 'צוות Reynovation 🛠' },
  { key: 'description', label: 'מה העסק עושה', kind: 'textarea', placeholder: 'שיפוצים ועיצוב פנים בגוש דן, מטבחים ואמבטיות' },
  { key: 'audience', label: 'למי אנחנו מדברים', kind: 'textarea', placeholder: 'זוגות 30-50 שקנו דירה ורוצים שיפוץ בלי כאב ראש' },
  { key: 'voice', label: 'הטון שלנו', kind: 'textarea', placeholder: 'חם, מקצועי, בגובה העיניים, קצת הומור. מדברים בגוף ראשון רבים' },
  { key: 'do', label: 'תמיד', kind: 'textarea', placeholder: 'להראות תוצאה אמיתית, להזכיר עמידה בלו״ז' },
  { key: 'dont', label: 'אף פעם', kind: 'textarea', placeholder: 'לא להבטיח מחירים, לא סלנג בוטה, לא להשוות למתחרים' },
  { key: 'default_hashtags', label: 'האשטגים קבועים', wide: true, placeholder: '#שיפוצים #עיצובפנים' },
  { key: 'cta', label: 'קריאה לפעולה ברירת מחדל', wide: true, placeholder: 'לתיאום פגישת ייעוץ - הודעה בפרטי' },
  {
    key: 'emoji',
    label: 'אימוג׳ים',
    kind: 'select',
    options: [
      ['none', 'בלי'],
      ['light', 'מעט'],
      ['rich', 'הרבה'],
    ],
  },
  {
    key: 'language',
    label: 'שפה',
    kind: 'select',
    options: [
      ['he', 'עברית'],
      ['en', 'אנגלית'],
      ['he+en', 'עברית + שורה באנגלית'],
    ],
  },
];

export function BrandView() {
  const { data, run, setBrand } = useApp();
  if (!data) return null;

  return (
    <div class="brand-page">
      <header class="page-head">
        <h1>🎙 קול המותג</h1>
        <p class="muted">עוזר הקפשנים קורא את זה לפני כל קפשן. ככל שזה מדויק יותר - פחות תצטרך לתקן.</p>
      </header>
      <EntityForm
        fields={FIELDS}
        value={data.brand as unknown as Record<string, string>}
        onSubmit={async (value) => {
          const saved = await run(() => api.saveBrand(value as unknown as Brand), 'קול המותג נשמר');
          if (saved) setBrand(saved);
        }}
      />
    </div>
  );
}
