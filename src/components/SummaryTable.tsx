import type { FeatureSummary, Period } from '../lib/aggregate';
import { exactTitle, formatValue } from '../lib/format';
import { METRIC_BY_ID } from '../lib/metrics';

interface Props {
  summary: FeatureSummary;
  periods: Period[];
  totalLabel: string;
}

export function SummaryTable({ summary, periods, totalLabel }: Props) {
  return (
    <div className="table-wrap">
      <table className="summary">
        <caption className="sr-only">{summary.feature} weekly summary</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {periods.map((p) => (
              <th scope="col" key={p.key} title={`Week ${p.start} – ${p.end}`}>
                {p.label}
              </th>
            ))}
            <th scope="col">{totalLabel}</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row) => {
            const def = METRIC_BY_ID[row.metric];
            const emphasise = def.kind === 'usd' && row.metric === 'billableSpend';
            return (
              <tr key={row.metric} className={emphasise ? 'emph' : undefined}>
                <th scope="row" title={def.description}>
                  {def.label}
                </th>
                {row.state === 'value' ? (
                  <>
                    {row.values.map((v, i) => (
                      <td key={periods[i].key} title={exactTitle(v!)}>
                        {formatValue(v!, def.kind)}
                      </td>
                    ))}
                    <td className="total" title={exactTitle(row.total!)}>
                      {formatValue(row.total!, def.kind)}
                    </td>
                  </>
                ) : (
                  <td colSpan={periods.length + 1} className="muted">
                    {row.state === 'unavailable'
                      ? 'Unavailable — not present in the uploaded file(s). Map a source field below if it exists under another name.'
                      : 'No data for this feature in the uploaded file(s)'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
