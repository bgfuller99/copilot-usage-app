import { METRICS, type CanonicalMetric, type MetricTarget } from './metrics';

/**
 * Browser-local persistence so uploaded workbooks and selections survive reloads,
 * dev-server restarts and component remounts. Stored only in this browser's IndexedDB
 * (never sent anywhere); cleared by Reset.
 */
export interface StoredFile {
  id: string;
  name: string;
  bytes: ArrayBuffer;
}

export interface Prefs {
  chartMetric: CanonicalMetric;
  account: string;
  hidden: string[];
  overrides: Record<string, MetricTarget>;
  /** Model usage view: metric, feature ('__all__' = all visible), period key ('__all__' = all weeks), minimum total. */
  view: 'features' | 'models';
  modelMetric: CanonicalMetric;
  modelFeature: string;
  modelPeriod: string;
  modelMin: string;
}

export interface StoredState {
  version: 1;
  files: StoredFile[];
  prefs: Prefs;
}

export const DEFAULT_PREFS: Prefs = { chartMetric: 'aiUnits', account: '__all__', hidden: [], overrides: {}, view: 'features', modelMetric: 'aiUnits', modelFeature: '__all__', modelPeriod: '__all__', modelMin: '' };

const DB = 'copilot-usage-app';
const STORE = 'state';
const KEY = 'current';
const TARGETS = new Set<string>([...METRICS.map((m) => m.id), 'ignore']);

/** Validate untrusted stored prefs, falling back to defaults field by field. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const overrides: Record<string, MetricTarget> = {};
  if (r.overrides && typeof r.overrides === 'object')
    for (const [k, v] of Object.entries(r.overrides)) if (typeof v === 'string' && TARGETS.has(v)) overrides[k] = v as MetricTarget;
  return {
    chartMetric: METRICS.some((m) => m.id === r.chartMetric) ? (r.chartMetric as CanonicalMetric) : DEFAULT_PREFS.chartMetric,
    account: typeof r.account === 'string' ? r.account : DEFAULT_PREFS.account,
    hidden: Array.isArray(r.hidden) ? r.hidden.filter((h): h is string => typeof h === 'string') : [],
    overrides,
    view: r.view === 'models' ? 'models' : 'features',
    modelMetric: METRICS.some((m) => m.id === r.modelMetric) ? (r.modelMetric as CanonicalMetric) : DEFAULT_PREFS.modelMetric,
    modelFeature: typeof r.modelFeature === 'string' ? r.modelFeature : DEFAULT_PREFS.modelFeature,
    modelPeriod: typeof r.modelPeriod === 'string' ? r.modelPeriod : DEFAULT_PREFS.modelPeriod,
    modelMin: typeof r.modelMin === 'string' ? r.modelMin.slice(0, 32) : DEFAULT_PREFS.modelMin,
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function loadState(): Promise<StoredState | null> {
  if (!storageAvailable()) return null;
  const raw = (await run('readonly', (s) => s.get(KEY))) as Partial<StoredState> | undefined;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.files)) return null;
  const files = raw.files.filter(
    (f): f is StoredFile => !!f && typeof f.id === 'string' && typeof f.name === 'string' && f.bytes instanceof ArrayBuffer,
  );
  return { version: 1, files, prefs: sanitizePrefs(raw.prefs) };
}

export async function saveState(files: StoredFile[], prefs: Prefs): Promise<void> {
  if (!storageAvailable()) return;
  const state: StoredState = { version: 1, files, prefs };
  await run('readwrite', (s) => s.put(state, KEY));
}

export async function clearState(): Promise<void> {
  if (!storageAvailable()) return;
  await run('readwrite', (s) => s.delete(KEY));
}
