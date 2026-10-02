import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildDataset, summarise } from './lib/aggregate';
import { summaryToCsv } from './lib/csv';
import { defaultMapping, METRICS, type CanonicalMetric, type MetricTarget } from './lib/metrics';
import { MAX_FILE_BYTES, parseWorkbook, WorkbookError, type ParsedFile } from './lib/parse';
import { DropZone } from './components/DropZone';
import { SummaryTable } from './components/SummaryTable';
import { FeatureChart, OverviewChart } from './components/Charts';
import { PALETTE } from './lib/format';
import { MappingPanel } from './components/MappingPanel';
import { clearState, DEFAULT_PREFS, loadState, saveState, type Prefs, type StoredFile } from './lib/persist';

interface LoadedFile {
  id: string;
  name: string;
  size: number;
  /** Raw workbook bytes, kept only for successfully parsed files so they can be restored locally. */
  bytes?: ArrayBuffer;
  parsed?: ParsedFile;
  error?: { message: string; hint: string };
}

const ALL = '__all__';
const SCROLL_KEY = 'copilot-usage-app:scrollY';

function toLoaded(id: string, name: string, bytes: ArrayBuffer): LoadedFile {
  const base = { id, name, size: bytes.byteLength };
  try {
    return { ...base, bytes, parsed: parseWorkbook(bytes, name) };
  } catch (e) {
    const err =
      e instanceof WorkbookError
        ? { message: e.message, hint: e.hint }
        : { message: `Unexpected error reading "${name}": ${(e as Error).message}`, hint: 'Try re-exporting the file.' };
    return { ...base, error: err };
  }
}

/** Content-based id so the same workbook (uploaded, restored or demo) is never listed twice. */
async function contentId(bytes: ArrayBuffer): Promise<string> {
  if (!crypto?.subtle) return `len:${bytes.byteLength}`;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readFile(file: File): Promise<LoadedFile> {
  const id = `${file.name}:${file.size}:${file.lastModified}`;
  if (file.size > MAX_FILE_BYTES)
    return {
      id,
      name: file.name,
      size: file.size,
      error: { message: `"${file.name}" is larger than 25 MB.`, hint: 'Split the export into smaller files and upload them together.' },
    };
  const bytes = await file.arrayBuffer();
  return toLoaded(await contentId(bytes), file.name, bytes);
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
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  // Until the locally stored session is restored, nothing is saved (avoids overwriting it with an empty state).
  const [restored, setRestored] = useState(false);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const { overrides, account, hidden, chartMetric } = prefs;
  const setAccount = (v: string) => setPrefs((p) => ({ ...p, account: v }));
  const setChartMetric = (v: CanonicalMetric) => setPrefs((p) => ({ ...p, chartMetric: v }));
  const setHidden = (fn: (h: string[]) => string[]) => setPrefs((p) => ({ ...p, hidden: fn(p.hidden) }));
  const setOverride = (label: string, t: MetricTarget) => setPrefs((p) => ({ ...p, overrides: { ...p.overrides, [label]: t } }));

  const addLoaded = useCallback((loaded: LoadedFile[]) => {
    setFiles((prev) => [...prev.filter((p) => !loaded.some((l) => l.id === p.id)), ...loaded]);
  }, []);

  const onFiles = useCallback(
    async (list: File[]) => {
      setBusy(true);
      addLoaded(await Promise.all(list.map(readFile)));
      setBusy(false);
    },
    [addLoaded],
  );

  // Restore the previous local session (workbooks + selections) after reloads or remounts.
  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((state) => {
        if (cancelled || !state) return;
        addLoaded(state.files.map((f) => toLoaded(f.id, f.name, f.bytes)));
        setPrefs(state.prefs);
      })
      .catch(() => !cancelled && setStorageNote('Local session storage is unavailable; data will not survive a page reload.'))
      .finally(() => !cancelled && setRestored(true));
    return () => {
      cancelled = true;
    };
  }, [addLoaded]);

  useEffect(() => {
    if (!restored) return;
    const stored: StoredFile[] = files.filter((f) => f.parsed && f.bytes).map((f) => ({ id: f.id, name: f.name, bytes: f.bytes! }));
    saveState(stored, prefs).catch(() =>
      setStorageNote('Could not save this session locally; it will not survive a page reload.'),
    );
  }, [files, prefs, restored]);

  // Dev-only: ?demo=local loads the workbook the dev server was started with (LOCAL_DEMO_XLSX).
  const [demoError, setDemoError] = useState<string | null>(null);
  useEffect(() => {
    if (!restored || !import.meta.env.DEV || new URLSearchParams(location.search).get('demo') !== 'local') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/__local-demo.xlsx', { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());
        const name = decodeURIComponent(res.headers.get('X-Filename') ?? 'demo.xlsx');
        const bytes = await res.arrayBuffer();
        const id = await contentId(bytes);
        if (!cancelled) addLoaded([toLoaded(id, name, bytes)]);
      } catch (e) {
        if (!cancelled) setDemoError(`Local demo workbook could not be loaded: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restored, addLoaded]);

  // Keep the scroll position across reloads: content renders asynchronously, so restore it once data is back.
  const hasData = files.some((f) => f.parsed);
  useEffect(() => {
    history.scrollRestoration = 'manual';
    let t = 0;
    const onScroll = () => {
      clearTimeout(t);
      t = window.setTimeout(() => sessionStorage.setItem(SCROLL_KEY, String(Math.round(scrollY))), 100);
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      removeEventListener('scroll', onScroll);
    };
  }, []);
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (!restored || scrollRestored.current || !hasData) return;
    scrollRestored.current = true;
    const y = Number(sessionStorage.getItem(SCROLL_KEY));
    if (y > 0) requestAnimationFrame(() => requestAnimationFrame(() => scrollTo(0, y)));
  }, [restored, hasData]);

  const reset = () => {
    setFiles([]);
    setPrefs(DEFAULT_PREFS);
    sessionStorage.removeItem(SCROLL_KEY);
    scrollTo(0, 0);
    clearState().catch(() => undefined);
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
            <span className="privacy">
              🔒 Files are processed entirely in your browser — nothing is uploaded. Your session is kept in this browser
              until you press Reset.
            </span>
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
      {storageNote && <p className="notice subtle">{storageNote}</p>}
      {demoError && (
        <p className="notice warn" role="alert">
          {demoError}
        </p>
      )}

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
            onChange={setOverride}
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
