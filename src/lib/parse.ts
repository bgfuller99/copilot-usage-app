import * as XLSX from 'xlsx';
import { decimalFromNumber, decimalFromPlain, type Decimal } from './decimal';

export interface UsageRecord {
  account: string;
  feature: string;
  model: string;
  /** Metric label exactly as it appears in the source (mapped to a canonical metric later). */
  metricLabel: string;
  /** Calendar date (YYYY-MM-DD) the source attaches to the value, e.g. week-end date. */
  date: string;
  value: Decimal;
  source: string;
}

export interface ParsedFile {
  fileName: string;
  sheetName: string;
  layout: 'wide' | 'long';
  /** Label of the date header in the source, e.g. "week_end_date". */
  dateHeader: string | null;
  records: UsageRecord[];
  warnings: string[];
}

export class WorkbookError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'WorkbookError';
    this.hint = hint;
  }
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Cell = XLSX.CellObject | undefined;

const RE = {
  feature: /^(copilot\s*)?(feature|product|surface|feature\s*name)$/i,
  metric: /^(metric|metric\s*name|measure)$/i,
  account: /account|customer|enterprise|organi[sz]ation|^org$/i,
  model: /model/i,
  date: /date|week|period|^day$|^month$/i,
  value: /^(value|amount|metric[\s_]*value|total)$/i,
};

const BLANK_TOKENS = new Set(['', '-', '—', '–', 'n/a', 'na', 'null', 'none']);

function text(cell: Cell): string {
  if (!cell || cell.v == null) return '';
  if (cell.t === 'n' && cell.w) return cell.w.trim();
  return String(cell.v).trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** Parse a date string. Slash dates default to US month/day order (Excel's default text form) unless impossible. */
export function parseDateString(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const a = +m[1];
    const b = +m[2];
    return a > 12 ? iso(y, b, a) : iso(y, a, b);
  }
  m = /^(\d{1,2})[\s-]([a-z]{3,9})[\s-,]+(\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi >= 0 ? iso(+m[3], mi + 1, +m[1]) : null;
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi >= 0 ? iso(+m[3], mi + 1, +m[2]) : null;
  }
  return null;
}

/** Excel serial date → ISO date without any timezone conversion. */
function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 120000) return null;
  const p = XLSX.SSF.parse_date_code(serial);
  return p ? iso(p.y, p.m, p.d) : null;
}

export function cellToIsoDate(cell: Cell): string | null {
  if (!cell || cell.v == null) return null;
  if (cell.t === 'n') return serialToIso(cell.v as number);
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (cell.t === 's') return parseDateString(String(cell.v));
  return null;
}

/** Parse a numeric cell: accepts numbers and formatted text like "$1,234.56", "(12.50)", "1 234". */
export function parseNumericCell(cell: Cell): { value: Decimal | null; invalid: boolean } {
  if (!cell || cell.v == null) return { value: null, invalid: false };
  if (cell.t === 'n') return { value: decimalFromNumber(cell.v as number), invalid: false };
  if (cell.t === 'b' || cell.t === 'e') return { value: null, invalid: cell.t === 'b' };
  let s = String(cell.v).trim();
  if (BLANK_TOKENS.has(s.toLowerCase())) return { value: null, invalid: false };
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/usd/gi, '').replace(/[$€£\s\u00a0,]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  const d = decimalFromPlain(s);
  if (!d) return { value: null, invalid: true };
  return { value: negative ? { int: -d.int, scale: d.scale } : d, invalid: false };
}

function buildGrid(ws: XLSX.WorkSheet): Cell[][] {
  if (!ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const grid: Cell[][] = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= range.e.c; c++) row.push(ws[XLSX.utils.encode_cell({ r, c })] as Cell);
    grid.push(row);
  }
  // Pivot exports merge repeated dimension labels; propagate the top-left value across the merge.
  for (const m of ws['!merges'] ?? []) {
    const src = grid[m.s.r]?.[m.s.c];
    if (!src) continue;
    for (let r = m.s.r; r <= m.e.r; r++)
      for (let c = m.s.c; c <= m.e.c; c++) if (!(r === m.s.r && c === m.s.c) && grid[r]) grid[r][c] = src;
  }
  return grid;
}

interface HeaderInfo {
  row: number;
  feature: number;
  metric: number;
  account: number;
  model: number;
  date: number;
  value: number;
}

function findHeader(grid: Cell[][]): HeaderInfo | null {
  const limit = Math.min(grid.length, 40);
  for (let r = 0; r < limit; r++) {
    const labels = grid[r].map(text);
    const idx = (re: RegExp, exclude: number[] = []) =>
      labels.findIndex((l, i) => l !== '' && re.test(l) && !exclude.includes(i));
    const feature = idx(RE.feature);
    if (feature < 0) continue;
    const metric = idx(RE.metric, [feature]);
    const account = idx(RE.account, [feature, metric]);
    const model = idx(RE.model, [feature, metric, account]);
    const date = idx(RE.date, [feature, metric, account, model]);
    const value = idx(RE.value, [feature, metric, account, model, date]);
    if (metric < 0 && date < 0) continue;
    return { row: r, feature, metric, account, model, date, value };
  }
  return null;
}

interface RowDims {
  account: string;
  feature: string;
  model: string;
}

class DimFiller {
  private last: RowDims = { account: '', feature: '', model: '' };
  private readonly h: HeaderInfo;
  constructor(h: HeaderInfo) {
    this.h = h;
  }
  read(row: Cell[]): RowDims {
    const pick = (col: number, prev: string) => (col < 0 ? '' : text(row[col]) || prev);
    const feature = pick(this.h.feature, this.last.feature);
    const changedFeature = feature !== this.last.feature;
    const dims = {
      account: pick(this.h.account, this.last.account),
      feature,
      model: this.h.model < 0 ? '' : text(row[this.h.model]) || (changedFeature ? '' : this.last.model),
    };
    this.last = dims;
    return dims;
  }
}

function addr(r: number, c: number) {
  return XLSX.utils.encode_cell({ r, c });
}

function summariseInvalid(cells: string[]): string | null {
  if (!cells.length) return null;
  const shown = cells.slice(0, 5).join(', ');
  return `${cells.length} cell(s) could not be read as numbers and were treated as blank (e.g. ${shown}). Check for text or error values in those cells.`;
}

function parseWide(grid: Cell[][], h: HeaderInfo, fileName: string, sheetName: string): ParsedFile | null {
  const dimCols = [h.feature, h.metric, h.account, h.model].filter((c) => c >= 0);
  const firstValueCol = Math.max(...dimCols) + 1;
  const width = Math.max(...grid.map((r) => r.length));
  const dateCols: { col: number; date: string }[] = [];
  let dateHeader: string | null = null;
  const undated: string[] = [];
  for (let c = firstValueCol; c < width; c++) {
    let found: string | null = null;
    for (let r = h.row; r >= 0 && !found; r--) {
      found = cellToIsoDate(grid[r][c]);
      if (found && dateHeader === null) {
        const label = grid[r].slice(0, firstValueCol).map(text).find((t) => t && RE.date.test(t));
        dateHeader = label ?? null;
      }
    }
    if (found) dateCols.push({ col: c, date: found });
    else if (grid.slice(h.row + 1).some((row) => text(row[c]) !== '')) undated.push(XLSX.utils.encode_col(c));
  }
  if (!dateCols.length) return null;

  const warnings: string[] = [];
  if (undated.length)
    warnings.push(`Ignored column(s) ${undated.join(', ')} because no date was found above them in the header rows.`);
  const dupDates = dateCols.filter((d, i) => dateCols.findIndex((x) => x.date === d.date) !== i);
  if (dupDates.length)
    warnings.push(`Date ${dupDates[0].date} appears in more than one column; values from all such columns are added together.`);

  const records: UsageRecord[] = [];
  const invalid: string[] = [];
  let skipped = 0;
  const filler = new DimFiller(h);
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r];
    const metricLabel = text(row[h.metric]);
    const hasValues = dateCols.some(({ col }) => text(row[col]) !== '');
    if (!metricLabel) {
      if (row.some((c) => text(c) !== '')) skipped++;
      continue;
    }
    const dims = filler.read(row);
    if (!dims.feature) {
      if (hasValues) skipped++;
      continue;
    }
    for (const { col, date } of dateCols) {
      const { value, invalid: bad } = parseNumericCell(row[col]);
      if (bad) invalid.push(addr(r, col));
      if (value) records.push({ ...dims, metricLabel, date, value, source: fileName });
    }
  }
  if (skipped) warnings.push(`Skipped ${skipped} row(s) without a Feature/Metric (e.g. filter notes or footers).`);
  const inv = summariseInvalid(invalid);
  if (inv) warnings.push(inv);
  return { fileName, sheetName, layout: 'wide', dateHeader, records, warnings };
}

function parseLong(grid: Cell[][], h: HeaderInfo, fileName: string, sheetName: string): ParsedFile | null {
  if (h.date < 0) return null;
  const header = grid[h.row].map(text);
  // Either a Metric + Value pair, or one column per metric.
  const metricCols: { col: number; label: string }[] =
    h.metric >= 0 && h.value >= 0
      ? []
      : header
          .map((label, col) => ({ col, label }))
          .filter(({ col, label }) => label && ![h.feature, h.account, h.model, h.date, h.metric].includes(col));
  if (h.metric >= 0 && h.value < 0 && !metricCols.length) return null;

  const records: UsageRecord[] = [];
  const invalid: string[] = [];
  let badDates = 0;
  let skipped = 0;
  const filler = new DimFiller(h);
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row.some((c) => text(c) !== '')) continue;
    const date = cellToIsoDate(row[h.date]);
    const dims = filler.read(row);
    if (!dims.feature) {
      skipped++;
      continue;
    }
    if (!date) {
      badDates++;
      continue;
    }
    const pairs =
      h.metric >= 0 && h.value >= 0
        ? [{ col: h.value, label: text(row[h.metric]) }]
        : metricCols;
    for (const { col, label } of pairs) {
      if (!label) continue;
      const { value, invalid: bad } = parseNumericCell(row[col]);
      if (bad) invalid.push(addr(r, col));
      if (value) records.push({ ...dims, metricLabel: label, date, value, source: fileName });
    }
  }
  const warnings: string[] = [];
  if (badDates) warnings.push(`Skipped ${badDates} row(s) whose "${header[h.date]}" value is not a recognisable date.`);
  if (skipped) warnings.push(`Skipped ${skipped} row(s) without a Feature value (e.g. notes or footers).`);
  const inv = summariseInvalid(invalid);
  if (inv) warnings.push(inv);
  return { fileName, sheetName, layout: 'long', dateHeader: header[h.date] || null, records, warnings };
}

export function parseWorkbook(data: ArrayBuffer | Uint8Array, fileName: string): ParsedFile {
  if (!/\.xlsx$/i.test(fileName))
    throw new WorkbookError(
      `"${fileName}" is not an .xlsx file.`,
      'Export the report from the source tool as Excel (.xlsx) and upload that file.',
    );
  if (data.byteLength === 0)
    throw new WorkbookError(`"${fileName}" is empty.`, 'Re-download the export; the file contains no data.');
  if (data.byteLength > MAX_FILE_BYTES)
    throw new WorkbookError(
      `"${fileName}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
      'Narrow the export (fewer weeks or accounts) or split it into several files and upload them together.',
    );

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new WorkbookError(
      `"${fileName}" is password-protected or an old-format workbook saved with an .xlsx name.`,
      'Remove the password (or re-save as "Excel Workbook (.xlsx)") and upload it again.',
    );
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b))
    throw new WorkbookError(
      `"${fileName}" is not a valid .xlsx workbook.`,
      'The file looks like plain text or another format renamed to .xlsx. Open it in Excel and use Save As → "Excel Workbook (.xlsx)", or re-download the export.',
    );

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, dense: false });
  } catch (e) {
    throw new WorkbookError(
      `"${fileName}" could not be opened as an Excel workbook (${(e as Error).message}).`,
      'The file may be corrupt, password-protected, or a different format renamed to .xlsx. Re-export it and try again.',
    );
  }

  const problems: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const grid = buildGrid(wb.Sheets[sheetName]);
    if (!grid.length) continue;
    const h = findHeader(grid);
    if (!h) {
      problems.push(`sheet "${sheetName}": no header row with "Feature" and "Metric" (or a date) columns`);
      continue;
    }
    if (h.metric >= 0 && h.date < 0 && h.value < 0) {
      const parsed = parseWide(grid, h, fileName, sheetName);
      if (parsed?.records.length) return parsed;
      problems.push(
        parsed
          ? `sheet "${sheetName}": headers found but every value cell is blank`
          : `sheet "${sheetName}": found Feature/Metric headers but no week date above the value columns`,
      );
      continue;
    }
    const long = parseLong(grid, h, fileName, sheetName);
    if (long?.records.length) return long;
    const wide = parseWide(grid, h, fileName, sheetName);
    if (wide?.records.length) return wide;
    problems.push(`sheet "${sheetName}": headers found but no numeric values with valid dates`);
  }

  throw new WorkbookError(
    `No usage data found in "${fileName}" (${problems.join('; ') || 'workbook has no sheets with data'}).`,
    'Expected either (a) a pivot export with columns Feature, Metric (optionally Account, Model) and one column per week whose header row contains the week date, or (b) a table with Feature, Date/Week, and either Metric + Value columns or one column per metric.',
  );
}
