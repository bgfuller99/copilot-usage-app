import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDataset, buildPeriods, combineFiles, filterModels, summarise, summariseModels } from '../aggregate';
import { modelsToCsv, summaryToCsv } from '../csv';
import { add, compare, decimalFromInput, decimalFromPlain, toPlainString } from '../decimal';
import { defaultMapping, suggestMetric } from '../metrics';
import { parseDateString, parseNumericCell, parseWorkbook, WorkbookError } from '../parse';

// Excel serials for 2026-09-12, -19, -26, 2026-10-03 (synthetic data only).
const SERIALS = [46277, 46284, 46291, 46298];

function toXlsx(sheets: Record<string, XLSX.WorkSheet>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, ws, name);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

/** Synthetic pivot export mirroring the real layout: date row, header row, merged dims, formatted strings, footer. */
function pivotWorkbook(opts: { footer?: boolean; serials?: number[]; rows?: (string | null)[][] } = {}) {
  const serials = opts.serials ?? SERIALS;
  const aoa: unknown[][] = [
    ['week_end_date', null, null, null, ...serials],
    ['Account', 'Feature', 'Model Family', 'Metric', ...serials.map(() => 'First metric_display')],
    ...(opts.rows ?? [
      ['Acme', 'CLI', 'model-a', 'UBB Active Users', '3', '4', '', '2'],
      [null, null, null, 'AI Units Consumed', '1,000.10', '2,000.20', '', '0.01'],
      [null, null, null, 'Gross Usage $', '$10.01', '$20.00', '', '$0.00'],
      [null, null, null, 'Billable Usage $', '$1.10', '$20.00', '', '$0.00'],
      [null, null, 'model-b', 'UBB Active Users', '2', '3', '1', ''],
      [null, null, null, 'AI Units Consumed', '0.1', '0.2', '1,234,567.89', ''],
      [null, null, null, 'Gross Usage $', '$0.01', '$0.02', '$12,345.68', ''],
      [null, null, null, 'Billable Usage $', '$0.00', '$0.02', '$12,345.68', ''],
      [null, 'Coding Agent', 'model-a', 'UBB Active Users', '5', '6', '7', '8'],
      [null, null, null, 'AI Units Consumed', '', '', '', ''],
      [null, null, null, 'Gross Usage $', '', '', '', ''],
      [null, null, null, 'Billable Usage $', '', '', '', ''],
    ]),
  ];
  if (opts.footer !== false) aoa.push(['Applied filters:\nsome filter text']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  serials.forEach((_, i) => {
    ws[XLSX.utils.encode_cell({ r: 0, c: 4 + i })].z = 'mm/dd/yyyy';
  });
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  if (!opts.rows)
    ws['!merges'].push(
      { s: { r: 2, c: 2 }, e: { r: 5, c: 2 } },
      { s: { r: 6, c: 2 }, e: { r: 9, c: 2 } },
      { s: { r: 2, c: 1 }, e: { r: 9, c: 1 } },
      { s: { r: 10, c: 2 }, e: { r: 13, c: 2 } },
      { s: { r: 10, c: 1 }, e: { r: 13, c: 1 } },
      { s: { r: 2, c: 0 }, e: { r: 13, c: 0 } },
    );
  return toXlsx({ Export: ws });
}

describe('value and date parsing', () => {
  it('parses formatted currency/number strings exactly', () => {
    const v = (s: string) => parseNumericCell({ t: 's', v: s }).value;
    expect(toPlainString(v('$1,234.56')!)).toBe('1234.56');
    expect(toPlainString(v('(12.50)')!)).toBe('-12.5');
    expect(toPlainString(v('-$0.30')!)).toBe('-0.3');
    expect(toPlainString(v('USD 7')!)).toBe('7');
    expect(v('')).toBeNull();
    expect(v('—')).toBeNull();
    expect(parseNumericCell({ t: 's', v: 'abc' }).invalid).toBe(true);
  });

  it('adds decimals without floating point drift', () => {
    const r = add(decimalFromPlain('0.1')!, decimalFromPlain('0.2')!);
    expect(toPlainString(r)).toBe('0.3');
  });

  it('parses common date string forms without timezone shifts', () => {
    expect(parseDateString('2026-09-12')).toBe('2026-09-12');
    expect(parseDateString('09/12/2026')).toBe('2026-09-12');
    expect(parseDateString('19/09/2026')).toBe('2026-09-19');
    expect(parseDateString('12 Sep 2026')).toBe('2026-09-12');
    expect(parseDateString('Sep 12, 2026')).toBe('2026-09-12');
    expect(parseDateString('not a date')).toBeNull();
  });
});

describe('parseWorkbook (pivot layout)', () => {
  it('reads dates, fills merged dimensions and skips the filter footer', () => {
    const parsed = parseWorkbook(pivotWorkbook(), 'export.xlsx');
    expect(parsed.layout).toBe('wide');
    expect(parsed.dateHeader).toBe('week_end_date');
    const dates = [...new Set(parsed.records.map((r) => r.date))].sort();
    expect(dates).toEqual(['2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03']);
    expect(new Set(parsed.records.map((r) => r.feature))).toEqual(new Set(['CLI', 'Coding Agent']));
    expect(parsed.records.every((r) => r.account === 'Acme')).toBe(true);
    const b = parsed.records.find((r) => r.model === 'model-b' && r.metricLabel === 'AI Units Consumed' && r.date === '2026-09-26');
    expect(toPlainString(b!.value)).toBe('1234567.89');
    expect(parsed.warnings.some((w) => /Skipped 1 row/.test(w))).toBe(true);
  });

  it('fills blank (unmerged) dimension cells downward', () => {
    const rows = [
      ['Acme', 'CLI', 'm1', 'AI Units Consumed', '1', '1', '1', '1'],
      [null, null, null, 'Gross Usage $', '$1', '$1', '$1', '$1'],
      [null, 'Chat', 'm1', 'AI Units Consumed', '2', '2', '2', '2'],
    ];
    const parsed = parseWorkbook(pivotWorkbook({ rows }), 'blank.xlsx');
    expect(parsed.records.filter((r) => r.feature === 'CLI')).toHaveLength(8);
    expect(parsed.records.filter((r) => r.feature === 'Chat').every((r) => r.account === 'Acme')).toBe(true);
  });

  it('rejects non-xlsx, empty and unrecognised files with actionable errors', () => {
    expect(() => parseWorkbook(new Uint8Array([1]), 'data.csv')).toThrow(WorkbookError);
    expect(() => parseWorkbook(new Uint8Array(), 'data.xlsx')).toThrow(/empty/);
    expect(() => parseWorkbook(new TextEncoder().encode('a,b\n1,2'), 'renamed.xlsx')).toThrow(/not a valid \.xlsx/);
    expect(() => parseWorkbook(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]), 'locked.xlsx')).toThrow(/password/);
    const noHeaders = toXlsx({ Sheet1: XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]) });
    try {
      parseWorkbook(noHeaders, 'x.xlsx');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbookError);
      expect((e as WorkbookError).hint).toMatch(/Feature/);
    }
  });

  it('errors clearly when value columns have no dates', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Feature', 'Metric', 'Units'],
      ['CLI', 'AI Units Consumed', '5'],
    ]);
    expect(() => parseWorkbook(toXlsx({ S: ws }), 'nodates.xlsx')).toThrow(/no week date/);
  });
});

describe('parseWorkbook (long layout)', () => {
  it('reads one-column-per-metric tables', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Week ending', 'Feature', 'Model', 'AI Units Consumed', 'Billable Usage $'],
      ['2026-09-12', 'CLI', 'm', 10.5, '$1.00'],
      ['2026-09-19', 'CLI', 'm', 20, '$2.50'],
    ]);
    const parsed = parseWorkbook(toXlsx({ S: ws }), 'long.xlsx');
    expect(parsed.layout).toBe('long');
    expect(parsed.records).toHaveLength(4);
  });

  it('reads metric/value pairs', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'Feature', 'Metric', 'Value'],
      ['2026-09-12', 'CLI', 'Gross Usage $', '$3.00'],
    ]);
    const parsed = parseWorkbook(toXlsx({ S: ws }), 'pairs.xlsx');
    expect(parsed.records[0].metricLabel).toBe('Gross Usage $');
    expect(toPlainString(parsed.records[0].value)).toBe('3');
  });
});

describe('aggregation', () => {
  const data = buildDataset([parseWorkbook(pivotWorkbook(), 'export.xlsx')]);
  const mapping = defaultMapping(data.metricLabels);

  it('maps source metric labels to canonical metrics', () => {
    expect(suggestMetric('UBB Active Users')).toBe('activeUserRecords');
    expect(suggestMetric('AI Units Consumed')).toBe('aiUnits');
    expect(suggestMetric('Gross Usage $')).toBe('grossUsage');
    expect(suggestMetric('Billable Usage $')).toBe('billableSpend');
    expect(suggestMetric('Something else')).toBe('ignore');
  });

  it('sums model rows per feature and week with exact totals', () => {
    const [cli, agent] = summarise(data, mapping);
    expect(cli.feature).toBe('CLI');
    const row = (m: string) => cli.rows.find((r) => r.metric === m)!;
    expect(row('activeUserRecords').values.map((v) => toPlainString(v!))).toEqual(['5', '7', '1', '2']);
    expect(toPlainString(row('activeUserRecords').total!)).toBe('15');
    expect(row('aiUnits').values.map((v) => toPlainString(v!))).toEqual(['1000.2', '2000.4', '1234567.89', '0.01']);
    expect(toPlainString(row('aiUnits').total!)).toBe('1237568.5');
    expect(toPlainString(row('grossUsage').total!)).toBe('12375.72');
    expect(toPlainString(row('billableSpend').total!)).toBe('12366.8');
    // Coding Agent's usage metric cells are all blank → metric exists in the file but has no data here.
    expect(agent.rows.find((r) => r.metric === 'aiUnits')!.state).toBe('no-data');
    expect(toPlainString(agent.rows.find((r) => r.metric === 'activeUserRecords')!.total!)).toBe('26');
  });

  it('marks metrics missing from the source as unavailable instead of inventing values', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Week ending', 'Feature', 'AI Units Consumed'],
      ['2026-09-12', 'CLI', 5],
    ]);
    const d = buildDataset([parseWorkbook(toXlsx({ S: ws }), 'u.xlsx')]);
    const [cli] = summarise(d, defaultMapping(d.metricLabels));
    expect(cli.rows.find((r) => r.metric === 'billableSpend')!.state).toBe('unavailable');
    expect(cli.rows.find((r) => r.metric === 'grossUsage')!.total).toBeNull();
  });

  it('honours explicit field mapping and ignore', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Week ending', 'Feature', 'Cost'],
      ['2026-09-12', 'CLI', '$4.00'],
    ]);
    const d = buildDataset([parseWorkbook(toXlsx({ S: ws }), 'c.xlsx')]);
    expect(summarise(d, defaultMapping(d.metricLabels))[0].rows.every((r) => r.state === 'unavailable')).toBe(true);
    const mapped = summarise(d, { Cost: 'billableSpend' })[0];
    expect(toPlainString(mapped.rows.find((r) => r.metric === 'billableSpend')!.total!)).toBe('4');
  });

  it('filters by account', () => {
    const rows = [
      ['A1', 'CLI', 'm', 'AI Units Consumed', '1', '1', '1', '1'],
      ['A2', 'CLI', 'm', 'AI Units Consumed', '10', '10', '10', '10'],
    ];
    const d = buildDataset([parseWorkbook(pivotWorkbook({ rows }), 'a.xlsx')]);
    expect(d.accounts).toEqual(['A1', 'A2']);
    const total = (acct: string | null) =>
      toPlainString(summarise(d, defaultMapping(d.metricLabels), { account: acct })[0].rows.find((r) => r.metric === 'aiUnits')!.total!);
    expect(total(null)).toBe('44');
    expect(total('A2')).toBe('40');
  });
});

describe('multiple files and periods', () => {
  it('combines weeks from separate files and dedupes overlaps', () => {
    const a = parseWorkbook(pivotWorkbook({ serials: SERIALS.slice(0, 2), rows: [['X', 'CLI', 'm', 'AI Units Consumed', '1', '2']] }), 'a.xlsx');
    const b = parseWorkbook(pivotWorkbook({ serials: SERIALS.slice(1), rows: [['X', 'CLI', 'm', 'AI Units Consumed', '2', '3', '4']] }), 'b.xlsx');
    const d = buildDataset([a, b]);
    expect(d.periods.map((p) => p.label)).toEqual(['12 Sep', '19 Sep', '26 Sep', '3 Oct']);
    expect(d.notes.some((n) => /counted once/.test(n))).toBe(true);
    const total = summarise(d, defaultMapping(d.metricLabels))[0].rows.find((r) => r.metric === 'aiUnits')!.total!;
    expect(toPlainString(total)).toBe('10');
  });

  it('reports conflicting overlaps', () => {
    const a = parseWorkbook(pivotWorkbook({ serials: [SERIALS[0]], rows: [['X', 'CLI', 'm', 'AI Units Consumed', '1']] }), 'a.xlsx');
    const b = parseWorkbook(pivotWorkbook({ serials: [SERIALS[0]], rows: [['X', 'CLI', 'm', 'AI Units Consumed', '9']] }), 'b.xlsx');
    const { records, notes } = combineFiles([a, b]);
    expect(toPlainString(records[0].value)).toBe('9');
    expect(notes.join(' ')).toMatch(/differed/);
  });

  it('buckets daily dates into weeks ending on the latest weekday', () => {
    const p = buildPeriods(['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-03']);
    expect(p.granularity).toBe('bucketed-to-weeks');
    expect(p.periods.map((x) => x.key)).toEqual(['2026-10-03']);
    const q = buildPeriods(['2026-09-26', '2026-09-27', '2026-10-03']);
    expect(q.periods.map((x) => x.key)).toEqual(['2026-09-26', '2026-10-03']);
  });

  it('notes missing weeks', () => {
    const p = buildPeriods(['2026-09-12', '2026-09-26']);
    expect(p.granularity).toBe('weekly');
    expect(p.notes[0]).toMatch(/1 week/);
  });
});

describe('CSV export', () => {
  it('exports exact values and marks unavailable metrics', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Week ending', 'Feature', 'AI Units Consumed'],
      ['2026-09-12', '=CLI', '0.10'],
    ]);
    const d = buildDataset([parseWorkbook(toXlsx({ S: ws }), 'e.xlsx')]);
    const csv = summaryToCsv(d, summarise(d, defaultMapping(d.metricLabels)), 'All accounts');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Scope,Feature,Metric,Unit,Week ending 2026-09-12,1-week total');
    expect(lines).toContain("All accounts,'=CLI,AI units consumed,AI units,0.1,0.1");
    expect(lines.some((l) => l.endsWith(',,unavailable') && l.includes('Billable spend'))).toBe(true);
  });
});

describe('model usage', () => {
  const data = buildDataset([parseWorkbook(pivotWorkbook(), 'export.xlsx')]);
  const mapping = defaultMapping(data.metricLabels);
  const totals = (rows: { model: string; total: { int: bigint; scale: number } }[]) => rows.map((r) => [r.model, toPlainString(r.total)]);

  it('sums each model across features and weeks, largest first, with exact totals', () => {
    const m = summariseModels(data, mapping, { metric: 'aiUnits' });
    expect(m.state).toBe('value');
    expect(totals(m.rows)).toEqual([
      ['model-b', '1234568.19'],
      ['model-a', '3000.31'],
    ]);
    expect(toPlainString(m.grandTotal)).toBe('1237568.5');
    expect(m.rows[1].values.map(toPlainString)).toEqual(['1000.1', '2000.2', '0', '0.01']);
  });

  it('splits model totals by feature', () => {
    const m = summariseModels(data, mapping, { metric: 'activeUserRecords' });
    const a = m.rows.find((r) => r.model === 'model-a')!;
    expect(toPlainString(a.total)).toBe('35');
    expect(a.byFeature.map((b) => [b.feature, toPlainString(b.value)])).toEqual([
      ['CLI', '9'],
      ['Coding Agent', '26'],
    ]);
  });

  it('filters by feature, week and account', () => {
    expect(totals(summariseModels(data, mapping, { metric: 'activeUserRecords', features: ['Coding Agent'] }).rows)).toEqual([['model-a', '26']]);
    const wk = summariseModels(data, mapping, { metric: 'aiUnits', period: '2026-09-26' });
    expect(wk.periods.map((p) => p.key)).toEqual(['2026-09-26']);
    // model-a's cell is blank that week, so it has no record rather than an invented zero.
    expect(totals(wk.rows)).toEqual([['model-b', '1234567.89']]);
    expect(summariseModels(data, mapping, { metric: 'aiUnits', account: 'Nobody' }).state).toBe('no-data');
  });

  it('applies a minimum threshold exactly (inclusive)', () => {
    const { rows } = summariseModels(data, mapping, { metric: 'aiUnits' });
    expect(filterModels(rows, decimalFromInput('3000.31')).map((r) => r.model)).toEqual(['model-b', 'model-a']);
    expect(filterModels(rows, decimalFromInput('3,000.32')).map((r) => r.model)).toEqual(['model-b']);
    expect(filterModels(rows, decimalFromInput('2m'))).toEqual([]);
    expect(filterModels(rows, null)).toHaveLength(2);
  });

  it('parses typed thresholds and rejects junk', () => {
    expect(toPlainString(decimalFromInput('2.5k')!)).toBe('2500');
    expect(toPlainString(decimalFromInput(' $1,234.50 ')!)).toBe('1234.5');
    expect(decimalFromInput('')).toBeNull();
    expect(decimalFromInput('abc')).toBeNull();
    expect(decimalFromInput('-5')).toBeNull();
    expect(compare(decimalFromPlain('0.10')!, decimalFromPlain('0.1')!)).toBe(0);
  });

  it('reports metrics absent from the source as unavailable (never derives tokens or spend)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Week ending', 'Feature', 'Model', 'AI Units Consumed'],
      ['2026-09-12', 'CLI', 'm', 5],
    ]);
    const d = buildDataset([parseWorkbook(toXlsx({ S: ws }), 'u.xlsx')]);
    expect(summariseModels(d, defaultMapping(d.metricLabels), { metric: 'billableSpend' }).state).toBe('unavailable');
  });

  it('exports the shown models with exact values', () => {
    const m = summariseModels(data, mapping, { metric: 'aiUnits' });
    const csv = modelsToCsv(m, filterModels(m.rows, decimalFromInput('5000')), 'All accounts', 'All features');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Scope,Features,Model,Metric,Unit,Week ending 2026-09-12,Week ending 2026-09-19,Week ending 2026-09-26,Week ending 2026-10-03,4-week total');
    expect(lines[1]).toBe('All accounts,All features,model-b,AI units consumed,AI units,0.1,0.2,1234567.89,0,1234568.19');
    expect(lines).toHaveLength(2);
  });
});
