import { toNumber, toPlainString, type Decimal } from './decimal';
import type { MetricDefinition } from './metrics';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Display-only formatting; aggregation keeps the exact Decimal. */
export function formatValue(d: Decimal, kind: MetricDefinition['kind']): string {
  const n = toNumber(d);
  const out = kind === 'usd' ? usd.format(n) : whole.format(n);
  return out === '-0' || out === '-$0.00' ? out.replace('-', '') : out;
}

export function formatAxis(n: number, kind: MetricDefinition['kind']): string {
  return kind === 'usd' ? compactUsd.format(n) : compact.format(n);
}

export function formatNumber(n: number, kind: MetricDefinition['kind']): string {
  return kind === 'usd' ? usd.format(n) : whole.format(n);
}

export function exactTitle(d: Decimal): string {
  return `Exact: ${toPlainString(d)}`;
}

export const PALETTE = ['#6ea8fe', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#94a3b8'];
