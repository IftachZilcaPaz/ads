import { UpstreamError } from './errors.ts';
import type { TokenProvider } from './google-auth.ts';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface CellUpdate {
  range: string;
  values: string[][];
}

/** A1 notation for a tab name, quoted so Hebrew/space names are safe. */
export function a1(sheet: string, range?: string): string {
  const quoted = `'${sheet.replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The spreadsheet operations the app depends on (Google or in-memory). */
export interface SheetsPort {
  sheetTitles(): Promise<string[]>;
  addSheets(titles: string[]): Promise<void>;
  batchGet(ranges: string[]): Promise<string[][][]>;
  batchUpdate(data: CellUpdate[]): Promise<void>;
  append(range: string, rows: string[][]): Promise<void>;
}

/**
 * Minimal Sheets v4 REST client. Writes use valueInputOption=RAW so user text
 * is stored verbatim: no formula injection ("=IMPORTXML(...)") and no
 * auto-conversion of "2026-09-01 18:30" into a locale-dependent date cell.
 */
export class SheetsClient implements SheetsPort {
  constructor(
    private readonly spreadsheetId: string,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const token = await this.tokens.getToken();
    const res = await this.fetchImpl(`${API}/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
    if (RETRYABLE.has(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      return this.request(path, init, attempt + 1);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new UpstreamError(`Google Sheets ${res.status}: ${body?.error?.message ?? res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async sheetTitles(): Promise<string[]> {
    const body = await this.request<{ sheets?: { properties: { title: string } }[] }>('?fields=sheets.properties.title');
    return (body.sheets ?? []).map((s) => s.properties.title);
  }

  async addSheets(titles: string[]): Promise<void> {
    if (!titles.length) return;
    await this.request(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: titles.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
  }

  /** Returns one 2-D string grid per requested range, in order. */
  async batchGet(ranges: string[]): Promise<string[][][]> {
    const qs = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
    for (const r of ranges) qs.append('ranges', r);
    const body = await this.request<{ valueRanges?: { values?: unknown[][] }[] }>(`/values:batchGet?${qs}`);
    return ranges.map((_, i) =>
      (body.valueRanges?.[i]?.values ?? []).map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    );
  }

  async batchUpdate(data: CellUpdate[]): Promise<void> {
    if (!data.length) return;
    await this.request('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
  }

  async append(range: string, rows: string[][]): Promise<void> {
    const qs = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
    await this.request(`/values/${encodeURIComponent(range)}:append?${qs}`, {
      method: 'POST',
      body: JSON.stringify({ values: rows }),
    });
  }
}
