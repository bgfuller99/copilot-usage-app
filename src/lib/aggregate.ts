import { add, compare, equals, sum, toPlainString, ZERO, type Decimal } from './decimal';
import { METRICS, type CanonicalMetric, type MetricTarget } from './metrics';
import type { ParsedFile, UsageRecord } from './parse';

export interface Period {
  /** ISO date that identifies the period (week-end date). */
  key: string;
  start: string;
  end: string;
  label: string;
}

export interface Dataset {
  records: UsageRecord[];
  periods: Period[];
  /** Maps a record date to its period key. */
  periodOf: Record<string, string>;
  granularity: 'weekly' | 'bucketed-to-weeks' | 'irregular' | 'single';
  accounts: string[];
  features: string[];
  metricLabels: string[];
  notes: string[];
}

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function label(iso: string, withYear: boolean) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

function recordKey(r: UsageRecord) {
  return [r.account, r.feature, r.model, r.metricLabel, r.date].join('\u0000');
}

/**
 * Merge several parsed files. Within a file identical keys are added; across files an
 * identical key is treated as an overlapping export (deduplicated, later file wins on conflict).
 */
export function combineFiles(files: ParsedFile[]): { records: UsageRecord[]; notes: string[] } {
  const merged = new Map<string, UsageRecord>();
  let overlaps = 0;
  const conflicts: string[] = [];
  for (const file of files) {
    const local = new Map<string, UsageRecord>();
    for (const r of file.records) {
      const k = recordKey(r);
      const prev = local.get(k);
      local.set(k, prev ? { ...prev, value: add(prev.value, r.value) } : r);
    }
    for (const [k, r] of local) {
      const prev = merged.get(k);
      if (prev) {
        if (equals(prev.value, r.value)) overlaps++;
        else conflicts.push(`${r.feature} / ${r.model || '—'} / ${r.metricLabel} on ${r.date}: ${prev.source} had ${toPlainString(prev.value)}, ${r.source} has ${toPlainString(r.value)}`);
      }
      merged.set(k, r);
    }
  }
  const notes: string[] = [];
  if (overlaps) notes.push(`${overlaps} value(s) appeared in more than one file with identical values and were counted once.`);
  if (conflicts.length)
    notes.push(
      `${conflicts.length} value(s) differed between overlapping files; the most recently added file was used. Example: ${conflicts[0]}.`,
    );
  return { records: [...merged.values()], notes };
}

/** Derive weekly periods from the dates actually present in the data. */
export function buildPeriods(dates: string[]): Pick<Dataset, 'periods' | 'periodOf' | 'granularity'> & { notes: string[] } {
  const unique = [...new Set(dates)].sort();
  const notes: string[] = [];
  if (!unique.length) return { periods: [], periodOf: {}, granularity: 'single', notes };
  const gaps = unique.slice(1).map((d, i) => Math.round((toMs(d) - toMs(unique[i])) / DAY));
  const multiYear = unique[0].slice(0, 4) !== unique[unique.length - 1].slice(0, 4);
  const periodOf: Record<string, string> = {};
  const periods: Period[] = [];

  if (gaps.length && Math.min(...gaps) < 7) {
    // Sub-weekly data: bucket into 7-day weeks ending on the weekday of the latest date.
    const anchorDow = new Date(toMs(unique[unique.length - 1])).getUTCDay();
    for (const d of unique) {
      const dow = new Date(toMs(d)).getUTCDay();
      periodOf[d] = fromMs(toMs(d) + ((anchorDow - dow + 7) % 7) * DAY);
    }
    for (const end of [...new Set(Object.values(periodOf))].sort())
      periods.push({ key: end, end, start: fromMs(toMs(end) - 6 * DAY), label: label(end, multiYear) });
    const first = periods[0];
    const covered = unique.filter((d) => periodOf[d] === first.key).length;
    notes.push(
      `Source dates are daily/sub-weekly, so they were grouped into weeks ending ${WEEKDAYS[anchorDow]} (the weekday of the latest date).` +
        (covered < 7 ? ` The first week (${first.label}) is partial.` : ''),
    );
    return { periods, periodOf, granularity: 'bucketed-to-weeks', notes };
  }

  for (const d of unique) {
    periodOf[d] = d;
    periods.push({ key: d, end: d, start: fromMs(toMs(d) - 6 * DAY), label: label(d, multiYear) });
  }
  if (!gaps.length) return { periods, periodOf, granularity: 'single', notes };
  if (gaps.every((g) => g % 7 === 0)) {
    const missing = gaps.reduce((n, g) => n + g / 7 - 1, 0);
    if (missing) notes.push(`${missing} week(s) between the first and last week have no data in the uploaded file(s).`);
    return { periods, periodOf, granularity: 'weekly', notes };
  }
  notes.push('Source dates are not evenly spaced a week apart; each distinct date is shown as its own column.');
  return { periods, periodOf, granularity: 'irregular', notes };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function firstSeenOrder(values: string[]) {
  return [...new Set(values)];
}

export function buildDataset(files: ParsedFile[]): Dataset {
  const { records, notes } = combineFiles(files);
  const p = buildPeriods(records.map((r) => r.date));
  return {
    records,
    ...p,
    accounts: firstSeenOrder(records.map((r) => r.account)).filter(Boolean).sort(),
    features: firstSeenOrder(records.map((r) => r.feature)),
    metricLabels: firstSeenOrder(records.map((r) => r.metricLabel)),
    notes: [...notes, ...p.notes],
  };
}

export type CellState = 'value' | 'unavailable' | 'no-data';

export interface MetricRow {
  metric: CanonicalMetric;
  state: CellState;
  /** One entry per period; null when state !== 'value'. Missing weeks for an available metric are zero. */
  values: (Decimal | null)[];
  total: Decimal | null;
  sourceLabels: string[];
}

export interface FeatureSummary {
  feature: string;
  rows: MetricRow[];
}

export interface SummaryOptions {
  account?: string | null;
  features?: string[] | null;
}

export function summarise(
  data: Dataset,
  mapping: Record<string, MetricTarget>,
  opts: SummaryOptions = {},
): FeatureSummary[] {
  const labelsFor = (m: CanonicalMetric) => data.metricLabels.filter((l) => mapping[l] === m);
  const globallyAvailable = new Set(
    METRICS.map((m) => m.id).filter((id) => data.records.some((r) => mapping[r.metricLabel] === id)),
  );
  const periodIndex = new Map(data.periods.map((p, i) => [p.key, i]));
  const scoped = data.records.filter((r) => !opts.account || r.account === opts.account);
  const features = data.features.filter((f) => !opts.features || opts.features.includes(f));

  return features.map((feature) => {
    const fr = scoped.filter((r) => r.feature === feature);
    const rows = METRICS.map<MetricRow>(({ id }) => {
      const sourceLabels = labelsFor(id);
      if (!globallyAvailable.has(id))
        return { metric: id, state: 'unavailable', values: data.periods.map(() => null), total: null, sourceLabels };
      const mr = fr.filter((r) => mapping[r.metricLabel] === id);
      if (!mr.length)
        return { metric: id, state: 'no-data', values: data.periods.map(() => null), total: null, sourceLabels };
      const buckets: Decimal[][] = data.periods.map(() => []);
      for (const r of mr) buckets[periodIndex.get(data.periodOf[r.date])!].push(r.value);
      const values = buckets.map((b) => (b.length ? sum(b) : ZERO));
      return { metric: id, state: 'value', values, total: sum(values), sourceLabels };
    });
    return { feature, rows };
  });
}

export const NO_MODEL = '(no model)';

export interface ModelRow {
  model: string;
  /** One value per period in the summary's periods (missing weeks are zero). */
  values: Decimal[];
  total: Decimal;
  byFeature: { feature: string; value: Decimal }[];
}

export interface ModelSummary {
  metric: CanonicalMetric;
  state: 'value' | 'unavailable' | 'no-data';
  periods: Period[];
  /** Every model with data in scope, largest total first. */
  rows: ModelRow[];
  grandTotal: Decimal;
  features: string[];
}

export interface ModelSummaryOptions extends SummaryOptions {
  metric: CanonicalMetric;
  /** Restrict to one period key; null/undefined = all periods. */
  period?: string | null;
}

/** Per-model totals for one metric, summed across the selected features (and accounts). */
export function summariseModels(
  data: Dataset,
  mapping: Record<string, MetricTarget>,
  opts: ModelSummaryOptions,
): ModelSummary {
  const periods = opts.period ? data.periods.filter((p) => p.key === opts.period) : data.periods;
  const features = data.features.filter((f) => !opts.features || opts.features.includes(f));
  const base = { metric: opts.metric, periods, features, rows: [] as ModelRow[], grandTotal: ZERO };
  if (!data.records.some((r) => mapping[r.metricLabel] === opts.metric)) return { ...base, state: 'unavailable' };

  const periodIndex = new Map(periods.map((p, i) => [p.key, i]));
  const byModel = new Map<string, { buckets: Decimal[][]; feat: Map<string, Decimal[]> }>();
  for (const r of data.records) {
    if (mapping[r.metricLabel] !== opts.metric || !features.includes(r.feature)) continue;
    if (opts.account && r.account !== opts.account) continue;
    const i = periodIndex.get(data.periodOf[r.date]);
    if (i === undefined) continue;
    const model = r.model || NO_MODEL;
    let m = byModel.get(model);
    if (!m) byModel.set(model, (m = { buckets: periods.map(() => []), feat: new Map() }));
    m.buckets[i].push(r.value);
    const f = m.feat.get(r.feature) ?? [];
    f.push(r.value);
    m.feat.set(r.feature, f);
  }
  const rows = [...byModel].map<ModelRow>(([model, m]) => {
    const values = m.buckets.map((b) => (b.length ? sum(b) : ZERO));
    return {
      model,
      values,
      total: sum(values),
      byFeature: features.filter((f) => m.feat.has(f)).map((f) => ({ feature: f, value: sum(m.feat.get(f)!) })),
    };
  });
  rows.sort((a, b) => compare(b.total, a.total) || a.model.localeCompare(b.model));
  if (!rows.length) return { ...base, state: 'no-data' };
  return { ...base, state: 'value', rows, grandTotal: sum(rows.map((r) => r.total)) };
}

/** Models whose total in the selected range is at least `min` (all models when min is null). */
export function filterModels(rows: ModelRow[], min: Decimal | null): ModelRow[] {
  return min ? rows.filter((r) => compare(r.total, min) >= 0) : rows;
}
