import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { filterModels, type ModelRow, type ModelSummary, type Period } from '../lib/aggregate';
import { decimalFromInput, toNumber, sum } from '../lib/decimal';
import { exactTitle, formatAxis, formatNumber, formatValue } from '../lib/format';
import { METRIC_BY_ID, METRICS, type CanonicalMetric } from '../lib/metrics';

export const ALL = '__all__';

interface Props {
  summary: ModelSummary;
  allPeriods: Period[];
  features: string[];
  metric: CanonicalMetric;
  feature: string;
  period: string;
  min: string;
  colorOf: (feature: string) => string;
  onMetric: (m: CanonicalMetric) => void;
  onFeature: (f: string) => void;
  onPeriod: (p: string) => void;
  onMin: (v: string) => void;
  onExport: (rows: ModelRow[]) => void;
}

const axis = { stroke: '#8b8b8b', fontSize: 12 };
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export function ModelUsage(props: Props) {
  const { summary, allPeriods, features, metric, feature, period, min, colorOf } = props;
  const def = METRIC_BY_ID[metric];
  const threshold = decimalFromInput(min);
  const invalidMin = min.trim() !== '' && !threshold;
  const rows = filterModels(summary.rows, threshold);
  const shown = rows.length ? sum(rows.map((r) => r.total)) : null;
  const grand = toNumber(summary.grandTotal);
  const share = (n: number) => (grand > 0 ? pct.format(n / grand) : '—');
  const multi = summary.periods.length > 1;
  const totalLabel = multi ? `${summary.periods.length}-week total` : `Week ending ${summary.periods[0]?.label ?? ''}`;
  const chartFeatures = summary.features.filter((f) => rows.some((r) => r.byFeature.some((b) => b.feature === f)));
  const chartData = rows.map((r) => {
    const point: Record<string, string | number> = { model: r.model };
    for (const b of r.byFeature) point[b.feature] = toNumber(b.value);
    return point;
  });

  return (
    <section className="card models" aria-labelledby="models-h">
      <div className="models-head">
        <div>
          <h2 id="models-h">Model usage</h2>
          <p className="sub">
            Which model families consume the most, summed across the selected features. Use <em>Minimum</em> to show only
            models at or above a threshold.
          </p>
        </div>
        <button className="btn" onClick={() => props.onExport(rows)} disabled={!rows.length}>
          Export models CSV
        </button>
      </div>

      <div className="toolbar inner" aria-label="Model filters">
        <label>
          Metric
          <select value={metric} onChange={(e) => props.onMetric(e.target.value as CanonicalMetric)}>
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Feature
          <select value={features.includes(feature) ? feature : ALL} onChange={(e) => props.onFeature(e.target.value)}>
            <option value={ALL}>All shown features ({features.length})</option>
            {features.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Weeks
          <select value={allPeriods.some((p) => p.key === period) ? period : ALL} onChange={(e) => props.onPeriod(e.target.value)}>
            <option value={ALL}>All {allPeriods.length} weeks</option>
            {allPeriods.map((p) => (
              <option key={p.key} value={p.key}>
                Week ending {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Minimum {def.kind === 'usd' ? '(USD)' : def.kind === 'units' ? '(AI units)' : '(records)'}
          <input
            type="text"
            inputMode="decimal"
            value={min}
            placeholder="e.g. 1,000 or 2.5k"
            aria-invalid={invalidMin}
            onChange={(e) => props.onMin(e.target.value)}
          />
        </label>
        {min && (
          <button className="btn small" onClick={() => props.onMin('')}>
            Clear minimum
          </button>
        )}
      </div>

      {invalidMin && (
        <p className="notice warn" role="alert">
          “{min}” isn’t a number. Enter a value like 1000, 1,000, 2.5k or $50.
        </p>
      )}
      {metric === 'aiUnits' && (
        <p className="notice subtle">
          The export reports <strong>AI units</strong>, not tokens. Token counts aren’t in the file and can’t be derived from
          AI units, so models are ranked by AI units consumed.
        </p>
      )}
      {metric === 'activeUserRecords' && (
        <p className="notice subtle">
          Active-user records are summed across features and weeks, so one person can be counted more than once. They are not
          unique users.
        </p>
      )}

      {summary.state !== 'value' ? (
        <div className="chart-empty">
          {def.label} is {summary.state === 'unavailable' ? 'unavailable in the uploaded data' : 'not reported for the selected features and weeks'}.
        </div>
      ) : (
        <>
          <p className="models-summary" aria-live="polite">
            <strong>
              {rows.length} of {summary.rows.length}
            </strong>{' '}
            models{threshold ? ` with ≥ ${formatValue(threshold, def.kind)}${def.kind === 'units' ? ' AI units' : ''}` : ''} ·{' '}
            {shown ? `${formatValue(shown, def.kind)} (${share(toNumber(shown))} of ${formatValue(summary.grandTotal, def.kind)})` : 'none match'}
          </p>
          {rows.length > 0 ? (
            <div className="models-body">
              <div className="chart-card">
                <div className="chart-title">
                  {def.label} by model · {multi ? `${summary.periods.length} weeks` : totalLabel}
                </div>
                <div className="chart" role="img" aria-label={`${def.label} by model`}>
                  <ResponsiveContainer width="100%" height={56 + rows.length * 34}>
                    <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                      <CartesianGrid stroke="#333" horizontal={false} />
                      <XAxis type="number" tick={axis} axisLine={{ stroke: '#444' }} tickLine={false} tickFormatter={(v: number) => formatAxis(v, def.kind)} />
                      <YAxis type="category" dataKey="model" tick={axis} axisLine={false} tickLine={false} width={130} />
                      <Tooltip
                        contentStyle={{ background: '#2b2b2b', border: '1px solid #444', borderRadius: 8, color: '#eee' }}
                        labelStyle={{ color: '#fff', fontWeight: 600 }}
                        cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                        formatter={(v, name) => [formatNumber(Number(v), def.kind), String(name)]}
                      />
                      {chartFeatures.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: '#ccc' }} />}
                      {chartFeatures.map((f, i) => (
                        <Bar
                          key={f}
                          dataKey={f}
                          stackId="m"
                          fill={colorOf(f)}
                          maxBarSize={22}
                          radius={i === chartFeatures.length - 1 ? [0, 4, 4, 0] : 0}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="table-wrap">
                <table className="summary">
                  <caption className="sr-only">{def.label} by model</caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      {multi && summary.periods.map((p) => <th scope="col" key={p.key}>{p.label}</th>)}
                      <th scope="col">{totalLabel}</th>
                      <th scope="col">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.model}>
                        <th scope="row" title={r.byFeature.map((b) => `${b.feature}: ${formatValue(b.value, def.kind)}`).join('\n')}>
                          {r.model}
                        </th>
                        {multi &&
                          r.values.map((v, i) => (
                            <td key={summary.periods[i].key} title={exactTitle(v)}>
                              {formatValue(v, def.kind)}
                            </td>
                          ))}
                        <td className="total" title={exactTitle(r.total)}>
                          {formatValue(r.total, def.kind)}
                        </td>
                        <td>{share(toNumber(r.total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="chart-empty">No model reaches the minimum. Lower or clear it to see more.</div>
          )}
        </>
      )}
    </section>
  );
}
