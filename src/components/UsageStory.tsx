import { useMemo } from 'react';
import type { Dataset, SummaryOptions } from '../lib/aggregate';
import { analyseUsage } from '../lib/insights';
import type { MetricTarget } from '../lib/metrics';

interface Props {
  data: Dataset;
  mapping: Record<string, MetricTarget>;
  options: SummaryOptions;
  scopeLabel: string;
  hasWarnings: boolean;
}

export function UsageStory({ data, mapping, options, scopeLabel, hasWarnings }: Props) {
  const report = useMemo(() => analyseUsage(data, mapping, options), [data, mapping, options]);
  return (
    <section className="card usage-story" aria-labelledby="usage-story-title">
      <h2 id="usage-story-title">What story does the data tell?</h2>
      <p className="sub">Automated analysis · {scopeLabel} · selected account and shown features, across the report’s weeks.
        Model-view metric, minimum and week filters do not change this summary.</p>
      <p className="notice warn">
        <strong>Latest week{report.partialLabel ? ` (${report.partialLabel})` : ''} is treated as partial.</strong>{' '}
        It stays in the dashboard tables, but is excluded from all analysis below. A lower latest-week value
        is not interpreted as a decline, and is never extrapolated to a full week.
      </p>
      <p className="story-lead">{report.story}</p>
      {report.findings.length > 0 && (
        <div className="story-findings">
          {report.findings.map((f) => (
            <article key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      )}
      {report.recommendations.length > 0 && (
        <>
          <h3>Based on this data, recommended next steps</h3>
          <div className="story-findings">
            {report.recommendations.map((r) => (
              <article key={r.title}>
                <h3>{r.title}</h3>
                <p><strong>Based on:</strong> {r.evidence}</p>
                <p><strong>I recommend:</strong> {r.action}</p>
              </article>
            ))}
          </div>
        </>
      )}
      {report.periods.length > 0 && (
        <>
          <h3>Risk flags to investigate</h3>
          <p className="sub">Review signals, not confirmed risks. Thresholds: model share ≥50% (with multiple named models);
            consumption decline ≥20%, growth ≥30%; spend/consumption divergence ≥20 percentage points.
            These are review rules, not customer-specific budget limits.</p>
          {report.risks.length ? (
            <div className="story-findings">
              {report.risks.map((r) => (
                <article key={r.title}>
                  <h3>{r.title}</h3>
                  <p><strong>Flagged because:</strong> {r.evidence}</p>
                  <p><strong>Next check:</strong> {r.action}</p>
                </article>
              ))}
            </div>
          ) : <p>No rule-based risk flags were triggered in the eligible data. This does not establish that the customer is risk-free.</p>}
        </>
      )}
      <h3>Things to be aware of</h3>
      <ul className="story-cautions">
        {report.cautions.map((text) => <li key={text}>{text}</li>)}
        {hasWarnings && <li>Some files have parsing warnings or errors. Review the upload and Data notes above; omitted values may affect this summary.</li>}
      </ul>
      <p className="sub">Generated locally from the uploaded values using transparent rules, not an external AI model.
        No report data is sent to an AI service. Recommendations are evidence-based checks, not proven causes,
        guaranteed savings or automatic instructions to switch models.</p>
    </section>
  );
}
