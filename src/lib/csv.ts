import type { Dataset, FeatureSummary } from './aggregate';
import { toPlainString } from './decimal';
import { METRIC_BY_ID } from './metrics';

function esc(v: string): string {
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Transformed summary as CSV with full source precision (unformatted, unrounded). */
export function summaryToCsv(data: Dataset, summaries: FeatureSummary[], scopeLabel: string): string {
  const header = ['Scope', 'Feature', 'Metric', 'Unit', ...data.periods.map((p) => `Week ending ${p.end}`), `${data.periods.length}-week total`];
  const lines = [header.map(esc).join(',')];
  for (const s of summaries) {
    for (const row of s.rows) {
      const def = METRIC_BY_ID[row.metric];
      const unit = def.kind === 'usd' ? 'USD' : def.kind === 'count' ? 'records' : 'AI units';
      const cells =
        row.state === 'value'
          ? [...row.values.map((v) => toPlainString(v!)), toPlainString(row.total!)]
          : data.periods.map(() => '').concat(row.state === 'unavailable' ? 'unavailable' : 'no data');
      lines.push([scopeLabel, s.feature, def.label, unit, ...cells].map(esc).join(','));
    }
  }
  return lines.join('\r\n') + '\r\n';
}
