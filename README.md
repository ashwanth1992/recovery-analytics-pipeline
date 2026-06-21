# CBC & Penal Recovery Analytics Pipeline

A production-grade **Google Apps Script** data pipeline that automates the collection, deduplication, and aggregation of Collections (CBC) and Penal recovery data across multiple Google Sheets sources. Built with reliability and scale in mind — handles hundreds of thousands of rows per run inside the Apps Script runtime.

---

## What it does

- **Sync Engine** — Reads from N source sheets, filters/transforms rows, writes to destination sheets. Jobs are configured via a `Routing_Config` tab (no code changes needed to add/modify jobs).
- **Post-Sentinel Aggregation** — 6-phase disposition aggregation pipeline (PB + TCN sources → dedup → final destination), running on its own trigger after the main sync.
- **Vintage Analytics** — Executive dashboard with DPD tagging, waterfall allocation, and drilldown CSV export.
- **Pipeline Control Center** — Web app UI for monitoring trigger health, pausing/resuming the pipeline, and inspecting per-job status.

---

## Architecture

```
triggerSentinel()  [time-based, every 30 min]
    └── runMasterSync()         ← iterates all jobs from Routing_Config
            ├── runHybridSync() ← default: filter/copy rows between sheets
            └── JOB_RUNNERS[]  ← named runners: LOOKUP_JOIN, SUM_JOIN, PAYMENT_AGG, etc.
    └── _setPostSentinelFlag()
            ↓
triggerDispoAggregation()  [every 10 min]
    Phase 0–5: PB + TCN dispo read → dedup → write → 0bkt_input feed
            ↓
triggerPostProcessing()  [every 5 min]
    Post-processing stages 1 & 2
```

Key design decisions:
- **Relay system** — when a job approaches the 30-min execution wall, it checkpoints to Script Properties and resumes on the next trigger invocation.
- **MD5 block hashing** — each data block is hashed before writing; unchanged blocks are skipped entirely to avoid redundant API calls.
- **Exponential backoff** — all Sheets API calls wrapped in `withExponentialBackoff()` (4 retries, 5-min hard timeout).
- **Semaphore locking** — `SENTINEL_RUNNING` property prevents overlapping executions.

---

## File Overview

| File | Purpose |
|------|---------|
| `New_Sync_Engine.js` | Core engine: `triggerSentinel`, `runMasterSync`, `runHybridSync`, API wrappers, job router |
| `utils.js` | Shared utilities: data parsing, MD5 hashing, batch helpers, Sentinel health dashboard |
| `Post_Sentinel_1.js` | 6-phase Dispo aggregation (PB + TCN → dedup → destination) |
| `Post_Sentinel_2.js` | Post-processing stage 1 (call log aggregation + anomaly scan) |
| `Post_Sentinel_3.js` | Post-processing stage 2 |
| `Dashboard_Sheet_Calc.js` | Allocation engine V2 — team labels for base data + payments |
| `Master_Sheet_Calc.js` | Master sheet calculations |
| `Input_Sheet_Calcs.js` | Daily input sheet calculations |
| `Payment_Sheet_Calc.js` | Payment sheet calculations |
| `Pipeline_Robustness.js` | Config validation, freshness checks, heartbeat alerting |
| `Data_Export_daily.js` | Nightly CSV backup — API-driven zip export via email |
| `Setup_&_Tools.js` | Manual dev tools (trigger setup, diagnostics, pause/resume) — never called by triggers |
| `VV_Backend.js` | Web app `doGet()` router — serves Vintage Dashboard or Control Center |
| `CC_Backend.js` | Control Center backend |
| `Vintage.js` | Vintage analytics engine (DPD tagging, waterfall, View 2/3 generation) |
| `VintageViews.html` | Executive Vintage Analysis dashboard UI |
| `ControlCenter.html` | Pipeline Control Center UI |
| `appsscript.json` | Apps Script manifest (OAuth scopes, runtime, web app config) |

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) and [clasp](https://github.com/google/clasp) installed globally
- A Google account with Apps Script and Google Sheets API enabled

### Steps

1. **Clone the repo**
   ```bash
   git clone <repo-url>
   cd <repo-folder>
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

   Open `New_Sync_Engine.js` and set:
   ```js
   const CONTROL_CENTER_ID = "YOUR_CONTROL_CENTER_SHEET_ID";
   const FALLBACK_ALERT_EMAIL = "your-alert-email@example.com";
   ```

   Set the Vintage sheet IDs in `Vintage.js` and `VV_Backend.js` similarly.

5. **Push to Apps Script**
   ```bash
   clasp push
   ```

6. **Set up triggers** — run `setupTriggers()` once from the Apps Script editor (`Setup_&_Tools.js`), then deploy as a Web App via **Deploy > Manage Deployments**.

---

## Job Configuration

Jobs are defined as rows in a `Routing_Config` sheet tab. No code changes needed to add a new sync job — just add a row:

| Col | Field | Example |
|-----|-------|---------|
| A | Job Name | `CBC_Payments_to_Dash` |
| B | Source Sheet ID | `1abc...xyz` |
| C | Source Tab | `Payments` |
| D | Dest Sheet ID | `1def...uvw` |
| E | Dest Tab | `Dash_Input` |
| G | Filter Logic | `COL_1 == "Active"` or `COPY_ALL` |
| P | Schedule | `30M` / `1H` / `1D` / `NIGHTLY` |

Append `[SKIP]` to a job name to disable it without deleting the row.

---

## Developer Tools

Run manually from the Apps Script editor (never by triggers):

- `forceRunSentinel()` — force an immediate pipeline run
- `testSingleJob(rowNum)` — run a single job by its config row number
- `clearAllProperties()` — month-end state reset
- `runPreFlightCheck()` — validate Drive access for all configured sheet IDs
- `pausePipeline(hours)` / `resumePipeline()` — temporary halt
- `selfHealStuckStates()` — clear orphaned semaphores and stuck flags
- `exportProjectToDrive()` — zip all source files to Drive as a backup

---

## Tech Stack

- **Runtime:** Google Apps Script (V8), Google Sheets API v4
- **Deployment:** clasp CLI
- **State:** Script Properties (key-value store, no external DB)
- **Tooling:** MD5 hashing for change detection, exponential backoff for API reliability
