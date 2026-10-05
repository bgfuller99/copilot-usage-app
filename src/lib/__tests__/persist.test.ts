import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDataset, summarise } from '../aggregate';
import { toPlainString } from '../decimal';
import { defaultMapping } from '../metrics';
import { parseWorkbook } from '../parse';
import { clearState, DEFAULT_PREFS, loadState, sanitizePrefs, saveState } from '../persist';

function workbook(): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Week ending', 'Feature', 'AI Units Consumed', 'Billable Usage $'],
    ['2026-09-12', 'CLI', '1,000.10', '$1.10'],
    ['2026-09-19', 'CLI', '0.20', '$2.25'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return out;
}

describe('local session persistence (regression: state lost on reload/remount)', () => {
  beforeEach(() => clearState());

  it('returns null when nothing is stored', async () => {
    expect(await loadState()).toBeNull();
  });

  it('round-trips workbook bytes and selections so the same summary is rebuilt', async () => {
    const bytes = workbook();
    const prefs = {
      ...DEFAULT_PREFS,
      chartMetric: 'billableSpend' as const,
      hidden: ['Chat'],
      overrides: { Cost: 'grossUsage' as const },
      view: 'models' as const,
      modelMetric: 'grossUsage' as const,
      modelFeature: 'CLI',
      modelPeriod: '2026-09-12',
      modelMin: '1,000',
    };
    await saveState([{ id: 'a.xlsx:1:2', name: 'a.xlsx', bytes }], prefs);

    const state = await loadState();
    expect(state?.prefs).toEqual(prefs);
    expect(state?.files).toHaveLength(1);
    const before = summarise(buildDataset([parseWorkbook(bytes, 'a.xlsx')]), defaultMapping(['AI Units Consumed', 'Billable Usage $']));
    const restored = state!.files[0];
    const after = summarise(buildDataset([parseWorkbook(restored.bytes, restored.name)]), defaultMapping(['AI Units Consumed', 'Billable Usage $']));
    const totals = (s: typeof before) => s[0].rows.map((r) => (r.total ? toPlainString(r.total) : r.state));
    expect(totals(after)).toEqual(totals(before));
    expect(totals(after)).toContain('1000.3');
  });

  it('clearState removes the session (Reset)', async () => {
    await saveState([{ id: 'x', name: 'x.xlsx', bytes: workbook() }], DEFAULT_PREFS);
    await clearState();
    expect(await loadState()).toBeNull();
  });

  it('sanitises corrupt or tampered prefs', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(
      sanitizePrefs({ chartMetric: 'bogus', hidden: [1, 'CLI'], overrides: { A: 'aiUnits', B: 'evil' }, account: 5, view: 'x', modelMetric: 'tokens', modelMin: 7 }),
    ).toEqual({
      ...DEFAULT_PREFS,
      hidden: ['CLI'],
      overrides: { A: 'aiUnits' },
    });
  });
});
