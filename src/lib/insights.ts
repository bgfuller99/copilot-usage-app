import { NO_MODEL, summarise, summariseModels, type Dataset, type Period, type SummaryOptions } from './aggregate';
import { compare, sum, toNumber, type Decimal } from './decimal';
import { formatValue } from './format';
import { METRICS, type CanonicalMetric, type MetricTarget } from './metrics';

export interface Finding {
  title: string;
  text: string;
}

export interface Advice {
  title: string;
  evidence: string;
  action: string;
}

export interface UsageInsights {
  periods: Period[];
  partialLabel: string | null;
  story: string;
  findings: Finding[];
  cautions: string[];
  recommendations: Advice[];
  risks: Advice[];
}

const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const share = (part: Decimal, whole: Decimal) => `${percent.format(toNumber(part) / toNumber(whole) * 100)}%`;
const change = (before: Decimal, after: Decimal) => (toNumber(after) / toNumber(before) - 1) * 100;
const direction = (n: number) => n >= 0 ? 'rose' : 'fell';
const positive = (d: Decimal) => d.int > 0n;
const contiguous = (periods: Period[]) => periods.slice(1).every((p, i) =>
  Date.parse(p.end) - Date.parse(periods[i].end) === 7 * 86_400_000,
);

/** Local, evidence-based narrative. Never compares the latest (assumed partial) week. */
export function analyseUsage(
  data: Dataset,
  mapping: Record<string, MetricTarget>,
  opts: SummaryOptions = {},
): UsageInsights {
  const latest = data.periods.at(-1);
  const result: UsageInsights = {
    periods: [],
    partialLabel: latest?.label ?? null,
    story: '',
    findings: [],
    recommendations: [],
    risks: [],
    cautions: [
      'AI units are not tokens. Active-user records are not unique users, and do not prove adoption or productivity.',
      'Gross and billable usage are source-reported amounts, not proof of final invoiced cost. Model mix alone does not establish waste or value.',
    ],
  };
  const scoped = data.records.filter((r) =>
    (!opts.account || r.account === opts.account) && (!opts.features || opts.features.includes(r.feature)),
  );
  const candidates = data.periods.slice(0, -1);
  const incomplete: string[] = [];
  result.periods = candidates.filter((p) => {
    const records = scoped.filter((r) => data.periodOf[r.date] === p.key);
    if (!records.length) return false;
    if (data.granularity === 'bucketed-to-weeks' && new Set(records.map((r) => r.date)).size < 7) {
      incomplete.push(p.label);
      return false;
    }
    return true;
  });
  if (incomplete.length)
    result.cautions.push(`Earlier daily-data periods with fewer than seven reported dates were also excluded: ${incomplete.join(', ')}. Missing dates do not necessarily mean zero usage.`);
  if (!scoped.length) {
    result.story = 'No records match the selected account and features. Select a feature or a different account to see the summary.';
    return result;
  }
  if (!result.periods.length) {
    result.story = 'There is not enough earlier-period data to tell a reliable usage story. The latest week is treated as partial, so no decline or full-week forecast is inferred from it.';
    result.recommendations.push({
      title: 'Establish a comparable baseline',
      evidence: 'No eligible earlier periods remain after excluding the partial latest week.',
      action: 'Upload an export containing at least two earlier complete weeks before making usage or spend decisions.',
    });
    return result;
  }
  const keys = new Set(result.periods.map((p) => p.key));
  const records = scoped.filter((r) => keys.has(data.periodOf[r.date]));
  const earlier: Dataset = { ...data, records, periods: result.periods };
  const summaries = summarise(earlier, mapping, opts);
  const available = METRICS.filter((m) => records.some((r) => mapping[r.metricLabel] === m.id));
  const total = (metric: CanonicalMetric) => sum(records.filter((r) => mapping[r.metricLabel] === metric).map((r) => r.value));
  const metric = available.find((m) => m.id === 'aiUnits') ?? available.find((m) => m.kind === 'usd');
  const range = `${result.periods[0].label}–${result.periods.at(-1)!.label}`;
  const periodWord = data.granularity === 'irregular' ? 'periods' : 'weeks';
  result.story = available.length
    ? `Across ${result.periods.length} earlier ${periodWord} (${range}), the selected data reports ${available.map((m) => `${formatValue(total(m.id), m.kind)} ${m.kind === 'usd' ? m.label.toLowerCase() + ' (USD)' : m.label.toLowerCase()}`).join('; ')}. The latest partial week is not included in these figures.`
    : 'No recognised metrics are reported in the earlier periods. Review Field mapping; no usage or spend is estimated.';
  const missing = METRICS.filter((m) => !available.includes(m));
  if (missing.length)
    result.cautions.push(`Not reported in the analysed periods: ${missing.map((m) => m.label).join(', ')}. Missing values are not evidence of zero usage.`);

  const negative = records.some((r) => available.some((m) => mapping[r.metricLabel] === m.id) && r.value.int < 0n);
  if (negative)
    result.cautions.push('Negative values are present (possibly corrections). Concentration shares and change claims are suppressed; review the source before drawing conclusions.');
  if (negative)
    result.risks.push({
      title: 'Reporting-confidence risk',
      evidence: 'The analysed values include negative corrections.',
      action: 'Reconcile the corrections with the source owner before using trends or shares to make commercial decisions.',
    });

  if (metric && !negative && positive(total(metric.id))) {
    const ranked = summaries.flatMap((s) => {
      const row = s.rows.find((r) => r.metric === metric.id)!;
      return row.total ? [{ feature: s.feature, value: row.total }] : [];
    }).sort((a, b) => compare(b.value, a.value));
    const top = ranked[0];
    if (top && positive(top.value))
      result.recommendations.push({
        title: `Prioritise the ${top.feature} workload review`,
        evidence: `${top.feature} contributes ${share(top.value, total(metric.id))} of ${metric.label.toLowerCase()} (${formatValue(top.value, metric.kind)}).`,
        action: 'Review its largest workloads with the team first. Measure task quality and completion outcomes alongside consumption before changing defaults or setting limits.',
      });
    if (top)
      result.findings.push({
        title: 'Where usage is concentrated',
        text: `${top.feature} is the largest contributor to ${metric.label.toLowerCase()}: ${formatValue(top.value, metric.kind)} (${share(top.value, total(metric.id))} of the selected total). Start here when discussing workload or model choices; volume alone does not measure effectiveness.`,
      });
    const models = summariseModels(earlier, mapping, { ...opts, metric: metric.id });
    const named = models.rows.filter((r) => r.model !== NO_MODEL);
    if (named.length && positive(named[0].total)) {
      const leader = named[0];
      if (toNumber(leader.total) / toNumber(models.grandTotal) >= 0.5 && named.length > 1) {
        result.recommendations.push({
          title: 'Validate model-to-task fit',
          evidence: `${leader.model} accounts for ${share(leader.total, models.grandTotal)} of ${metric.label.toLowerCase()} across the selected scope.`,
          action: 'Sample representative tasks on this model and compare suitable alternatives for quality, latency and source-reported spend. Keep the current model where it delivers better outcomes; do not assume a cheaper substitute will be equivalent.',
        });
        result.risks.push({
          title: 'Model-concentration watch',
          evidence: `One reported model or family (${leader.model}) exceeds the 50% review threshold.`,
          action: 'Check whether teams have tested alternative models for critical workflows. Concentration is a review signal, not evidence of waste, excessive pricing or an imminent outage.',
        });
      }
      result.findings.push({
        title: 'Model mix',
        text: `${leader.model} leads reported model usage with ${formatValue(leader.total, metric.kind)} ${metric.kind === 'usd' ? 'USD' : metric.label.toLowerCase()} (${share(leader.total, models.grandTotal)} of the selected total). Labels are taken from the file: model-family labels cannot reveal individual versions.`,
      });
    }
    if (models.rows.some((r) => r.model === NO_MODEL))
      result.cautions.push('Some usage has no model label; it remains in the totals but cannot be attributed to a named model.');
  }

  const canCompare = result.periods.length >= 2 && data.granularity !== 'irregular' && contiguous(result.periods) && !negative;
  if (!canCompare) {
    result.cautions.push(result.periods.length < 2
      ? 'At least two earlier weeks are needed for trend comparisons.'
      : 'Trend comparisons are suppressed because of missing/irregular periods or negative values; no missing week is filled with zero.');
  } else {
    const first = result.periods[0];
    const last = result.periods.at(-1)!;
    const sameCoverage = (m: CanonicalMetric, feature?: string) => {
      const slices = (p: Period) => new Set(records.filter((r) =>
        mapping[r.metricLabel] === m && data.periodOf[r.date] === p.key && (!feature || r.feature === feature),
      ).map((r) => JSON.stringify([r.account, r.feature, r.model])));
      const a = slices(first), b = slices(last);
      return a.size > 0 && a.size === b.size && [...a].every((key) => b.has(key));
    };
    const valueAt = (m: CanonicalMetric, p: Period) => {
      const rs = records.filter((r) => mapping[r.metricLabel] === m && data.periodOf[r.date] === p.key);
      return rs.length ? sum(rs.map((r) => r.value)) : null;
    };
    if (metric) {
      const before = valueAt(metric.id, first);
      const after = valueAt(metric.id, last);
      if (before && after && positive(before) && sameCoverage(metric.id)) {
        const delta = change(before, after);
        if (delta <= -20 || delta >= 30)
          result.risks.push({
            title: delta < 0 ? 'Consumption-decline watch' : 'Consumption-growth watch',
            evidence: `${metric.label} ${direction(delta)} ${percent.format(Math.abs(delta))}% between ${first.label} and ${last.label} (${formatValue(before, metric.kind)} → ${formatValue(after, metric.kind)}); the partial latest week is excluded.`,
            action: delta < 0
              ? 'Ask whether a project finished, workloads moved, or access changed. Verify with workflow outcomes and unique-user telemetry before treating this as an adoption or renewal risk.'
              : 'Check whether growth matches an intended rollout and review budget headroom if spend is reported. Do not infer a budget breach or full-month forecast from these values alone.',
          });
        result.findings.push({
          title: 'Earlier-week trend',
          text: `${metric.label} ${direction(delta)} ${percent.format(Math.abs(delta))}% from ${formatValue(before, metric.kind)} (${first.label}) to ${formatValue(after, metric.kind)} (${last.label}). This comparison excludes ${latest?.label}. It describes reported consumption, not a proven change in adoption.`,
        });
      } else if (before && after && !sameCoverage(metric.id)) {
        result.cautions.push('Overall consumption trend is suppressed because the first and last earlier weeks report different account/feature/model slices. Missing rows cannot safely be interpreted as zero.');
      }
      const moves = summaries.flatMap((s) => {
        const row = s.rows.find((r) => r.metric === metric.id)!;
        const hasBoth = [first, last].every((p) => records.some((r) =>
          r.feature === s.feature && mapping[r.metricLabel] === metric.id && data.periodOf[r.date] === p.key,
        ));
        if (!hasBoth || !sameCoverage(metric.id, s.feature) || !row.values[0] || !row.values.at(-1) || !positive(row.values[0])) return [];
        const delta = change(row.values[0], row.values.at(-1)!);
        return Math.abs(delta) >= 20 ? [{ feature: s.feature, delta, before: row.values[0], after: row.values.at(-1)! }] : [];
      }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
      if (moves.length)
        result.findings.push({
          title: 'Standout feature changes',
          text: moves.map((m) => `${m.feature} ${direction(m.delta)} ${percent.format(Math.abs(m.delta))}% (${formatValue(m.before, metric.kind)} → ${formatValue(m.after, metric.kind)})`).join('; ') +
            ` between ${first.label} and ${last.label}. Small starting values can exaggerate percentage changes; ask about workload or rollout changes rather than assuming a cause.`,
        });
      for (const move of moves.slice(0, 2))
        result.recommendations.push({
          title: `Investigate the ${move.feature} change`,
          evidence: `${metric.label} ${direction(move.delta)} ${percent.format(Math.abs(move.delta))}% (${formatValue(move.before, metric.kind)} → ${formatValue(move.after, metric.kind)}) between ${first.label} and ${last.label}.`,
          action: move.delta < 0
            ? 'Confirm whether this reflects a completed workload, a surface change or friction using the feature. If friction is confirmed, offer targeted enablement and check again after another complete week.'
            : 'Ask which workflows drove the increase, capture successful patterns, and review quality and spend before extending the rollout.',
        });
    }
    const u1 = valueAt('aiUnits', first), u2 = valueAt('aiUnits', last);
    const b1 = valueAt('billableSpend', first), b2 = valueAt('billableSpend', last);
    if (u1 && u2 && b1 && b2 && positive(u1) && positive(b1) && sameCoverage('aiUnits') && sameCoverage('billableSpend') && Math.abs(change(u1, u2) - change(b1, b2)) >= 20) {
      result.findings.push({
        title: 'Spend and consumption tell different stories',
        text: `AI units ${direction(change(u1, u2))} ${percent.format(Math.abs(change(u1, u2)))}%, while billable usage ${direction(change(b1, b2))} ${percent.format(Math.abs(change(b1, b2)))}% over the same earlier weeks. A spend change is not an equivalent adoption change: check model mix and included allowances or adjustments. The file alone cannot establish the cause.`,
      });
      result.risks.push({
        title: 'Spend-interpretation risk',
        evidence: `AI-unit and billable-usage changes differ by ${percent.format(Math.abs(change(u1, u2) - change(b1, b2)))} percentage points over the same earlier weeks.`,
        action: 'Reconcile model mix, included allowances and adjustments before forecasting cost or attributing the spend change to adoption. Validate final charges against the billing source.',
      });
    }
  }
  if (!result.recommendations.length)
    result.recommendations.push({
      title: 'Improve the evidence before acting',
      evidence: 'The current scope has no eligible concentration or comparable change signal.',
      action: 'Review field mapping and date coverage, then collect comparable complete weeks. No model switch, budget change or adoption intervention is justified by this report alone.',
    });
  if (data.notes.length)
    result.cautions.push('Review Data notes above for overlapping exports, conflicts and date coverage before relying on the conclusions.');
  result.cautions.push('Missing model/feature cells are not assumed to be actual zeros for change claims. Earlier weekly columns are assumed complete; a pivot export cannot verify their day-by-day coverage.');
  return result;
}
