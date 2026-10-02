import { METRICS, suggestMetric, type MetricTarget } from '../lib/metrics';

interface Props {
  labels: string[];
  mapping: Record<string, MetricTarget>;
  onChange: (label: string, target: MetricTarget) => void;
}

export function MappingPanel({ labels, mapping, onChange }: Props) {
  const unmapped = labels.filter((l) => mapping[l] === 'ignore').length;
  const targets = Object.values(mapping);
  const duplicates = METRICS.filter((m) => targets.filter((t) => t === m.id).length > 1);
  return (
    <details className="panel" open={unmapped > 0}>
      <summary>
        Field mapping <span className="badge">{labels.length} source metric{labels.length === 1 ? '' : 's'}</span>
        {unmapped > 0 && <span className="badge warn">{unmapped} ignored</span>}
      </summary>
      <p className="hint">
        Each metric label found in the file is mapped to a summary row. Labels are auto-detected; change a mapping if a
        field uses a different name. Nothing is estimated — rows with no mapped field show as unavailable.
      </p>
      <div className="mapping-grid">
        {labels.map((label) => (
          <label key={label} className="mapping-row">
            <span className="src">
              {label}
              {suggestMetric(label) !== mapping[label] && <em> (custom)</em>}
            </span>
            <select value={mapping[label]} onChange={(e) => onChange(label, e.target.value as MetricTarget)}>
              {METRICS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="ignore">Ignore</option>
            </select>
          </label>
        ))}
      </div>
      {duplicates.length > 0 && (
        <p className="hint warn-text">
          Several source fields map to {duplicates.map((d) => d.label).join(', ')}; their values are added together.
        </p>
      )}
    </details>
  );
}
