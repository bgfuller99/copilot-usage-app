# Copilot usage by feature

A browser-only dashboard that turns Copilot usage Excel exports (e.g. **“View by Copilot Feature and Model”**) into weekly per-feature summary tables and bar charts.

**Privacy:** workbooks are parsed entirely in your browser (SheetJS). Nothing is uploaded to a server and nothing is stored. Do not commit customer exports to this repository — `*.xlsx`, `*.xls` and `*.csv` are git-ignored.

## Run

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # parser / aggregation tests (Vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Using it

1. Drag & drop one or more `.xlsx` files onto the upload area (or click to browse). Add several files to combine weeks.
2. Each feature (CLI, Coding Agent, Copilot App, …) gets a table: **Metric**, one column per week, and an **N-week total**.
3. Use **Chart metric** to choose what the bar charts show, toggle features, and pick an account if the file has several.
4. **Export summary CSV** downloads the transformed table at full source precision. **Reset** clears everything.

## Supported input layouts

The parser inspects every sheet and uses the first one that matches:

- **Pivot export (the standard export):** a header row containing `Feature` and `Metric` (optionally `Account` / `Model Family`), with one value column per week. The week date sits in a row above the header (e.g. a `week_end_date` row) or in the header itself. Merged / blank dimension cells are filled down; footer rows such as “Applied filters” are skipped.
- **Table export:** columns `Feature` and a `Date`/`Week` column, plus either `Metric` + `Value` columns or one column per metric.

Values may be numbers or formatted text (`$1,234.56`, `(12.50)`, blanks). Excel date serials are converted without time-zone shifts. Weekly dates are used as-is; daily dates are grouped into 7-day weeks ending on the weekday of the latest date. When several files contain the same account/feature/model/metric/week value it is counted once (if they disagree, the most recently added file wins and a note is shown).

Errors are reported per file with a fix (wrong file type, password-protected, no `Feature`/`Metric` headers, no week dates, unreadable cells…).

## Metric definitions

| Row | Source field (auto-detected) | Definition |
| --- | --- | --- |
| Active-user records | `UBB Active Users` / `Active Users` | Sum of the active-user values across all model-family rows. A person who used two models in a week is counted twice, so this is **not** unique users. The export has no user identifiers, so unique users cannot be derived. Totals are sums of weekly records. |
| AI units consumed | `AI Units Consumed` | Sum of AI units as reported. |
| Gross usage | `Gross Usage $` | Sum of reported gross usage in USD. |
| Billable spend | `Billable Usage $` | Sum of reported billable usage in USD. |

Aggregation uses exact decimal arithmetic (no floating-point drift); rounding happens only for display (hover a cell for the exact value). Dollar amounts are never computed or estimated from units — if a metric is not present in the file, its row shows **Unavailable**. Use **Field mapping** to map a differently named source field to a row, or to ignore a field.

## Stack

React + TypeScript + Vite, [SheetJS](https://sheetjs.com) for workbook parsing, [Recharts](https://recharts.org) for charts, Vitest for tests.

```
src/lib/parse.ts      workbook → normalised records (layout detection, dates, numeric parsing)
src/lib/aggregate.ts  multi-file merge, weekly periods, per-feature summaries
src/lib/decimal.ts    exact decimal sums
src/lib/metrics.ts    canonical metrics + label mapping
src/lib/csv.ts        summary CSV export
```
