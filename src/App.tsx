import { useCallback, useMemo, useState } from 'react';
import { buildDataset, summarise } from './lib/aggregate';
import { summaryToCsv } from './lib/csv';
import { defaultMapping, METRICS, type CanonicalMetric, type MetricTarget } from './lib/metrics';
import { MAX_FILE_BYTES, parseWorkbook, WorkbookError, type ParsedFile } from './lib/parse';
import { DropZone } from './components/DropZone';
import { SummaryTable } from './components/SummaryTable';
import { FeatureChart, OverviewChart } from './components/Charts';
import { PALETTE } from './lib/format';
import { MappingPanel } from './components/MappingPanel';

interface LoadedFile {
  id: string;
  name: string;
  size: number;
  parsed?: ParsedFile;
  error?: { message: string; hint: string };
}

const ALL = '__all__';

async function readFile(file: File): Promise<LoadedFile> {
  const base = { id: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, size: file.size };
  try {
    if (file.size > MAX_FILE_BYTES)
      throw new WorkbookError(`"${file.name}" is larger than 25 MB.`, 'Split the export into smaller files and upload them together.');
    const parsed = parseWorkbook(await file.arrayBuffer(), file.name);
    return { ...base, parsed };
  } catch (e) {
    const err =
      e instanceof WorkbookError
        ? { message: e.message, hint: e.hint }
        : { message: `Unexpected error reading "${file.name}": ${(e as Error).message}`, hint: 'Try re-exporting the file.' };
    return { ...base, error: err };
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, MetricTarget>>({});
  const [account, setAccount] = useState<string>(ALL);
  const [hidden, setHidden] = useState<string[]>([]);
  const [chartMetric, setChartMetric] = useState<CanonicalMetric>('aiUnits');

  const onFiles = useCallback(async (list: File[]) => {
    setBusy(true);
    const loaded = await Promise.all(list.map(readFile));
    setFiles((prev) => [...prev.filter((p) => !loaded.some((l) => l.id === p.id)), ...loaded]);
    setBusy(false);
  }, []);

  const reset = () => {
    setFiles([]);
    setOverrides({});
    setAccount(ALL);
    setHidden([]);
    setChartMetric('aiUnits');
  };

  const good = useMemo(() => files.filter((f) => f.parsed).map((f) => f.parsed!), [files]);
  const data = useMemo(() => (good.length ? buildDataset(good) : null), [good]);
  const mapping = useMemo(() => ({ ...defaultMapping(data?.metricLabels ?? []), ...overrides }), [data, overrides]);
  const scopeAccount = account !== ALL && data?.accounts.includes(account) ? account : null;
  const summaries = useMemo(
    () =>
      data ? summarise(data, mapping, { account: scopeAccount, features: data.features.filter((f) => !hidden.includes(f)) }) : [],
    [data, mapping, scopeAccount, hidden],
  );
  const colorOf = useCallback((f: string) => PALETTE[Math.max(0, data?.features.indexOf(f) ?? 0) % PALETTE.length], [data]);

  const n = data?.periods.length ?? 0;
  const totalLabel = data?.granularity === 'irregular' ? 'Total' : `${n}-week total`;
  const scopeLabel = scopeAccount ?? (data && data.accounts.length > 1 ? 'All accounts' : (data?.accounts[0] ?? 'All data'));
  const warnings = files.flatMap((f) => (f.parsed?.warnings ?? []).map((w) => `${f.name}: ${w}`));
  const unavailable = METRICS.filter(
    (m) => summaries.length > 0 && summaries.every((s) => s.rows.find((r) => r.metric === m.id)!.state === 'unavailable'),
  );
  const chartLabel = METRICS.find((m) => m.id === chartMetric)!.label;

  const exportCsv = () => {
    if (!data || !n) return;
    const range = `${data.periods[0].end}_to_${data.periods[n - 1].end}`;
    download(`copilot-usage-summary_${range}.csv`, summaryToCsv(data, summaries, scopeLabel));
  };

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Copilot usage by feature</h1>
          <p className="sub">
            Weekly per-feature summaries from Copilot usage exports.{' '}
            <span className="privacy">🔒 Files are processed entirely in your browser — nothing is uploaded.</span>
          </p>
        </div>
        {files.length > 0 && (
          <div className="actions">
            <button className="btn primary" onClick={exportCsv} disabled={!summaries.length}>
              Export summary CSV
            </button>
            <button className="btn" onClick={reset}>
              Reset
            </button>
          </div>
        )}
      </header>

      <DropZone onFiles={onFiles} busy={busy} compact={files.length > 0} />

      {files.length > 0 && (
        <ul className="files" aria-label="Uploaded files">
          {files.map((f) => (
            <li key={f.id} className={f.error ? 'file err' : 'file ok'}>
              <div className="file-head">
                <span className="dot" aria-hidden="true" />
                <strong className="fname">{f.name}</strong>
                <span className="meta">
                  {f.parsed
                    ? `${f.parsed.records.length.toLocaleString()} values · sheet "${f.parsed.sheetName}" · ${f.parsed.layout === 'wide' ? 'pivot layout' : 'table layout'}`
                    : 'not loaded'}
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}
                >
                  ×
                </button>
              </div>
              {f.error && (
                <div className="file-error" role="alert">
                  <p>{f.error.message}</p>
                  <p className="hint">{f.error.hint}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && (
        <>
          <section className="toolbar" aria-label="Filters">
            {data.accounts.length > 1 && (
              <label>
                Account
                <select value={scopeAccount ?? ALL} onChange={(e) => setAccount(e.target.value)}>
                  <option value={ALL}>All accounts ({data.accounts.length})</option>
                  {data.accounts.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Chart metric
              <select value={chartMetric} onChange={(e) => setChartMetric(e.target.value as CanonicalMetric)}>
                {METRICS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="chips">
              <legend>Features</legend>
              {data.features.map((f) => {
                const on = !hidden.includes(f);
                return (
                  <button
                    key={f}
                    className={`chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    style={{ ['--chip' as string]: colorOf(f) }}
                    onClick={() => setHidden((h) => (on ? [...h, f] : h.filter((x) => x !== f)))}
                  >
                    {f}
                  </button>
                );
              })}
            </fieldset>
            <div className="range">
              {n} {data.granularity === 'irregular' ? 'periods' : `week${n === 1 ? '' : 's'}`} · week ending{' '}
              {data.periods[0]?.label} – {data.periods[n - 1]?.label}
            </div>
          </section>

          {(data.notes.length > 0 || warnings.length > 0 || unavailable.length > 0) && (
            <section className="notices" aria-label="Data notes">
              {unavailable.map((m) => (
                <p key={m.id} className="notice warn">
                  <strong>{m.label} unavailable:</strong> no field in the uploaded file(s) maps to this metric, so it is not
                  shown or estimated. If it exists under another name, map it in <em>Field mapping</em> below.
                </p>
              ))}
              {data.notes.map((t) => (
                <p key={t} className="notice">
                  {t}
                </p>
              ))}
              {warnings.map((t) => (
                <p key={t} className="notice subtle">
                  {t}
                </p>
              ))}
            </section>
          )}

          <MappingPanel
            labels={data.metricLabels}
            mapping={mapping}
            onChange={(l, t) => setOverrides((o) => ({ ...o, [l]: t }))}
          />

          {summaries.length > 1 && (
            <section className="card overview">
              <h2>All features · {chartLabel}</h2>
              <OverviewChart summaries={summaries} periods={data.periods} metric={chartMetric} colorOf={colorOf} />
            </section>
          )}

          {summaries.length === 0 && <p className="notice">All features are hidden. Select a feature above.</p>}

          {summaries.map((s) => (
            <section key={s.feature} className="feature" aria-label={s.feature}>
              <h2>
                <span className="swatch" style={{ background: colorOf(s.feature) }} />
                {s.feature}
              </h2>
              <div className="feature-body">
                <SummaryTable summary={s} periods={data.periods} totalLabel={totalLabel} />
                <div className="chart-card">
                  <div className="chart-title">{chartLabel} per week</div>
                  <FeatureChart summary={s} periods={data.periods} metric={chartMetric} color={colorOf(s.feature)} />
                </div>
              </div>
            </section>
          ))}

          <section className="card defs">
            <h2>Metric definitions</h2>
            <dl>
              {METRICS.map((m) => (
                <div key={m.id}>
                  <dt>{m.label}</dt>
                  <dd>{m.description}</dd>
                </div>
              ))}
              <div>
                <dt>{totalLabel}</dt>
                <dd>
                  Exact sum of the weekly values shown, computed with full source precision and rounded only for display
                  (hover a cell to see the exact value). For active-user records this is a sum of weekly records, not
                  distinct users.
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}

      {!files.length && (
        <section className="card empty">
          <h2>How it works</h2>
          <ol>
            <li>Upload one or more Copilot usage exports (.xlsx), e.g. “View by Copilot Feature and Model”.</li>
            <li>Model-family rows are summed into one table per feature, with a column per week and a total.</li>
            <li>Pick a metric to chart, filter features or accounts, and export the summary as CSV.</li>
          </ol>
        </section>
      )}

      <footer className="foot">Runs locally · No data leaves this browser tab</footer>
    </div>
  );
}
