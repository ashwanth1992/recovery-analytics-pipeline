# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A production Google Apps Script (V8 runtime) pipeline for FinanceOrg. It syncs, transforms, and aggregates financial data (CBC collections, penal recovery, payments, dispositions) across Google Sheets. Deployed to Google Cloud via `clasp`.

## Deployment

```bash
# Push local changes to Apps Script
clasp push

# Pull latest from Apps Script
clasp pull
```

The project is mapped via `.clasp.json` to script ID `YOUR_SCRIPT_ID`.

## Architecture

### Execution Model

The pipeline uses a **sentinel-based scheduler** with state persisted in PropertiesService. Every function must complete within Google's 6-minute execution limit; long jobs use relay logic (queue a re-trigger before hitting `MAX_EXECUTION_TIME_MS = 25min`).

### Entry Points

| Function | Trigger | Purpose |
|---|---|---|
| `triggerSentinel()` | 1-hour cron | Main 1H/1D job pipeline (runs a tier only if its time-block stamp is due) |
| `triggerDispoAggregation()` | 10-min cron | N-phase dispo aggregation (N = active TCN_DISPO_* sources + dedup) |
| `triggerPostProcessing()` | 5-min cron | Penal metrics, discounts, daily inputs |
| `triggerCallAggregation()` | 5-min cron | N-phase call log aggregation (N = active call sources + anomaly scan) |
| `generateVintageViews()` | Manual / chained | View 2 → View 3 waterfall allocation |
| `forceRunSentinel()` | Manual | Force immediate Sentinel run |
| `clearAllProperties()` | Manual (month-end) | Wipe all PropertiesService state. Monthly agg sheet is archived as-is — run `createMonthlyAggSheet()` immediately after. |

### Module Responsibilities

- **`New_Sync_Engine.js`** — Sentinel orchestrator: reads `Routing_Config` sheet, routes to job handlers, manages relay/resume, semaphores, and self-healing.
- **`Master_Sheet_Calc.js`** — `COPY_ALL`, `CALC:`, `LOOKUP_JOIN`, `SUM_JOIN` job types.
- **`Payment_Sheet_Calc.js`** — `PAYMENT_AGG` job type: aggregates raw payments into `Collection_Summary` as a long table with 5 row types per lead (see Charge Type Schema below).
- **`Input_Sheet_Calcs.js`** — `BASE_DATA_UPDATE` job type (RAM-map conditional updates).
- **`Dashboard_Sheet_Calc.js`** — `DASH_CBC_PAYMENTS_CALC`, `ALLOCATION_CALC` job types.
- **`Post_Sentinel_1.js`** — Dispo aggregation: loads all active `Dispo_Merge` sources dynamically, reads only new rows per source (incremental checkpoint), appends filtered rows to `Dispo_Cache` in the monthly agg sheet, then deduplicates and writes to `Combined_Dispo_Logs` in the same sheet. PB_DISPO removed Jun'26 — all sources are now TCN. Dedup is a 15-min window only (keep latest per window). Alloc map built once per run. `Dispo_Audit` tab shows per-source row counts before/after dedup. `getMonthlyAggSheetId()` resolves the monthly sheet ID from the DESTINATION config row. Force Reset checkboxes in the Post_Sentinel tab trigger `forceReprocessDispoSource(key)` automatically at the start of a run.
- **`Post_Sentinel_2.js`** — Call log aggregation: loads all active `Call_Merge` sources dynamically, reads only new rows per source (incremental checkpoint), appends directly to `Combined_Call_Logs` in the monthly agg sheet. Sources with keys starting `OZO` use the Ozonetel column schema; all others use TCN schema. Anomaly scan is always the final phase. Force Reset checkboxes trigger `forceReprocessCallSource(key)` at run start.
- **`Post_Sentinel_3.js`** — Post-processing (penal metrics, discounts, daily inputs). Reads `Combined_Dispo_Logs` and `Combined_Call_Logs` from the monthly agg sheet (via PP_STEP_2/PP_STEP_3 config). Writes best/last dispo + call stats to cols U:Z in "2. PENAL DATA".
- **`Vintage.js`** — Vintage views orchestrator (accrued → View 2 → View 3 waterfall).
- **`Pipeline_Robustness.js`** — Validation layer: config checker, destination header alignment, source freshness, heartbeat alerts.
- **`utils.js`** — Shared utilities: parsing, MD5 hashing, batching, exponential backoff, config loading.
- **`CC_Backend.js`** — Control Center web app backend (state, job status, run history).
- **`Setup_&_Tools.js`** — Trigger installation, developer tools, manual reset utilities, monthly agg sheet setup.
- **`ControlCenter.html`** — Monitoring UI with real-time polling (30s active / 60s idle / 5min dormant).

### Monthly Aggregation Sheet

From Jun'26 onward, all dispo and call aggregation data lives in a **dedicated per-month Google Sheet** (e.g. `"FinanceOrg Agg — Jun'26"`). This avoids the 10M-cell Google Sheets limit and provides a natural monthly archive.

**Tabs in the monthly sheet:**

| Tab | Purpose | Note |
|---|---|---|
| `Dispo_Cache` | Intermediate filtered rows during dispo aggregation | Internal scratch — col B stores raw ms timestamps for dedup math, not readable as dates |
| `Dispo_Audit` | Per-run dedup stats (sources × before/after counts) | Overwritten each run |
| `Combined_Dispo_Logs` | Final deduped dispo output | Col B = `pb_calling_status` (outcome), Col C = `call_dialled_on` (Sheets serial date — formattable) |
| `Combined_Call_Logs` | Aggregated call log | 7 cols: lead_id, phone, timestamp, talk_sec, source, agent, campaign |
| `Call_Audit` | Cross-source anomaly log | Written by anomaly scan phase |

**`getMonthlyAggSheetId()`** (in `Post_Sentinel_1.js`) resolves the monthly sheet ID by reading the `ssId` from the `DESTINATION` row in the Post_Sentinel config table. This means it survives `clearAllProperties()` — the config table lives in the Control Center spreadsheet, not PropertiesService.

**Month-end workflow:**
```javascript
// Step 1 — wipe all PropertiesService state (checkpoints, semaphores, hashes)
clearAllProperties()

// Step 2 — create a fresh sheet for the new month and wire up all config rows
createMonthlyAggSheet("Jul'26")

// For an existing pre-created sheet, pass its ID:
createMonthlyAggSheet("Jun'26", "YOUR_MONTHLY_AGG_SHEET_ID")
```

`createMonthlyAggSheet()` creates the 5 tabs with headers and automatically updates these Post_Sentinel config rows to point to the new sheet:
`DESTINATION`, `CALL_DESTINATION`, `CALL_AUDIT`, `PP_STEP_2`, `PP_STEP_3`.

### Charge Type Schema (Collection_Summary)

`runPaymentSummary` buckets payments by `charge_type` and emits one row per lead per non-empty bucket in `Collection_Summary` (cols A–H: Lead ID, NACH, UPI, App, Others, Sum, Latest Date, Row Type):

| Row Type | Charge types included |
|---|---|
| `Total` | All (incl. Bounce-Rep) |
| `Bounce` | `2` |
| `Penal` | `4` |
| `Bounce-Rep` | `36` (added Jun'26 — "Additional Representation" charges) |
| `B+P Total` | `2` + `4` only (excludes 36; used by 0-bkt input to avoid double-counting) |

Payment routing within each bucket: `payment_type` 3/19 → NACH, 11 → UPI (also App if app-paid flag), else Others.

**`2. PENAL DATA` collection columns** (in the 0-bkt inputs sheet): P/Q/R = BAU Non-NACH / Total / Latest Date (from "B+P Total" rows), S/T = Add-Rep Non-NACH / Total (from "Bounce-Rep" rows, 2-col SUM_JOIN mode). Columns from old S onward shifted +2 in Jun'26 — Allocation Status is now AC, Allocation Date AD, TC Name AB. Hardcoded indices in `Post_Sentinel_1.js` (`_buildDispoAllocMap`) and `Post_Sentinel_3.js` reflect this; re-check them if columns are inserted/removed again. The penal-metrics write block (`calculatePenalMetrics` in `Post_Sentinel_3.js`) outputs 6 cols (attempts, answered, talk time, last call date, best/last dispo) to **U:Z** (was S:X pre-shift) — after moving it, purge its content hashes via `clearPenalMetricsHashes()` in `Setup_&_Tools.js`, or the hash-gate will skip all writes to the new location.

`runPaymentSummary` (`Payment_Sheet_Calc.js`) auto-expands `Collection_Summary` before writing if the output rows exceed the sheet's grid limit — prevents the "exceeds grid limits" API error as the dataset grows.

### Post-Sentinel Source Configuration (`Post_Sentinel` tab)

Dispo and call aggregation sources are configured in the `Post_Sentinel` tab of the Control Center spreadsheet — **not** in `Routing_Config`. The tab has **8 columns**: `Function | Config Key | Sheet ID | Tab Name | Date Range | Active | Notes | Force Reset`.

**To add or remove a source — just add/remove a row and toggle `Active`. No code change needed.**

| Function | Reserved keys (never toggled off) | Source keys (add freely) |
|---|---|---|
| `Dispo_Merge` | `DESTINATION` | `TCN_DISPO_1`, `TCN_DISPO_2`, … `TCN_DISPO_N` |
| `Call_Merge` | `CALL_DESTINATION`, `CALL_AUDIT` | `OZO_*` (Ozonetel schema), `TCN_CALLS_1`, … `TCN_CALLS_N` |
| `Post_Processing` | `PP_STEP_1`, `PP_STEP_2`, `PP_STEP_3` | — |

`DESTINATION`, `CALL_DESTINATION`, `CALL_AUDIT`, `PP_STEP_2`, and `PP_STEP_3` all point to the **monthly agg sheet** (Sheet ID + tab name updated by `createMonthlyAggSheet()` at month start).

**Col H — Force Reset checkbox:** tick a source row and run `manualRunDispoAgg()` or `manualRunCallAgg()`. The aggregator clears that source's checkpoint and removes its rows from the cache, then auto-unchecks the box. Normal sources are unaffected. This replaces manually calling `forceReprocessDispoSource(key)`.

Key rules:
- Dispo sources are sorted **alphabetically by key** at runtime — naming them `TCN_DISPO_1`, `TCN_DISPO_2` etc. keeps phase order consistent across relay triggers.
- Call sources with keys starting with `OZO` use the Ozonetel column schema (`uui`, `call_date`+`start_time`, `talk_time` HH:MM:SS). All other call sources use the TCN schema (`loan_id`, `call_time`, `talk_duration` seconds).
- `Date Range` (e.g. `11-20`) gates a source to only be active from that day of the month onward — leave blank for always-active.

### Job Configuration

Jobs are defined in the `Routing_Config` tab of the Control Center spreadsheet (`YOUR_CONTROL_CENTER_SHEET_ID`). Each row specifies source/dest sheet IDs, schedule (`1H`/`1D`/`NIGHTLY`/`DEDICATED`), job type, and column mappings.

Config-loading notes:
- Source/dest IDs and tab names are **trimmed** on load (a stray space in a cell used to make `getSheetByName` return null).
- `Source Cols`/`Dest Cols` are parsed to **0-based** indices (`parseInt - 1`).
- `SUM_JOIN` write placement is driven by `Dest Cols`: blank → 3-col mode at P:R (non-NACH, total, date); one entry → 3-col mode at that column; two entries → **2-col mode** (non-NACH, total — no date) starting at the first column. E.g. `19,20` writes S:T.

### State Management (PropertiesService keys)

| Key pattern | Purpose |
|---|---|
| `SENTINEL_RUNNING` | Timestamp of active Sentinel run |
| `ACTIVE_RELAY` | JSON resume state for in-progress job |
| `H_<jobname>_B<idx>` | MD5 hash of last written chunk (skip-if-unchanged) |
| `RD_<jobname>` | Read row pointer for resumable batch jobs |
| `POST_PROCESS_PENDING`, `DISPO_AGG_PENDING`, `CALL_AGG_PENDING` | Phase flags for post-sentinel engines |
| `DISPO_CACHE_ROW_<key>` | Last row number cached for each dispo source (e.g. `DISPO_CACHE_ROW_TCN_DISPO_1`); skip source if `getLastRow()` equals this |
| `CALL_CACHE_ROW_<key>` | Last row number cached for each call source (e.g. `CALL_CACHE_ROW_TCN_CALLS_1`) |
| `PAUSED_UNTIL` | Pause end timestamp |
| `LAST_RUN_1H` / `LAST_RUN_1D` / `LAST_RUN_30M` / `LAST_RUN_NIGHT` | Time-block stamps; a tier runs only when the current block differs. The Control Center "Run now" button (`ccTriggerManualRun`) deletes the 1H/30M stamps so a manual click always re-runs the hourly tier (1D is intentionally left). `forceRunSentinel()` clears all three. |

Note: the monthly agg sheet ID is **not** stored in PropertiesService — it is derived at runtime from the `DESTINATION` config row via `getMonthlyAggSheetId()`, so it survives `clearAllProperties()`.

### Performance Patterns

- **Spreadsheet cache** (`_ssCache`) — reuse open `Spreadsheet` references within a run.
- **Adaptive batching** — `getOptimalBatchSize()` uses 50k cells/batch for heavy sheets, 250k for normal.
- **Hash-gated writes** — MD5 checksum on each chunk; skip write if unchanged. ⚠️ If destination columns are cleared/moved externally, a re-run reports "Success" but writes nothing (hashes still match). Purge with the **Force Reset checkbox (col K)** in `Routing_Config` — honored by both `runHybridSync` and dedicated runners (router + `testSingleJob`) via `purgeJobState()` — or run `clearHashesForTestRow()` for the row in Q2.
- **Exponential backoff** — `withExponentialBackoff()` wraps all Sheets API calls (max ~5 min of retries).
- **Semaphores** — `SENTINEL_RUNNING`, `CBC_DEDICATED_RUNNING`, `DISPO_AGG_RUNNING` prevent concurrent runs.

## Testing & Validation

```javascript
// Test a single job: set row number in cell Q2 of Control Center sheet, then call:
testSingleJob()

// Validate Routing_Config before deploying changes:
validateRoutingConfig()

// Clear stuck semaphores / detect deadlocks:
selfHealStuckStates()

// Purge row pointers + write-hashes for the job in Q2 (when hash-gate skips writes):
clearHashesForTestRow()

// Check source data freshness and destination header alignment:
checkSourceFreshness()
validateDestinationHeaders()

// Force full re-read of a single source (or use col H Force Reset checkbox in Post_Sentinel tab):
forceReprocessDispoSource("TCN_DISPO_1")
forceReprocessCallSource("TCN_CALLS_1")

// Force full re-read of ALL dispo or call sources at once:
forceReprocessAllDispoSources()
forceReprocessAllCallSources()

// Month-end reset — two steps:
clearAllProperties()                                      // 1. wipe state
createMonthlyAggSheet("Jul'26")                           // 2. create new month's sheet
createMonthlyAggSheet("Jun'26", "<existingSheetId>")      // 2b. or wire up a pre-created sheet
```

There is no automated test suite. `Pipeline_Robustness.js` is the primary correctness layer — run its validators after any config or schema change.

## Jupyter Notebooks (Manual Refresh Scripts)

### `Charges_Vintage.ipynb`

A **manual snapshot script** run from Jupyter whenever the bounce/penal charge vintage tables need refreshing in Google Sheets. Uses `psycopg2` to query the `onefindb` PostgreSQL database (via localhost tunnel on port 5001) and `gspread` to push results.

**Cell 2 — Outstanding Vintage** → pushes to `"CBC and Penal Charge Vintage-Apr'26"`
- Queries `loan_extracharge` joined with repayment/loan/lead tables
- Filters to rows where `charge_amount - amount_paid - waived_off > 0` (only rows with open outstanding)
- Charge types: **Bounce** (`charge_type = 2`) and **Penal** (`charge_type = 4`). Note: `charge_type = 36` (Bounce-Rep/Additional Representation, added Jun'26) is **not yet included** in these queries — update if it should be tracked here too.
- Groups by `partner_loan_id` + charge category, buckets into 5 vintage bands:
  - `0–3m`, `4–6m`, `7–12m`, `13–24m`, `24m+`
  - Two sets of bands: one by **EMI due date**, one by **charge created_at date**
- Pushes to tabs: `Due Vintage` and `Created Vintage`

**Cell 3 — Accrued & Paid Vintage** → pushes to `"CBC and Penal Charge Vintage-Apr'26-View 2"`
- Two separate queries on the same tables:
  - **Accrued** (`charge_amount - waived_off`): gross amount levied regardless of payment → `Accured Vintage_Due Wise` / `Accured Vintage_Created Wise`
  - **Paid** (`amount_paid`): only collected amounts → `Paid Vintage_Due Wise` / `Paid Vintage_Created Wise`
- Uses chunked uploads (40k rows/chunk) to avoid Sheets API timeouts (~270k accrued rows, ~170k paid rows)
- Timestamps written to `A1` on each sheet after upload

**When to run:** Manually, at month-end or on demand. Hardcoded vintage cutoff dates in the SQL must be updated each month.

---

## Key Constraints

- Google Apps Script hard execution limit is **6 minutes**; the sentinel self-relays at 25 min via `MAX_EXECUTION_TIME_MS` to stay safe across chained triggers.
- Custom script execution is restricted to an **allowlist** (`ALLOWED_SCRIPTS` in `New_Sync_Engine.js`) — do not execute arbitrary script names.
- Filter expressions use `createSafeFilter()` — only `COPY_ALL`, `COL_N` arithmetic, and `LOOKUP_DATE_MATCH` syntax are permitted; no `eval`.
- Spreadsheet IDs for Vintage views are hard-coded in `Vintage.js` (`VINTAGE_VIEW2_ID`, `VINTAGE_VIEW3_ID`, `VINTAGE_MASTER_ID`).
- Google Sheets has a **10M-cell limit per spreadsheet** — this is why dispo/call outputs use a fresh per-month sheet rather than accumulating in a single sheet.
