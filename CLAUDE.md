# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Google Apps Script** project for **FinanceOrg** — a CBC & Penal Recovery analytical data pipeline. It runs entirely inside Google Sheets/Apps Script and is deployed as a Web App. The project is managed via [clasp](https://github.com/google/clasp) (Google's CLI tool for Apps Script).

**Script ID:** `YOUR_SCRIPT_ID` (set in `.clasp.json`)  
**Control Center Sheet ID:** `YOUR_CONTROL_CENTER_SHEET_ID` (defined in `New_Sync_Engine.js`)  
**Runtime:** V8, timezone Asia/Kolkata

## Deployment Commands

```bash
# Push local files to Apps Script
clasp push

# Pull latest from Apps Script
clasp pull

# Open project in the browser editor
clasp open
```

Web app redeployment must be done manually from the Apps Script editor: **Deploy > Manage Deployments**.

## Architecture

### Execution Flow

```
triggerSentinel()  [time-based trigger, every 30 min]
    └── runMasterSync(scheduleMode)        ← iterates all jobs from Routing_Config
            ├── runHybridSync()            ← default: filter/copy rows between sheets
            └── JOB_RUNNERS[job.logic]()  ← named runners for typed jobs
                    ├── runLookupJoin()
                    ├── runSumJoin()
                    ├── runPaymentSummary()
                    ├── runBaseDataUpdate()
                    ├── runAllocationUpdate()
                    └── runDashCBCPaymentsCalculations()
    └── _setPostSentinelFlag()
            ↓
triggerDispoAggregation()  [every 10 min]   ← Post_Sentinel_1.js
    Phase 0: PB Dispo read
    Phase 1–3: TCN Dispo 1/2/3 read (phases 2–3 gated by day-of-month)
    Phase 4: Dedup + write to destination
    Phase 5: Filtered_Dispo → 0bkt_input
            ↓ sets POST_PROCESS_PENDING
triggerPostProcessing()  [every 5 min]      ← Post_Sentinel_2/3.js
```

`runCBCPaymentsDedicated()` fires on its own hourly trigger (:15 past) independently of the main Sentinel to avoid API quota contention.

### Pipeline Schedule Tiers

Each job row in `Routing_Config` has a schedule column (`30M`, `1H`, `1D`, `NIGHTLY`, `DEDICATED`). When Sentinel fires, it runs all jobs at or below the active tier. `DEDICATED` jobs never run inside the main pipeline.

### Relay System

When a job approaches the 30-min execution limit, it writes `ACTIVE_RELAY = {pipeline, id, timestamp, count}` to Script Properties and returns `false`. The next Sentinel invocation skips forward to that job and resumes. After 5 consecutive time-relays on the same job, it is marked fatal and an alert email is sent.

### Key Files

| File | Purpose |
|------|---------|
| `New_Sync_Engine.js` | Core: `triggerSentinel`, `runMasterSync`, `runHybridSync`, all API wrappers, `JOB_RUNNERS` router |
| `utils.js` | Shared utilities: data parsing, MD5 hashing, batch API helpers, Sentinel health dashboard |
| `Post_Sentinel_1.js` | 6-phase Dispo aggregation engine (PB + TCN sources → dedup → destination) |
| `Post_Sentinel_2.js` | Post-processing stage 1 |
| `Post_Sentinel_3.js` | Post-processing stage 2 |
| `Dashboard_Sheet_Calc.js` | Allocation engine V2 (team labels for base data + payments) |
| `Master_Sheet_Calc.js` | Master sheet calculations |
| `Input_Sheet_Calcs.js` | Input sheet / daily input calculations |
| `Payment_Sheet_Calc.js` | Payment sheet calculations |
| `Setup_&_Tools.js` | Manual dev tools, trigger setup, diagnostics, pause/resume — never called by triggers |
| `VV_Backend.js` | Web app `doGet()` router; serves `VintageViews.html` or `ControlCenter.html` |
| `CC_Backend.js` | Control Center web app backend |
| `Vintage.js` | Vintage analytics logic |

### Job Configuration (Routing_Config tab)

Each row defines one sync job. Key columns:

| Col | Field | Notes |
|-----|-------|-------|
| A | Job Name | Append `[SKIP]` to disable |
| B | Source ID | Spreadsheet ID, or `CUSTOM_SCRIPT` |
| C | Source Tab | Sheet tab name |
| D | Dest ID | Target spreadsheet ID |
| E | Dest Tab | Target tab name |
| F | Refresh Cycle | Int — how many runs before a full re-sync |
| G | Logic Condition | See filter/calc syntax below |
| H | Source Cols | 1-based, comma-separated |
| I | Dest Cols | 1-based, comma-separated |
| K | Force Reset | Checkbox — nukes all hashes and restarts job from row 2 |
| L–N | Lookup ID / Tab / Key Col | Required when logic uses `IS_IN_LOOKUP` or `LOOKUP_DATE_MATCH` |
| P | Schedule | `30M` / `1H` / `1D` / `NIGHTLY` / `DEDICATED` |
| T | Write Start Row | Override default row 2 for destination writes |

### State Management (Script Properties)

All pipeline state is stored in Script Properties (no database):

- `SENTINEL_RUNNING` — semaphore timestamp; always deleted in `finally`
- `ACTIVE_RELAY` — JSON resume pointer `{pipeline, id, timestamp, count}`
- `LAST_RUN_1H`, `LAST_RUN_1D`, etc. — dedup timestamps per schedule tier
- `H_<jobName>_B<blockIdx>` — MD5 hash per data block; unchanged blocks are skipped
- `L_<jobName>_B<blockIdx>` — row count per block (used to advance write pointer on skip)
- `POST_PROCESS_PENDING` — fence flag between sync engine and post-processor
- `DISPO_AGG_PENDING`, `DISPO_AGG_PHASE`, `DISPO_AGG_READ_ROW` — dispo aggregation progress

## Filter / Calc Logic Syntax (col G)

```
COPY_ALL                              — copies every source row
COL_1 == "Active"                     — JS expression; COL_N references 1-based column
IS_IN_LOOKUP(COL_1)                   — row's key exists in the configured lookup map
LOOKUP_DATE_MATCH(COL_1, COL_4)       — key in lookup AND date >= lookup date
CALC:COL_3 + COL_5                    — math formula; result written to the extra dest col
CALC:FORMAT_DATE(COL_6)               — converts timestamp to Sheets serial date (IST)
```

Named job types routed via `JOB_RUNNERS`: `LOOKUP_JOIN`, `SUM_JOIN`, `PAYMENT_AGG`, `BASE_DATA_UPDATE`, `ALLOCATION_CALC`, `DASH_CBC_PAYMENTS_CALC`.

## Developer Tools (Setup_&_Tools.js)

Run manually from the Apps Script editor — never invoked by triggers:

- `forceRunSentinel()` — wipes last-run timestamps and fires Sentinel immediately
- `testSingleJob()` — runs one job by row number (set target row in Control Center cell Q2)
- `clearAllProperties()` — month-end protocol: wipes all script state
- `runPreFlightCheck()` — validates Drive access for all configured sheet IDs
- `pausePipeline(hours)` / `resumePipeline()` — temporarily halt the pipeline
- `manualDispoTimeMachine()` — rewind dispo aggregation to a specific phase (0–5)
- `exportProjectToDrive()` — zips all source files to Drive as a timestamped backup
- `selfHealStuckStates()` — clears orphaned semaphores, stuck relay flags, and fence deadlocks

## Constraints

- **Execution limit:** 30 min per trigger invocation (Apps Script hard limit). All inner loops check against `MAX_EXECUTION_TIME_MS - 120s` and relay before hitting the wall.
- **Operating hours:** 08:00–22:59 IST on normal days; 24/7 on the first 3 and last 2 days of the month; active relays always continue regardless of hours.
- **Batch sizing:** `getOptimalBatchSize()` targets ~250K cells/batch for normal tabs; ~50K for heavy tabs (`2. Penal Inputs`, `0bkt_input`, `2. PENAL DATA`, `4. Daily_Inputs`).
- **API calls:** All Sheets API calls go through `withExponentialBackoff()` (4 retries, 5-min hard timeout). Batch writes use `safeBatchUpdate()`; clears use `safeClear()` with grid-limit guard.
- **Security:** Filter logic strings are validated against a safe-character regex before `new Function()` eval. Only function names listed in `ALLOWED_SCRIPTS` can execute as `CUSTOM_SCRIPT` jobs.

## UI/UX & Design Guidelines
- Adopt a professional, clean **"Fintech Minimalist"** or **"Bento Grid"** framework for layout components.
- Avoid neon/gradient-heavy styles. Use clean container definitions, explicit borders, and soft box-shadow tokens.
- Keep all styling inside inline `<style>` blocks within the HTML files — required for the Google Apps Script container environment.
