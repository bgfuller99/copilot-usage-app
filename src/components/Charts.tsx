import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FeatureSummary, Period } from '../lib/aggregate';
import { toNumber } from '../lib/decimal';
import { formatAxis, formatNumber } from '../lib/format';
import { METRIC_BY_ID, type CanonicalMetric } from '../lib/metrics';

const axis = { stroke: '#8b8b8b', fontSize: 12 };
const tooltipStyle = {
  contentStyle: { background: '#2b2b2b', border: '1px solid #444', borderRadius: 8, color: '#eee' },
  labelStyle: { color: '#fff', fontWeight: 600 },
  cursor: { fill: 'rgba(255,255,255,0.06)' },
};

interface FeatureProps {
  summary: FeatureSummary;
  periods: Period[];
  metric: CanonicalMetric;
  color: string;
}

export function FeatureChart({ summary, periods, metric, color }: FeatureProps) {
  const def = METRIC_BY_ID[metric];
  const row = summary.rows.find((r) => r.metric === metric)!;
  if (row.state !== 'value')
    return (
      <div className="chart-empty">
        {def.label} is {row.state === 'unavailable' ? 'unavailable in the uploaded data' : 'not reported for this feature'}.
      </div>
    );
  const data = periods.map((p, i) => ({ week: p.label, value: toNumber(row.values[i]!) }));
  return (
    <div className="chart" role="img" aria-label={`${def.label} per week for ${summary.feature}`}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#333" vertical={false} />
          <XAxis dataKey="week" tick={axis} axisLine={{ stroke: '#444' }} tickLine={false} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={64} tickFormatter={(v: number) => formatAxis(v, def.kind)} />
          <Tooltip {...tooltipStyle} formatter={(v) => [formatNumber(Number(v), def.kind), def.label]} />
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface OverviewProps {
  summaries: FeatureSummary[];
  periods: Period[];
  metric: CanonicalMetric;
  colorOf: (feature: string) => string;
}

export function OverviewChart({ summaries, periods, metric, colorOf }: OverviewProps) {
  const def = METRIC_BY_ID[metric];
  const series = summaries.filter((s) => s.rows.find((r) => r.metric === metric)!.state === 'value');
  if (!series.length) return <div className="chart-empty">{def.label} is unavailable in the uploaded data.</div>;
  const data = periods.map((p, i) => {
    const point: Record<string, string | number> = { week: p.label };
    for (const s of series) point[s.feature] = toNumber(s.rows.find((r) => r.metric === metric)!.values[i]!);
    return point;
  });
  return (
    <div className="chart" role="img" aria-label={`${def.label} per week by feature`}>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#333" vertical={false} />
          <XAxis dataKey="week" tick={axis} axisLine={{ stroke: '#444' }} tickLine={false} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={64} tickFormatter={(v: number) => formatAxis(v, def.kind)} />
          <Tooltip {...tooltipStyle} formatter={(v, name) => [formatNumber(Number(v), def.kind), String(name)]} />
          <Legend wrapperStyle={{ fontSize: 12, color: '#ccc' }} />
          {series.map((s) => (
            <Bar key={s.feature} dataKey={s.feature} fill={colorOf(s.feature)} radius={[3, 3, 0, 0]} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
