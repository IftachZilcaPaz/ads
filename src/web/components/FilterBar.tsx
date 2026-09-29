import type { PostFilter } from '../hooks.ts';
import { useApp } from '../state.tsx';

interface Props {
  filter: PostFilter;
  onChange: (f: PostFilter) => void;
}

export function FilterBar({ filter, onChange }: Props) {
  const { data } = useApp();
  if (!data) return null;
  return (
    <div class="filter-bar">
      <input
        type="search"
        placeholder="חיפוש בקפשנים..."
        value={filter.query}
        onInput={(e) => onChange({ ...filter, query: e.currentTarget.value })}
      />
      {data.campaigns.length > 0 && (
        <select value={filter.campaign} onChange={(e) => onChange({ ...filter, campaign: e.currentTarget.value })}>
          <option value="">כל הקמפיינים</option>
          {data.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {data.products.length > 0 && (
        <select value={filter.product} onChange={(e) => onChange({ ...filter, product: e.currentTarget.value })}>
          <option value="">כל המוצרים</option>
          {data.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
