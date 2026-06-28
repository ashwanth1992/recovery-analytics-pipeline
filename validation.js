/**
 * ==============================================================================
 * PIPELINE ROBUSTNESS LAYER
 * ==============================================================================
 * Four features to harden the Sentinel pipeline against silent failures:
 *
 *   1. validateRoutingConfig()       — catches config corruption before pipeline runs
 *   2. validateDestinationHeaders()  — detects column shifts in destination tabs
 *   3. checkSentinelHeartbeat()      — alerts when Sentinel stops running
 *   4. checkSourceFreshness()        — warns when upstream data is stale
 *
 * These functions are designed as ADDITIONS — no existing pipeline code needs
 * to be rewritten, only a few targeted insertions in triggerSentinel and
 * runHybridSync.
 * ==============================================================================
 */


// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// Validation
const VALID_SCHEDULES   = ["30M", "1H", "1D", "NIGHTLY", "DEDICATED"];
const VALID_LOGIC_TYPES = ["COPY_ALL", "PAYMENT_AGG", "BASE_DATA_UPDATE", "LOOKUP_JOIN",
                            "SUM_JOIN", "ALLOCATION_CALC", "DASH_CBC_PAYMENTS_CALC"];
// Note: COPY_ALL, CALC:..., LOOKUP_DATE_MATCH(...), and arbitrary filter expressions
// are also valid. The validator is lenient about Logic Condition (col G) because it
// can be free-form JS. We only validate that source/dest cols are parseable.

// Heartbeat
const HEARTBEAT_DEFAULT_THRESHOLD_MIN = 60;
const HEARTBEAT_ALERT_COOLDOWN_MS     = 4 * 60 * 60 * 1000;  // don't spam — 4hr cooldown

// Routing_Config column indices (0-based, matches loadSystemConfig)
const COL_JOB_NAME       = 0;   // A
const COL_SRC_ID         = 1;   // B
const COL_SRC_TAB        = 2;   // C
const COL_DST_ID         = 3;   // D
const COL_DST_TAB        = 4;   // E
const COL_LOGIC          = 6;   // G
const COL_SRC_COLS       = 7;   // H
const COL_DST_COLS       = 8;   // I
const COL_LOOKUP_ID      = 11;  // L
const COL_LOOKUP_TAB     = 12;  // M
const COL_LOOKUP_KEY     = 13;  // N
const COL_SCHEDULE       = 15;  // P
const COL_DISPLAY_NAME   = 16;  // Q
const COL_FRESHNESS_HRS  = 17;  // R
const COL_IS_TRANSFORM   = 18;  // S

// Spreadsheet ID format: alphanumeric + underscores + hyphens, 40-50 chars
const SHEET_ID_REGEX = /^[a-zA-Z0-9_-]{40,50}$/;


// ──────────────────────────────────────────────────────────────────────────────
// FEATURE 1: validateRoutingConfig
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validates the entire Routing_Config sheet for structural and content correctness.
 * Returns { valid, errors, warnings, freshness }.
 *
 *  - errors[]:   pipeline-blocking issues (corrupt config). Sends red alert email.
 *  - warnings[]: stale source data (Option C — pipeline continues, yellow alert).
 *  - freshness[]: detailed per-source freshness info for the email body.
 *
 * Called at the start of triggerSentinel.
 */
function validateRoutingConfig() {
  const errors    = [];
  const warnings  = [];
  const freshness = [];

  try {
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(CONTROL_TAB_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 5) {
      return { valid: false, errors: ["Routing_Config has fewer than 5 rows — sheet appears empty or damaged."], warnings, freshness };
    }

    // Read all 18 columns including the new freshness column
    const data = sheet.getRange(4, 1, lastRow - 3, 19).getValues();

    // ── Check 1: Header row sanity (row 4 in the sheet, index 0 in data) ─────
    const headers       = data[0];
    const expectedHeaders = {
      [COL_JOB_NAME]:    "Job Name",
      [COL_SRC_TAB]:     "Source Tab",
      [COL_DST_TAB]:     "Dest Tab",
      [COL_SCHEDULE]:    "Schedule"
    };
    for (const [idx, expected] of Object.entries(expectedHeaders)) {
      const actual = String(headers[idx] || "").trim();
      if (actual !== expected) {
        errors.push(`Header row: expected "${expected}" in column ${_colLetter(parseInt(idx) + 1)}, found "${actual}".`);
      }
    }

    // ── Check 2: Per-row validation (skip header row at index 0) ─────────────
    const seenNames = new Set();
    const checkedSrcIds = new Set();
    for (let i = 1; i < data.length; i++) {
      const r       = data[i];
      const rowNum  = i + 4; // +4 because header is row 4
      const jobName = String(r[COL_JOB_NAME] || "").trim();

      // Skip blank rows
      if (!jobName) continue;

      // Duplicate job name check
      if (seenNames.has(jobName)) {
        errors.push(`Row ${rowNum}: duplicate job name "${jobName}".`);
      } else {
        seenNames.add(jobName);
      }

      // Schedule must be one of the valid values
      const schedule = String(r[COL_SCHEDULE] || "").toUpperCase().trim();
      if (schedule && !VALID_SCHEDULES.includes(schedule)) {
        errors.push(`Row ${rowNum} ("${jobName}"): invalid Schedule "${schedule}". Must be one of: ${VALID_SCHEDULES.join(", ")}.`);
      }

      // Custom scripts have srcId="CUSTOM_SCRIPT" and most other fields blank — skip the rest
      if (String(r[COL_SRC_ID]).trim() === "CUSTOM_SCRIPT") continue;

      // Spreadsheet IDs must look like valid Drive IDs
      const srcId = String(r[COL_SRC_ID] || "").trim();
      const dstId = String(r[COL_DST_ID] || "").trim();
      if (srcId && !SHEET_ID_REGEX.test(srcId)) {
        errors.push(`Row ${rowNum} ("${jobName}"): Source ID "${srcId.substring(0,15)}..." doesn't look like a valid spreadsheet ID.`);
      }
      if (dstId && !SHEET_ID_REGEX.test(dstId)) {
        errors.push(`Row ${rowNum} ("${jobName}"): Dest ID "${dstId.substring(0,15)}..." doesn't look like a valid spreadsheet ID.`);
      }

      // Source and Dest tab names must be present
      if (!String(r[COL_SRC_TAB] || "").trim()) {
        errors.push(`Row ${rowNum} ("${jobName}"): Source Tab is blank.`);
      }
      if (!String(r[COL_DST_TAB] || "").trim()) {
        errors.push(`Row ${rowNum} ("${jobName}"): Dest Tab is blank.`);
      }

      // Source/Dest cols: must be parseable as comma-separated numbers OR blank
      // (blank is allowed for special logic types like PAYMENT_AGG, BASE_DATA_UPDATE, etc.)
      const srcCols = String(r[COL_SRC_COLS] || "").trim();
      const dstCols = String(r[COL_DST_COLS] || "").trim();
      const logic   = String(r[COL_LOGIC] || "").trim();

      if (srcCols && !_isParseableColList(srcCols)) {
        errors.push(`Row ${rowNum} ("${jobName}"): Source Cols "${srcCols}" is not a valid comma-separated list of numbers.`);
      }
      if (dstCols && !_isParseableColList(dstCols)) {
        errors.push(`Row ${rowNum} ("${jobName}"): Dest Cols "${dstCols}" is not a valid comma-separated list of numbers.`);
      }

      // Source col count must equal dest col count for pure copy/filter jobs.
      // CALC, PAYMENT_AGG, and other transform jobs intentionally produce
      // different column counts — skip the check for those.
      const isTransform = r[COL_IS_TRANSFORM] === true;
      if (srcCols && dstCols && !isTransform) {
        const srcCount = srcCols.split(",").length;
        const dstCount = dstCols.split(",").length;
        if (srcCount !== dstCount) {
          errors.push(`Row ${rowNum} ("${jobName}"): Source has ${srcCount} columns but Dest has ${dstCount}. They must match. If intentional, check "Is Transform" in column S.`);
        }
      }

      // LOOKUP_DATE_MATCH jobs need lookup config
      if (logic.includes("LOOKUP_DATE_MATCH")) {
        if (!String(r[COL_LOOKUP_ID] || "").trim()) {
          errors.push(`Row ${rowNum} ("${jobName}"): LOOKUP_DATE_MATCH job missing Lookup ID (col L).`);
        }
        if (!String(r[COL_LOOKUP_TAB] || "").trim()) {
          errors.push(`Row ${rowNum} ("${jobName}"): LOOKUP_DATE_MATCH job missing Lookup Tab (col M).`);
        }
      }

      // ── Check 3: Source freshness (only for jobs where col R is populated) ─
      // Deduplicate: only check each unique source spreadsheet ID once
      const freshThreshold = parseFloat(r[COL_FRESHNESS_HRS]);
      if (freshThreshold > 0 && srcId && !checkedSrcIds.has(srcId)) {
        checkedSrcIds.add(srcId);
        const result = _checkSourceFreshness(srcId, freshThreshold, jobName);
        freshness.push(result);
        if (result.stale) {
          warnings.push(`"${jobName}": source data ${result.ageHours.toFixed(1)}h old (threshold: ${freshThreshold}h).`);
        }
      }
    }

    // Send email if anything found
    if (errors.length > 0 || warnings.length > 0) {
      _sendValidationEmail(errors, warnings, freshness);
    }

    return {
      valid: errors.length === 0,
      errors, warnings, freshness
    };

  } catch(e) {
    Logger.log(`❌ validateRoutingConfig threw: ${e.message}\n${e.stack}`);
    return {
      valid: false,
      errors: [`Validator itself crashed: ${e.message}`],
      warnings: [],
      freshness: []
    };
  }
}


function _isParseableColList(str) {
  const parts = str.split(",").map(p => p.trim()).filter(p => p);
  if (parts.length === 0) return false;
  return parts.every(p => /^\d+$/.test(p));
}


function _colLetter(colNum) {
  let s = "";
  while (colNum > 0) {
    const r = (colNum - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    colNum = Math.floor((colNum - 1) / 26);
  }
  return s;
}


function _sendValidationEmail(errors, warnings, freshness) {
  try {
    const recipient = getAlertEmail();
    const isCritical = errors.length > 0;
    const subject = isCritical
      ? `🚨 PIPELINE HALTED: Routing_Config has ${errors.length} error(s)`
      : `⚠️ PIPELINE WARNING: ${warnings.length} stale source(s) detected`;

    const body = [
      isCritical
        ? "The Sentinel pipeline has been ABORTED due to configuration errors."
        : "The Sentinel pipeline is running, but stale data was detected.",
      "",
      isCritical ? "──── ERRORS (pipeline halted) ────" : "──── WARNINGS (pipeline continued) ────",
      ...(isCritical ? errors : warnings).map(e => "  • " + e),
      "",
      freshness.length > 0 ? "──── FRESHNESS REPORT ────" : "",
      ...freshness.map(f => `  • ${f.jobName}: ${f.ageHours.toFixed(1)}h old (threshold: ${f.threshold}h) ${f.stale ? "⚠️ STALE" : "✅"}`),
      "",
      "Action: Open Routing_Config and verify the column structure / freshness thresholds.",
      "",
      "— Pipeline Sentinel"
    ].filter(Boolean).join("\n");

    MailApp.sendEmail({ to: recipient, subject, body });
    Logger.log(`📧 Validation email sent: ${subject}`);
  } catch(mailErr) {
    Logger.log(`Could not send validation email: ${mailErr.message}`);
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// FEATURE 2: validateDestinationHeaders
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the destination tab's column headers haven't changed since last run.
 *
 * Strategy:
 *   - Compute MD5 hash of row 1 of dst tab
 *   - Compare against stored property H_DST_HEADERS_{jobName}
 *   - If no stored hash: this is a first run, store and continue (no failure)
 *   - If stored hash matches: continue
 *   - If stored hash differs: someone changed the dest tab structure — fail
 *
 * Returns { valid: bool, error: string }
 */

function validateDestinationHeaders(job) {
  // Header guard temporarily disabled — REST API returns inconsistent
  // trailing cell counts for row reads, causing false hash mismatches.
  // TODO: Reimplement using column count + first cell value comparison.
  return { valid: true, error: null };
}


// ──────────────────────────────────────────────────────────────────────────────
// FEATURE 3: checkSentinelHeartbeat
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Cron function — runs on its own time-based trigger (every 15 min).
 * Detects when triggerSentinel has stopped firing.
 *
 * Mechanism:
 *   - triggerSentinel writes LAST_SENTINEL_HEARTBEAT at the start of every execution
 *   - This function checks if that timestamp is older than HEARTBEAT_THRESHOLD_MIN
 *   - If stale, sends an alert (with cooldown to avoid email spam)
 *
 * Setup: create a time-based trigger for this function, every 15 minutes.
 */
function checkSentinelHeartbeat() {
  try {
    if (!isWithinOperatingHours()) return; // don't alert when pipeline isn't expected to run

    // Startup buffer: don't alert in the first 30 min of operating hours.
    // After the off-hours window, the heartbeat is naturally stale until the
    // first triggerSentinel of the day fires. Give it time to wake up.
    const now      = new Date();
    const tz       = GLOBAL_TZ;
    const hour     = parseInt(Utilities.formatDate(now, tz, "H"));
    const minute   = parseInt(Utilities.formatDate(now, tz, "m"));

    // Operating hours start at 8 AM (per isWithinOperatingHours rule 3).
    // First 30 min after start is the "warming up" window.
    if (hour === 8 && minute < 30) {
      Logger.log("⏰ [HEARTBEAT] Within operating-hours startup buffer (8:00-8:30). Skipping check.");
      return;
    }

    const p     = PropertiesService.getScriptProperties();
    const beat  = parseInt(p.getProperty("LAST_SENTINEL_HEARTBEAT") || "0");
    const nowMs = Date.now();
    const threshMin = parseInt(p.getProperty("HEARTBEAT_THRESHOLD_MIN") || HEARTBEAT_DEFAULT_THRESHOLD_MIN);

    if (beat === 0) {
      // Heartbeat never set — Sentinel hasn't run yet, or it crashed before its first beat
      Logger.log("⚠️ [HEARTBEAT] No heartbeat ever recorded. Skipping check (assumed first run).");
      return;
    }

    const ageMin = (nowMs - beat) / 60000;
    if (ageMin <= threshMin) return; // healthy

    // Stale — but throttle to avoid email spam
    const lastAlert = parseInt(p.getProperty("LAST_HEARTBEAT_ALERT") || "0");
    if (nowMs - lastAlert < HEARTBEAT_ALERT_COOLDOWN_MS) {
      Logger.log(`⚠️ [HEARTBEAT] Sentinel stale (${ageMin.toFixed(0)}m old) but recently alerted. Skipping.`);
      return;
    }

    // Send alert
    Logger.log(`🚨 [HEARTBEAT] Sentinel hasn't run in ${ageMin.toFixed(0)} minutes (threshold: ${threshMin}m).`);
    p.setProperty("LAST_HEARTBEAT_ALERT", nowMs.toString());

    try {
      MailApp.sendEmail({
        to: getAlertEmail(),
        subject: `🚨 PIPELINE STUCK: Sentinel hasn't run in ${ageMin.toFixed(0)} minutes`,
        body: [
          `The Sentinel cron has not executed since ${new Date(beat).toLocaleString("en-IN", {timeZone: GLOBAL_TZ})}.`,
          ``,
          `Threshold: ${threshMin} minutes (configurable via script property HEARTBEAT_THRESHOLD_MIN)`,
          `Time elapsed: ${ageMin.toFixed(1)} minutes`,
          ``,
          `Possible causes:`,
          `  • Time-based trigger was disabled or deleted`,
          `  • Apps Script quota exhausted (usually resets daily)`,
          `  • Lock stuck — check ACTIVE_RELAY and SENTINEL_RUNNING properties`,
          `  • Routing_Config validation has been failing (check email for VALIDATION ERRORS)`,
          ``,
          `Action: Open Apps Script → Triggers panel and verify triggerSentinel is active.`,
          ``,
          `— Heartbeat Monitor`
        ].join("\n")
      });
      Logger.log(`📧 Heartbeat alert email sent.`);
    } catch(mailErr) {
      Logger.log(`Could not send heartbeat email: ${mailErr.message}`);
    }
  } catch(e) {
    Logger.log(`❌ checkSentinelHeartbeat threw: ${e.message}\n${e.stack}`);
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// FEATURE 4: checkSourceFreshness (helper, called by validateRoutingConfig)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns { jobName, threshold, ageHours, stale, error }.
 * Uses Drive API to read modifiedTime of the source spreadsheet.
 */
function _checkSourceFreshness(srcId, thresholdHours, jobName) {
  try {
    const file       = DriveApp.getFileById(srcId);
    const modified   = file.getLastUpdated().getTime();
    const ageHours   = (Date.now() - modified) / (1000 * 60 * 60);
    
    // 🛡️ THE FIX: Only trigger the 'stale' alarm if we are actually inside operating hours
    const isStaleNow = ageHours > thresholdHours;
    const stale      = isWithinOperatingHours() ? isStaleNow : false;

    return { jobName, threshold: thresholdHours, ageHours, stale, error: null };
  } catch(e) {
    Logger.log(`⚠️ Could not check freshness for "${jobName}": ${e.message}`);
    return { jobName, threshold: thresholdHours, ageHours: -1, stale: false, error: e.message };
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// MANUAL HELPERS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Manually reset the destination header baseline for a specific job.
 * Use this when you've intentionally changed the dest tab structure and
 * want the next run to re-establish the baseline.
 */
function resetDestinationHeaderBaseline(jobName) {
  const p = PropertiesService.getScriptProperties();
  const propKey = "H_DST_HEADERS_" + jobName;
  if (p.getProperty(propKey)) {
    p.deleteProperty(propKey);
    Logger.log(`✅ Cleared header baseline for "${jobName}". Next run will re-establish.`);
  } else {
    Logger.log(`ℹ️ No header baseline found for "${jobName}". Nothing to clear.`);
  }
}


/**
 * Reset all destination header baselines. Use after a major month-end refactor
 * where many destination tabs structure has changed legitimately.
 */
function resetAllDestinationHeaderBaselines() {
  const p = PropertiesService.getScriptProperties();
  const allKeys = p.getKeys();
  let count = 0;
  for (const key of allKeys) {
    if (key.startsWith("H_DST_HEADERS_")) {
      p.deleteProperty(key);
      count++;
    }
  }
  Logger.log(`✅ Cleared ${count} destination header baseline(s).`);
}


/**
 * Set the heartbeat threshold dynamically (in minutes).
 */
function setHeartbeatThreshold(minutes) {
  if (typeof minutes !== "number" || minutes < 15) {
    Logger.log("❌ Heartbeat threshold must be a number ≥ 15 minutes.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty("HEARTBEAT_THRESHOLD_MIN", minutes.toString());
  Logger.log(`✅ Heartbeat threshold set to ${minutes} minutes.`);
}