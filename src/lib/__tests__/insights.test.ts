import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDataset } from '../aggregate';
import { defaultMapping } from '../metrics';
import { parseWorkbook } from '../parse';
import { analyseUsage } from '../insights';

function dataset(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Account', 'Feature', 'Model', 'Week ending', 'Metric', 'Value'],
    ...rows,
  ]), 'Usage');
  return buildDataset([parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), 'synthetic.xlsx')]);
}

function sample(latest: string = '1') {
  return dataset([
    ['A', 'CLI', 'model-a', '2026-09-12', 'AI Units Consumed', '100.10'],
    ['A', 'CLI', 'model-a', '2026-09-19', 'AI Units Consumed', '200.20'],
    ['A', 'CLI', 'model-a', '2026-09-26', 'AI Units Consumed', latest],
    ['A', 'Chat', 'model-b', '2026-09-12', 'AI Units Consumed', '50'],
    ['A', 'Chat', 'model-b', '2026-09-19', 'AI Units Consumed', '50'],
    ['A', 'Chat', 'model-b', '2026-09-26', 'AI Units Consumed', '1'],
  ]);
}

const analyse = (d: ReturnType<typeof dataset>) => analyseUsage(d, defaultMapping(d.metricLabels));
const text = (r: ReturnType<typeof analyse>) => [r.story, ...r.findings.map((f) => f.text)].join('\n');

describe('browser-local usage story', () => {
  it('always excludes the newest week, even from shares and totals', () => {
    const a = analyse(sample('1'));
    const b = analyse(sample('999999'));
    expect(a).toEqual(b);
    expect(a.periods.map((p) => p.key)).toEqual(['2026-09-12', '2026-09-19']);
    expect(a.partialLabel).toBe('26 Sep');
    expect(a.story).toContain('400');
    expect(text(a)).not.toContain('fell');
    expect(a.findings.find((f) => f.title === 'Earlier-week trend')?.text).toContain('66.7%');
  });

  it('respects account/feature filters without changing the latest-week boundary', () => {
    const d = sample();
    const r = analyseUsage(d, defaultMapping(d.metricLabels), { account: 'A', features: ['Chat'] });
    expect(r.story).toContain('100 ai units');
    expect(r.findings.find((f) => f.title === 'Model mix')?.text).toContain('model-b');
    expect(text(r)).not.toContain('model-a');
    const empty = analyseUsage(d, defaultMapping(d.metricLabels), { features: [] });
    expect(empty.findings).toEqual([]);
    expect(empty.story).toContain('No records match');
  });

  it('does not fabricate a trend for one week or one earlier week', () => {
    const d = dataset([['A', 'CLI', 'm', '2026-09-12', 'AI Units Consumed', '100']]);
    expect(analyse(d).findings).toEqual([]);
    expect(analyse(d).story).toContain('not enough');
    const d2 = dataset([
      ['A', 'CLI', 'm', '2026-09-12', 'AI Units Consumed', '100'],
      ['A', 'CLI', 'm', '2026-09-19', 'AI Units Consumed', '1'],
    ]);
    expect(analyse(d2).findings.some((f) => f.title.includes('trend'))).toBe(false);
  });

  it('does not treat missing feature cells as a fall to zero', () => {
    const d = dataset([
      ['A', 'CLI', 'm', '2026-09-12', 'AI Units Consumed', '100'],
      ['A', 'Chat', 'm', '2026-09-12', 'AI Units Consumed', '100'],
      ['A', 'Chat', 'm', '2026-09-19', 'AI Units Consumed', '100'],
      ['A', 'Chat', 'm', '2026-09-26', 'AI Units Consumed', '1'],
    ]);
    expect(analyse(d).findings.find((f) => f.title === 'Standout feature changes')).toBeUndefined();
    expect(analyse(d).findings.find((f) => f.title === 'Earlier-week trend')).toBeUndefined();
    expect(analyse(d).cautions.join(' ')).toContain('different account/feature/model slices');
  });

  it('suppresses trends across missing and irregular weeks', () => {
    for (const middle of ['2026-09-26', '2026-09-22']) {
      const d = dataset([
        ['A', 'CLI', 'm', '2026-09-12', 'AI Units Consumed', '100'],
        ['A', 'CLI', 'm', middle, 'AI Units Consumed', '200'],
        ['A', 'CLI', 'm', '2026-10-03', 'AI Units Consumed', '1'],
      ]);
      expect(analyse(d).findings.some((f) => f.title.includes('trend'))).toBe(false);
    }
  });

  it('does not invent spend, tokens, distinct users or model versions', () => {
    const r = analyse(sample());
    expect(r.cautions.join(' ')).toContain('Gross usage, Billable spend');
    expect(r.cautions.join(' ')).toContain('not tokens');
    expect(r.cautions.join(' ')).toContain('not unique users');
    expect(r.findings.find((f) => f.title === 'Model mix')?.text).toContain('cannot reveal individual versions');
    expect(r.story).not.toContain('$');
  });

  it('handles zero baselines and negative corrections without misleading percentages', () => {
    for (const v of ['0', '-10']) {
      const d = dataset([
        ['A', 'CLI', 'm', '2026-09-12', 'AI Units Consumed', v],
        ['A', 'CLI', 'm', '2026-09-19', 'AI Units Consumed', '100'],
        ['A', 'CLI', 'm', '2026-09-26', 'AI Units Consumed', '1'],
      ]);
      expect(analyse(d).findings.some((f) => f.title.includes('trend'))).toBe(false);
      expect(text(analyse(d))).not.toMatch(/NaN|Infinity/);
    }
  });

  it('identifies spend/consumption divergence without claiming its cause', () => {
    const rows: unknown[][] = [];
    for (const [date, units, bill] of [['2026-09-12', '100', '100'], ['2026-09-19', '100', '20'], ['2026-09-26', '1', '1']])
      rows.push(['A', 'CLI', 'm', date, 'AI Units Consumed', units], ['A', 'CLI', 'm', date, 'Billable Usage $', bill]);
    const f = analyse(dataset(rows)).findings.find((x) => x.title === 'Spend and consumption tell different stories');
    expect(f?.text).toContain('80%');
    expect(f?.text).toContain('cannot establish the cause');
  });

  it('excludes incomplete earlier daily buckets', () => {
    const rows = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((day) =>
      ['A', 'CLI', 'm', `2026-09-${day}`, 'AI Units Consumed', '10'],
    );
    const r = analyse(dataset(rows));
    // Anchor is Saturday: first bucket contains just 12 Sep; latest is excluded.
    expect(r.periods.map((p) => p.key)).toEqual(['2026-09-19']);
    expect(r.cautions.join(' ')).toContain('fewer than seven reported dates');
  });
});
