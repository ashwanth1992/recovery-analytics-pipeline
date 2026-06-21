/**
 * ==============================================================================
 * CONTROL CENTER — Backend (CC_Backend.gs)
 * ==============================================================================
 */

// ==============================================================================
// DATA FETCHING
// ==============================================================================

function ccSetArchiveMode(enabled) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty("ARCHIVE_MODE", enabled ? "true" : "false");
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccGetArchiveMode() {
  return PropertiesService.getScriptProperties()
    .getProperty("ARCHIVE_MODE") === "true";
}

function getControlCenterData() {
  try {
    if (PropertiesService.getScriptProperties().getProperty("ARCHIVE_MODE") === "true") {
      return { ok: true, stale: true, timestamp: Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss") };
    }

    const p   = PropertiesService.getScriptProperties();
    const now = Date.now();

    const sentinelRunning = p.getProperty("SENTINEL_RUNNING");
    const cbcRunning      = p.getProperty("CBC_DEDICATED_RUNNING");
    const relayRaw        = p.getProperty("ACTIVE_RELAY");
    const withinHours     = isWithinOperatingHours();

    // Post-sentinel engine states
    const ppPending    = p.getProperty("POST_PROCESS_PENDING") === "true";
    const ppStep       = parseInt(p.getProperty("POST_PROCESS_STEP") || "0");

    const dispoPending = p.getProperty("DISPO_AGG_PENDING") === "true";
    const dispoRunning = p.getProperty("DISPO_AGG_RUNNING") !== null;
    const dispoPhase   = parseInt(p.getProperty("DISPO_AGG_PHASE") || "0");

    // ── NEW: Call Agg states ─────────────────────────────────────────────────
    const callPending  = p.getProperty("CALL_AGG_PENDING") === "true";
    const callRunning  = p.getProperty("CALL_AGG_RUNNING") !== null;
    const callPhase    = parseInt(p.getProperty("CALL_AGG_PHASE") || "0");

    let activeRelay = null;
    if (relayRaw) {
      try { activeRelay = JSON.parse(relayRaw); } catch(e) {}
    }

    let runningMode      = null;
    let runningStartMs   = null;
    let sentinelPipeline = p.getProperty("SENTINEL_PIPELINE") || "1H";

    if (sentinelRunning) {
      const ms = parseInt(sentinelRunning);
      if (now - ms < 30 * 60 * 1000) { runningMode = "SENTINEL"; runningStartMs = ms; }
    } else if (cbcRunning) {
      const ms = parseInt(cbcRunning);
      if (now - ms < 30 * 60 * 1000) { runningMode = "CBC_DED"; runningStartMs = ms; }
    }

    const allJobs    = loadSystemConfig();
    const runHistory = _getRunHistory();
    const metrics    = _deriveMetrics(runHistory, allJobs);

    let currentJobStatus = null;
    if (runningMode) {
      currentJobStatus = _getCurrentJobStatus(allJobs, runningMode, runningStartMs, activeRelay, sentinelPipeline);
    }

    return {
      ok: true,
      withinHours,
      timestamp:        Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss"),
      runningMode,
      runningStartMs,
      sentinelPipeline,
      currentJobStatus,
      activeRelay,

      ppPending,
      ppStep,
      dispoPending,
      dispoRunning,
      dispoPhase,

      // ── NEW ─────────────────────────────────────────────────────────────────
      callPending,
      callRunning,
      callPhase,

      lastSelfHeal:     p.getProperty("LAST_SELF_HEAL") || "Never",
      jobs:             _formatJobs(allJobs),
      runHistory,
      metrics,

      pausedUntil: parseInt(p.getProperty("PIPELINE_PAUSED_UNTIL") || "0"),
      pausedAt:    parseInt(p.getProperty("PIPELINE_PAUSED_AT")    || "0")
    };
  } catch(e) {
    return { ok: false, error: e.message + "\n" + e.stack };
  }
}

function _getRunHistory() {
  try {
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName("Sentinel_Health");
    if (!sheet) return [];
    const lastRow = sheet.getLastRow();
    if (lastRow < 8) return [];
    const numRows = Math.min(50, lastRow - 7);
    return sheet.getRange(8, 1, numRows, 6).getValues()
      .map(r => ({
        timestamp: r[0] ? (r[0] instanceof Date
          ? Utilities.formatDate(r[0], GLOBAL_TZ, "dd/MM HH:mm:ss")
          : String(r[0]).trim()) : "",
        pipeline:  r[1] ? String(r[1]) : "-",
        duration:  r[2] ? String(r[2]) : "-",
        outcome:   r[3] ? String(r[3]) : "-",
        jobsDone:  r[4] !== "" ? String(r[4]) : "-",
        notes:     r[5] ? String(r[5]) : ""
      }))
      .filter(r => r.timestamp);
  } catch(e) { return []; }
}

function _deriveMetrics(history, allJobs) {
  const activeJobs  = allJobs.filter(j => !j.name.includes("[SKIP]")).length;
  const skippedJobs = allJobs.filter(j =>  j.name.includes("[SKIP]")).length;

  const lastRuns      = { "30M": null, "1H": null, "1D": null, "NIGHTLY": null, "CBC-DED": null, "PP": null, "DISPO": null, "CALL": null };
  const lastDurations = { "30M": null, "1H": null, "1D": null, "NIGHTLY": null, "CBC-DED": null, "PP": null, "DISPO": null, "CALL": null };
  for (const row of history) {
    const pipe = row.pipeline;
    if (lastRuns[pipe] === null && row.outcome.includes("✅")) {
      lastRuns[pipe] = row.timestamp; lastDurations[pipe] = row.duration;
    }
    if (Object.values(lastRuns).every(v => v !== null)) break;
  }

  let daysSinceError = "2+";
  for (const row of history) {
    if (row.outcome.includes("❌")) { daysSinceError = "0"; break; }
  }

  return { activeJobs, skippedJobs, lastRuns, lastDurations, daysSinceError };
}

function _formatJobs(allJobs) {
  return allJobs
    .filter(job => job.name && job.name !== "Job Name" && job.name.trim() !== "")
    .map(job => ({
      name:        job.name,
      displayName: job.displayName || job.name,
      schedule:    job.schedule || "-",
      configRow:   job.configRow,
      lastStatus:  job.lastStatus || "",
      isSkipped:   job.name.includes("[SKIP]"),
      isDedicated: (job.schedule || "").toUpperCase() === "DEDICATED",
      dstId:       job.dstId  || "",
      dstTab:      job.dstTab || ""
    }));
}

function _getCurrentJobStatus(allJobs, runningMode, runningStartMs, activeRelay, sentinelPipeline) {
  try {
    const tiers       = { "30M": 1, "1H": 2, "1D": 3, "NIGHTLY": 4 };
    const currentTier = tiers[sentinelPipeline] || 2;

    const relevant = runningMode === "CBC_DED"
      ? allJobs.filter(j => (j.schedule || "").toUpperCase() === "DEDICATED")
      : allJobs.filter(j => {
          if (j.name.includes("[SKIP]")) return false;
          if ((j.schedule || "").toUpperCase() === "DEDICATED") return false;
          const jobTier = tiers[(j.schedule || "1H").toUpperCase()] || 99;
          return jobTier <= currentTier;
        });

    const startDate = new Date(runningStartMs);
    const year      = startDate.getFullYear();

    let completedCount   = 0;
    let lastCompletedIdx = -1;

    for (let i = 0; i < relevant.length; i++) {
      const status = relevant[i].lastStatus || "";
      if (!status.includes("✅") && !status.includes("Join Complete") && !status.includes("Script Executed")) continue;
      const m = status.match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
      if (!m) continue;
      const jobTs = new Date(year, parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[3]), parseInt(m[4]), 0);
      if (jobTs >= startDate) { completedCount++; lastCompletedIdx = i; }
    }

    const currentJobIdx = Math.min(lastCompletedIdx + 1, relevant.length - 1);
    let executingName = null;
    for (const j of relevant) {
      if ((j.lastStatus || "").includes("⚙️")) { executingName = j.name; break; }
    }

    const currentJobName = (executingName
      ? (relevant.find(j => j.name === executingName) || {}).displayName || executingName
      : null)
      || (currentJobIdx >= 0 ? (relevant[currentJobIdx].displayName || relevant[currentJobIdx].name) : null)
      || (activeRelay ? activeRelay.id : "Starting...");

    return {
      totalJobs:     relevant.length,
      completedJobs: completedCount,
      currentJobIdx,
      currentJobName,
      elapsedMs:    Date.now() - runningStartMs,
      elapsedStr:   formatDuration(Date.now() - runningStartMs),
      jobStatuses:  relevant.map((j, i) => ({
        name:        j.name,
        displayName: j.displayName || j.name,
        status:      j.lastStatus || "",
        done:        i <= lastCompletedIdx,
        active:      i === currentJobIdx
      }))
    };
  } catch(e) {
    Logger.log("_getCurrentJobStatus error: " + e.message);
    return null;
  }
}

// ==============================================================================
// ACTIONS
// ==============================================================================

function ccTriggerManualRun() {
  try { triggerSentinel(); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
}

function ccToggleSkip(configRow, currentName) {
  try {
    const newName = currentName.includes("[SKIP]")
      ? currentName.replace(/\[SKIP\]\s*/i, "").trim()
      : "[SKIP] " + currentName;
    safeOpenById(CONTROL_CENTER_ID)
      .getSheetByName(CONTROL_TAB_NAME)
      .getRange(configRow, 1).setValue(newName);
    return { ok: true, newName };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccForceResetJob(configRow) {
  try {
    safeUpdate({ values: [[true]] }, CONTROL_CENTER_ID,
      `${CONTROL_TAB_NAME}!K${configRow}`, { valueInputOption: "USER_ENTERED" });
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccForceResetAll() {
  try {
    const jobs = loadSystemConfig();
    jobs.filter(j => !j.name.includes("[SKIP]")).forEach(job => {
      safeUpdate({ values: [[true]] }, CONTROL_CENTER_ID,
        `${CONTROL_TAB_NAME}!K${job.configRow}`, { valueInputOption: "USER_ENTERED" });
    });
    return { ok: true, count: jobs.length };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccReleaseLock() {
  try {
    selfHealStuckStates();
    const p = PropertiesService.getScriptProperties();
    p.deleteProperty("SENTINEL_RUNNING");
    p.deleteProperty("CBC_DEDICATED_RUNNING");
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccRunDedicatedNow() {
  try { runCBCPaymentsDedicated(); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
}

/** Queues post-processing immediately (outside normal schedule). */
function ccRunPostProcessing() {
  try {
    const p = PropertiesService.getScriptProperties();
    p.deleteProperty("POST_PROCESS_STEP");
    p.setProperty("POST_PROCESS_PENDING", "true");
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

/** Manually triggers a fresh Dispo Aggregation run. */
function ccRunDispoAgg() {
  try {
    const p = PropertiesService.getScriptProperties();
    ["DISPO_AGG_PENDING","DISPO_AGG_RUNNING","DISPO_AGG_PHASE","DISPO_AGG_READ_ROW","DISPO_AGG_START","DISPO_AGG_DONE"]
      .forEach(k => p.deleteProperty(k));
    p.setProperty("DISPO_AGG_PENDING", "true");
    p.setProperty("DISPO_AGG_PHASE",   "0");
    p.setProperty("DISPO_AGG_START",   Date.now().toString());
    // Pre-satisfy the fence so PP can fire after dispo alone if needed
    p.setProperty("CALL_AGG_DONE", "true");
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

/** Manually triggers a fresh Call Aggregation run. */
function ccRunCallAgg() {
  try {
    manualRunCallAgg(); // defined in Call_Agg.gs — resets state + fires triggerCallAggregation
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccRunSingleJob(configRow) {
  try {
    const allJobs = loadSystemConfig();
    const job     = allJobs.find(j => j.configRow === configRow);
    if (!job) return { ok: false, error: "Job not found in config (row " + configRow + ")" };

    const p               = PropertiesService.getScriptProperties();
    const sentinelRunning = p.getProperty("SENTINEL_RUNNING");

    if (sentinelRunning) {
      const age = Date.now() - parseInt(sentinelRunning);
      if (age < 28 * 60 * 1000) {
        const currentlyExecuting = allJobs.find(j =>
          (j.lastStatus || "").includes("⚙️") || (j.lastStatus || "").includes("Executing")
        );
        if (currentlyExecuting
          && currentlyExecuting.dstId  === job.dstId
          && currentlyExecuting.dstTab === job.dstTab) {
          return {
            ok: false,
            error: `Conflict: Sentinel is currently writing to "${job.dstTab}". Wait ~1-2 minutes and try again.`
          };
        }
        Logger.log(`⚠️ [MANUAL] Running "${job.name}" while Sentinel is active. Different destination — proceeding.`);
      }
    }

    const allKeys = p.getKeys();
    let resetCount = 0;
    for (const key of allKeys) {
      if (key.startsWith("H_" + job.name + "_") || key.startsWith("R_" + job.name) || key.startsWith("RD_" + job.name)) {
        p.deleteProperty(key);
        resetCount++;
      }
    }
    Logger.log(`🔄 [MANUAL] Cleared ${resetCount} cached properties for "${job.name}" before manual run.`);

    const start = Date.now();
    let success = false;

    if (job.srcId === "CUSTOM_SCRIPT") {
      if (typeof this[job.logic] === "function") {
        this[job.logic]();
        updateJobStatus(job.configRow, "✅ Script Executed (Manual)");
        success = true;
      } else {
        return { ok: false, error: "Custom script function not found: " + job.logic };
      }
    } else if (typeof JOB_RUNNERS !== "undefined" && JOB_RUNNERS[job.logic]) {
      success = JOB_RUNNERS[job.logic](job, start, "MANUAL");
    } else {
      success = runHybridSync(job, start, "MANUAL", 0);
    }

    const dur = formatDuration(Date.now() - start);
    return {
      ok:       true,
      success,
      duration: dur,
      message:  success
        ? `✅ "${job.name}" completed in ${dur}.`
        : `⏳ "${job.name}" relayed (too much data for one run). Re-run to continue.`
    };
  } catch(e) {
    Logger.log("ccRunSingleJob error: " + e.message + "\n" + e.stack);
    return { ok: false, error: e.message };
  }
}

function ccGetSheetUrl() {
  try {
    return { ok: true, url: "https://docs.google.com/spreadsheets/d/" + CONTROL_CENTER_ID + "/edit" };
  } catch(e) { return { ok: false, error: e.message }; }
}

function ccPausePipeline(hours) {
  try { pausePipeline(hours); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
}

function ccResumePipeline() {
  try { resumePipeline(); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
}