import type { CellUpdate, SheetsPort } from './sheets.ts';

/**
 * In-memory stand-in for SheetsClient (same surface Store uses). Powers unit
 * tests and the local dev server (`npm run dev`), so the app can run without Google access.
 */
export class MemorySheets implements SheetsPort {
  readonly tabs = new Map<string, string[][]>();
  writes: CellUpdate[] = [];

  private tabOf(range: string): string {
    const m = /^'((?:[^']|'')+)'/.exec(range);
    if (!m) throw new Error(`Unquoted range: ${range}`);
    return m[1]!.replace(/''/g, "'");
  }

  private grid(range: string): string[][] {
    const grid = this.tabs.get(this.tabOf(range));
    if (!grid) throw new Error(`No such tab: ${range}`);
    return grid;
  }

  async sheetTitles(): Promise<string[]> {
    return [...this.tabs.keys()];
  }

  async addSheets(titles: string[]): Promise<void> {
    for (const t of titles) if (!this.tabs.has(t)) this.tabs.set(t, []);
  }

  async batchGet(ranges: string[]): Promise<string[][][]> {
    return ranges.map((r) => {
      const grid = this.grid(r);
      return (r.endsWith('!1:1') ? grid.slice(0, 1) : grid).map((row) => [...row]);
    });
  }

  async batchUpdate(data: CellUpdate[]): Promise<void> {
    for (const u of data) {
      this.writes.push(u);
      const grid = this.grid(u.range);
      const m = /!([A-Z]+)(\d+)/.exec(u.range);
      if (!m) throw new Error(`Bad range ${u.range}`);
      let col = 0;
      for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(m[2]) - 1;
      u.values.forEach((values, r) => {
        const target = (grid[row + r] ??= []);
        values.forEach((v, i) => (target[col - 1 + i] = v));
      });
    }
  }

  async append(range: string, rows: string[][]): Promise<void> {
    this.grid(range).push(...rows.map((r) => [...r]));
  }
}
