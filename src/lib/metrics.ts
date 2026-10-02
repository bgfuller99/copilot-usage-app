export type CanonicalMetric = 'activeUserRecords' | 'aiUnits' | 'grossUsage' | 'billableSpend';
export type MetricTarget = CanonicalMetric | 'ignore';

export interface MetricDefinition {
  id: CanonicalMetric;
  label: string;
  kind: 'count' | 'units' | 'usd';
  description: string;
}

export const METRICS: readonly MetricDefinition[] = [
  {
    id: 'activeUserRecords',
    label: 'Active-user records',
    kind: 'count',
    description:
      'Sum of the source "active users" values across every model-family row (and week). One person who used two models in a week is counted twice, so this is NOT a count of unique users. The export does not contain user identifiers, so unique users cannot be derived.',
  },
  {
    id: 'aiUnits',
    label: 'AI units consumed',
    kind: 'units',
    description: 'Sum of AI units consumed exactly as reported in the source.',
  },
  {
    id: 'grossUsage',
    label: 'Gross usage',
    kind: 'usd',
    description: 'Sum of the source gross usage (USD) before discounts/included allowances. Taken verbatim from the file; never computed from units.',
  },
  {
    id: 'billableSpend',
    label: 'Billable spend',
    kind: 'usd',
    description: 'Sum of the source billable usage (USD). Taken verbatim from the file; never estimated.',
  },
];

export const METRIC_BY_ID: Record<CanonicalMetric, MetricDefinition> = Object.fromEntries(
  METRICS.map((m) => [m.id, m]),
) as Record<CanonicalMetric, MetricDefinition>;

const RULES: ReadonlyArray<[RegExp, CanonicalMetric]> = [
  [/active\s*users?|\bmau\b|\bdau\b|\bwau\b|user\s*records?/i, 'activeUserRecords'],
  [/ai\s*units?|units?\s*consumed|^units$/i, 'aiUnits'],
  [/gross/i, 'grossUsage'],
  [/billable|net\s*(usage|spend|amount)|^spend$/i, 'billableSpend'],
];

/** Suggest a canonical metric for a source metric label, or 'ignore' when unrecognised. */
export function suggestMetric(label: string): MetricTarget {
  for (const [re, id] of RULES) if (re.test(label)) return id;
  return 'ignore';
}

export function defaultMapping(labels: Iterable<string>): Record<string, MetricTarget> {
  const out: Record<string, MetricTarget> = {};
  for (const l of labels) out[l] = suggestMetric(l);
  return out;
}
