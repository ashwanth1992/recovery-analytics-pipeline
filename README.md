# CBC & Penal Recovery Analytics Pipeline

A production-grade **Google Apps Script** data pipeline that automates the collection, deduplication, and aggregation of Collections (CBC) and Penal recovery data across multiple Google Sheets sources. Built to handle hundreds of thousands of rows per run within the Apps Script 6-minute execution limit using a relay/resume architecture.

---

## What it does

- **Sync Engine** — Reads from N source sheets, filters/transforms rows, writes to destination sheets. Jobs are configured via a `Routing_Config` tab — no code changes needed to add or modify jobs.
- **Dispo Aggregation** — Reads N active TCN dispo sources (configured in `Post_Sentinel` tab), filters to allocated leads after their allocation date, deduplicates within a 15-minute window, and writes to the monthly agg sheet.
- **Call Log Aggregation** — Reads N active call sources (Ozonetel + TCN, configured in `Post_Sentinel` tab), filters by alloc date, appends to the monthly agg sheet, then runs a cross-source anomaly scan.
- **Post-Processing** — Writes penal metrics (attempts, answered, talk time, last call date, best/last dispo) back to the base data sheet after both aggregation engines complete.
- **Vintage Analytics** — Executive dashboard with DPD tagging, waterfall allocation across View 2 → View 3, and drilldown CSV export.
- **Pipeline Control Center** — Web app UI for monitoring trigger health, pausing/resuming the pipeline, and inspecting per-job status.

---

## Architecture

```
triggerSentinel()  [1-hour cron]
    └── runMasterSync()         ← iterates all jobs from Routing_Config
            ├── runHybridSync() ← default: filter/copy/transform rows between sheets
            └── dedicated runners: LOOKUP_JOIN, SUM_JOIN, PAYMENT_AGG, etc.
    └── sets DISPO_AGG_PENDING + CALL_AGG_PENDING
            ↓                           ↓
triggerDispoAggregation()      triggerCallAggregation()
[every 10 min]                 [every 5 min]
  For each active               For each active
  Dispo_Merge source:           Call_Merge source:
    ├── filter to alloc leads     ├── OZO sources → Ozonetel schema
    ├── append to Dispo_Temp      ├── TCN sources → TCN schema
    └── dedup + write to          └── append to Combined_Call_Logs
        Combined_Dispo_Logs           in monthly agg sheet
        in monthly agg sheet      └── anomaly scan (cross-source overlap)
            ↓                           ↓
        sets DISPO_AGG_DONE     sets CALL_AGG_DONE
                    ↘         ↙
              Two-flag fence
              (both must be done)
                    ↓
        triggerPostProcessing()  [every 5 min]
            Writes penal metrics → base data sheet (cols U:Z)
```

Key design decisions:

- **Relay system** — when a job approaches the execution time limit, it checkpoints to Script Properties and resumes on the next trigger invocation. Resume state for aggregation engines is stored as the config key of the current source (e.g. `TCN_DISPO_2`), not a hardcoded phase number.
- **Two-flag fence** — post-processing fires only when both `DISPO_AGG_DONE` and `CALL_AGG_DONE` are set, ensuring merged data from both engines is available before metrics are calculated.
- **Dynamic source config** — adding or removing a dispo/call source requires only a row change in the `Post_Sentinel` tab. No code change needed.
- **Monthly agg sheet** — all dispo and call outputs accumulate in a dedicated per-month Google Sheet (e.g. `"FinanceOrg Agg — Jun'26"`), avoiding the 10M-cell Sheets limit. Created via `createMonthlyAggSheet()` at month start.
- **MD5 block hashing** — each data block is hashed before writing; unchanged blocks are skipped to avoid redundant API calls.
- **Exponential backoff** — all Sheets API calls wrapped in `withExponentialBackoff()` (max ~5 min of retries).
- **Semaphore locking** — `SENTINEL_RUNNING`, `DISPO_AGG_RUNNING`, `CALL_AGG_RUNNING` prevent overlapping executions.

---

## Dispo Aggregation Logic

Handled by `Post_Sentinel_1.js`. Runs in two stages per trigger invocation:

**Stage 1 — Per-source read (one source per trigger if time runs out):**
- Loads all active `Dispo_Merge` rows from the `Post_Sentinel` config tab (excluding `DESTINATION`)
- Builds an allocation map: `leadId → allocDateMs` from the `PB_Dispo_Filteration` Routing_Config row
- For each source, reads rows in adaptive chunks, filters to allocated leads whose call timestamp is on/after their allocation date, appends to `Dispo_Temp` (intermediate scratch tab in the Control Center sheet)
- All active sources use the TCN column schema (`mx_collection_lead_id`, `cld_created_on`/`created_at`, `pb_calling_status`, `tcn_agent_first_name`, `tcn_process_name`)

**Stage 2 — Dedup + write:**
- Reads all rows from `Dispo_Temp` into RAM, groups by lead ID, sorts by timestamp
- Applies a 15-minute window dedup:
  - **Rule 1**: Same outcome from PB + TCN → TCN wins
  - **Rule 2a**: TCN only, no PB in window → keep silently
  - **Rule 2b**: PB only, no TCN in window → keep, log to `Dispo_Audit`
  - **Rule 3**: Same-source duplicates in window → keep the later timestamp
  - **Rule 4**: Conflicting outcomes (PB + TCN, different results) → keep both, log to `Dispo_Audit`
- Writes clean output to `Combined_Dispo_Logs` in the monthly agg sheet
- Writes anomalies (Rule 2b, Rule 4) to the `Dispo_Audit` tab

Output schema (6 cols): `mx_collection_lead_id | pb_calling_status | call_dialled_on | agent_name | campaign_name | source`

---

## Call Log Aggregation Logic

Handled by `Post_Sentinel_2.js`. Runs sources sequentially, with anomaly scan as the final phase:

**Per-source read:**
- Sources with keys starting with `OZO` use the **Ozonetel schema**: `uui` (lead ID), `call_date` + `start_time` (combined into one timestamp), `talk_time` (HH:MM:SS). A smart date window rejects rows older than 90 days or more than 7 days in the future, alerting if >5% of rows fail.
- All other sources use the **TCN schema**: `loan_id`, `call_time`, `talk_duration` (integer seconds).
- Both schemas filter to the same allocation map and append directly to `Combined_Call_Logs` in the monthly agg sheet.

**Anomaly scan (final phase):**
- Reads the full `Combined_Call_Logs` tab, groups by lead ID
- Flags any OZO + TCN call pair for the same lead within a 15-minute window
- Writes flagged pairs to the `Call_Audit` tab in the monthly agg sheet

Output schema (7 cols): `lead_id | phone_number | call_timestamp | talk_duration_sec | source | agent_name | campaign_name`

---

## Monthly Aggregation Sheet

Each month has its own Google Sheet with 5 tabs:

| Tab | Purpose |
|-----|---------|
| `Dispo_Cache` | Intermediate filtered rows during dispo aggregation |
| `Dispo_Audit` | Per-run dedup anomaly log (Rule 2b + Rule 4) |
| `Combined_Dispo_Logs` | Final deduped dispo output |
| `Combined_Call_Logs` | Aggregated call log from all sources |
| `Call_Audit` | Cross-source overlap anomalies |

The sheet ID is read at runtime from the `DESTINATION` config row in the `Post_Sentinel` tab — it survives `clearAllProperties()`.

---

## Post_Sentinel Source Configuration

All aggregation sources are configured in the `Post_Sentinel` tab of the Control Center spreadsheet (8 columns: `Function | Config Key | Sheet ID | Tab Name | Date Range | Active | Notes | Force Reset`):

| Function | Reserved keys | Source keys |
|----------|--------------|------------|
| `Dispo_Merge` | `DESTINATION` | `TCN_DISPO_1`, `TCN_DISPO_2`, … |
| `Call_Merge` | `CALL_DESTINATION`, `CALL_AUDIT` | `OZO_*` (Ozonetel schema), `TCN_CALLS_1`, … |
| `Post_Processing` | `PP_STEP_1`, `PP_STEP_2`, `PP_STEP_3` | — |

- **Date Range** (e.g. `11-20`): gates a source to only be active from that day of the month onward. Leave blank for always-active.
- **Force Reset checkbox** (col H): tick a row and run `manualRunDispoAgg()` / `manualRunCallAgg()` to clear that source's checkpoint and reprocess from row 1. The checkbox auto-clears after reset.

---

## File Overview

| File | Purpose |
|------|---------|
| `New_Sync_Engine.js` | Core engine: `triggerSentinel`, `runMasterSync`, `runHybridSync`, job router, relay/resume, semaphores |
| `utils.js` | Shared utilities: data parsing, MD5 hashing, batch helpers, exponential backoff |
| `Post_Sentinel_1.js` | Dispo aggregation: dynamic N-source read → `Dispo_Temp` → 15-min window dedup → `Combined_Dispo_Logs` |
| `Post_Sentinel_2.js` | Call log aggregation: dynamic N-source read (OZO + TCN schemas) → `Combined_Call_Logs` → anomaly scan |
| `Post_Sentinel_3.js` | Post-processing: reads merged dispo + call logs, writes penal metrics to base data sheet |
| `Dashboard_Sheet_Calc.js` | Allocation engine — team labels for base data + payments |
| `Master_Sheet_Calc.js` | `COPY_ALL`, `CALC:`, `LOOKUP_JOIN`, `SUM_JOIN` job types |
| `Input_Sheet_Calcs.js` | `BASE_DATA_UPDATE` job type (RAM-map conditional updates) |
| `Payment_Sheet_Calc.js` | `PAYMENT_AGG` job type — aggregates raw payments into Collection_Summary |
| `Pipeline_Robustness.js` | Config validation, source freshness checks, destination header alignment, heartbeat alerting |
| `Data_Export_daily.js` | Nightly CSV backup — API-driven zip export via email |
| `Setup_&_Tools.js` | Manual dev tools (trigger setup, diagnostics, month-end reset) — never called by triggers |
| `VV_Backend.js` | Web app `doGet()` router — serves Vintage Dashboard or Control Center |
| `CC_Backend.js` | Control Center backend (state, job status, run history) |
| `Vintage.js` | Vintage analytics engine (DPD tagging, waterfall allocation, View 2/3 generation) |
| `VintageViews.html` | Executive Vintage Analysis dashboard UI |
| `ControlCenter.html` | Pipeline Control Center monitoring UI |
| `appsscript.json` | Apps Script manifest (OAuth scopes, V8 runtime, web app config) |

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) and [clasp](https://github.com/google/clasp) installed globally
- A Google account with Apps Script and Google Sheets API enabled

### Steps

1. **Clone the repo**
   ```bash
   git clone <repo-url>
   cd recovery-analytics-pipeline
   ```

2. **Log in with clasp**
   ```bash
   clasp login
   ```

3. **Create a new Apps Script project** (or link to an existing one)
   ```bash
   clasp create --type sheets --title "Recovery Pipeline"
   # This creates .clasp.json with your Script ID
   ```

4. **Configure your spreadsheet IDs**

   In `New_Sync_Engine.js`:
   ```js
   const CONTROL_CENTER_ID   = "YOUR_CONTROL_CENTER_SHEET_ID";
   const FALLBACK_ALERT_EMAIL = "your-email@example.com";
   ```

   In `Vintage.js` and `VV_Backend.js`:
   ```js
   const VINTAGE_VIEW2_ID  = "YOUR_VINTAGE_VIEW2_SHEET_ID";
   const VINTAGE_VIEW3_ID  = "YOUR_VINTAGE_VIEW3_SHEET_ID";
   const VINTAGE_MASTER_ID = "YOUR_VINTAGE_MASTER_SHEET_ID";
   ```

   In `Data_Export_daily.js`, update the `spreadsheetId` in `SHEETS_TO_EXPORT`.

5. **Push to Apps Script**
   ```bash
   clasp push
   ```

6. **Set up triggers** — run `setupTriggers()` once from the Apps Script editor (`Setup_&_Tools.js`), then deploy as a Web App via **Deploy > Manage Deployments**.

7. **Set up Post_Sentinel tab** — run `setupPostSentinelTab()` once, then fill in Sheet IDs and check the `Active` checkbox for each source.

8. **Create the first monthly agg sheet** — run `createMonthlyAggSheet("Mon'YY")` from the editor. This creates the 5 tabs and wires all `Post_Sentinel` config rows to point to the new sheet.

---

## Job Configuration (Routing_Config)

Jobs are defined as rows in the `Routing_Config` sheet tab. No code changes needed to add a new sync job:

| Col | Field | Example |
|-----|-------|---------|
| A | Job Name | `CBC_Payments_to_Dash` |
| B | Source Sheet ID | `1abc...xyz` |
| C | Source Tab | `Payments` |
| D | Dest Sheet ID | `1def...uvw` |
| E | Dest Tab | `Dash_Input` |
| G | Filter Logic | `COL_1 == "Active"` or `COPY_ALL` |
| P | Schedule | `1H` / `1D` / `NIGHTLY` / `DEDICATED` |

Append `[SKIP]` to a job name to disable it without deleting the row.

---

## Month-End Workflow

```javascript
// Step 1 — wipe all PropertiesService state (checkpoints, semaphores, hashes)
clearAllProperties()

// Step 2 — create a fresh sheet for the new month and wire up all Post_Sentinel config rows
createMonthlyAggSheet("Jul'26")

// Step 2b — or wire up a pre-created sheet by passing its ID
createMonthlyAggSheet("Jul'26", "YOUR_MONTHLY_AGG_SHEET_ID")
```

---

## Developer Tools

Run manually from the Apps Script editor (never by triggers):

- `forceRunSentinel()` — force an immediate pipeline run (clears all time-block stamps)
- `testSingleJob()` — run a single job by setting its row number in cell Q2 of the Control Center sheet
- `clearHashesForTestRow()` — purge write hashes for the job in Q2 (forces a re-write even if data is unchanged)
- `clearAllProperties()` — month-end state reset (wipe all checkpoints, semaphores, hashes)
- `validateRoutingConfig()` — validate all Routing_Config rows before deploying changes
- `selfHealStuckStates()` — clear orphaned semaphores and detect deadlocks
- `checkSourceFreshness()` / `validateDestinationHeaders()` — data quality checks
- `forceReprocessDispoSource("TCN_DISPO_1")` — force full re-read of one dispo source
- `forceReprocessAllDispoSources()` / `forceReprocessAllCallSources()` — force full re-read of all sources
- `pausePipeline(hours)` / `resumePipeline()` — temporary halt
- `manualRunDispoAgg()` / `manualRunCallAgg()` — manually trigger aggregation engines

---

## Tech Stack

- **Runtime:** Google Apps Script (V8), Google Sheets API v4
- **Deployment:** clasp CLI
- **State:** Script Properties (key-value store, no external DB)
- **Scheduling:** Time-based triggers (1H Sentinel, 10-min Dispo Agg, 5-min Call Agg + Post-Processing)
- **Tooling:** MD5 hashing for change detection, exponential backoff for API reliability, adaptive batch sizing
