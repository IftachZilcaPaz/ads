import { a1, columnLetter, type CellUpdate, type SheetsPort } from './sheets.ts';

export interface TableRow {
  /** 1-based sheet row number (row 1 is the header). */
  rowNumber: number;
  record: Record<string, string>;
}

export interface Table {
  name: string;
  headers: string[];
  rows: TableRow[];
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

export function parseGrid(name: string, grid: string[][], keyColumn = 'id'): Table {
  const headers = (grid[0] ?? []).map((h) => h.trim());
  const keyIndex = headers.indexOf(keyColumn);
  const rows: TableRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    if (keyIndex >= 0 && !(cells[keyIndex] ?? '').trim()) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, c) => {
      if (h) record[h] = cells[c] ?? '';
    });
    rows.push({ rowNumber: i + 1, record });
  }
  return { name, headers, rows };
}

export function findRow(table: Table, key: string, keyColumn = 'id'): TableRow {
  const row = table.rows.find((r) => (r.record[keyColumn] ?? '').trim() === key);
  if (!row) throw new NotFoundError(`לא נמצא: ${key}`);
  return row;
}

export function rowValues(headers: string[], record: Record<string, string>): string[] {
  return headers.map((h) => record[h] ?? '');
}

/**
 * Cell-level updates for only the columns that changed. Writing single cells
 * (instead of the whole row) avoids clobbering columns n8n may have written
 * between our read and our write (status, ig_media_id, error...).
 */
export function diffUpdates(table: Table, row: TableRow, next: Record<string, string>): CellUpdate[] {
  const updates: CellUpdate[] = [];
  table.headers.forEach((header, c) => {
    if (!header || !(header in next)) return;
    const value = next[header] ?? '';
    if ((row.record[header] ?? '') === value) return;
    updates.push({ range: a1(table.name, `${columnLetter(c)}${row.rowNumber}`), values: [[value]] });
  });
  return updates;
}

export interface TabSpec {
  name: string;
  columns: readonly string[];
}

/**
 * Creates missing tabs and appends missing header columns, so upgrading an
 * existing spreadsheet needs no manual migration. Never reorders or removes.
 */
export async function ensureTabs(sheets: SheetsPort, specs: TabSpec[]): Promise<void> {
  const existing = new Set(await sheets.sheetTitles());
  await sheets.addSheets(specs.filter((s) => !existing.has(s.name)).map((s) => s.name));

  const headerRows = await sheets.batchGet(specs.map((s) => a1(s.name, '1:1')));
  const updates: CellUpdate[] = [];
  specs.forEach((spec, i) => {
    const headers = (headerRows[i]?.[0] ?? []).map((h) => h.trim());
    const missing = spec.columns.filter((c) => !headers.includes(c));
    if (!missing.length) return;
    const start = headers.length;
    updates.push({
      range: a1(spec.name, `${columnLetter(start)}1:${columnLetter(start + missing.length - 1)}1`),
      values: [[...missing]],
    });
  });
  await sheets.batchUpdate(updates);
}
