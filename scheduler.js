/**
 * ==============================================================================
 * PROJECT: FinanceOrg - CBC & Penal Recovery Analytical Pipeline
 * VERSION: 6.0 (Decoupled Enterprise Edition)
 * OWNER: Strategy Manager (Collections)
 * ==============================================================================
 */

// ⚡ USER CONFIGURATION
const CONTROL_CENTER_ID = "YOUR_CONTROL_CENTER_SHEET_ID";
const CONTROL_TAB_NAME = "Routing_Config";
const MAX_EXECUTION_TIME_MS = 25 * 60 * 1000; 

// 🛡️ SECURITY CONFIGURATION
const ALLOWED_SCRIPTS = ["sendCombinedSheetsCsvZip"];

// 🌍 GLOBAL CONSTANTS
const GLOBAL_TZ = Session.getScriptTimeZone();

// ✅ FIX: Evaluate at call time, not parse time. If deployment mode changes
// (e.g., USER_DEPLOYING → USER_ACCESSING), getActiveUser() can return empty,
// and we want the fallback to kick in at that moment.
const FALLBACK_ALERT_EMAIL = "your-email@example.com";

function getAlertEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email || FALLBACK_ALERT_EMAIL;
  } catch (e) {
    return FALLBACK_ALERT_EMAIL;
  }
}

// ==========================================
// 🗺️ JOB TYPE ROUTER
// ==========================================
const JOB_RUNNERS = {
  "LOOKUP_JOIN": (job, start, scheduleMode) => runLookupJoin(job, start, scheduleMode),
  "SUM_JOIN":    (job, start, scheduleMode) => runSumJoin(job, start, scheduleMode),
  "PAYMENT_AGG": (job, start, scheduleMode) => runPaymentSummary(job, start, scheduleMode),
  "BASE_DATA_UPDATE":   (job, start, scheduleMode) => runBaseDataUpdate(job, start, scheduleMode),
  "ALLOCATION_CALC": (job, start, mode) => runAllocationUpdate(job, start, mode),
  "DASH_CBC_PAYMENTS_CALC": (job, start, mode) => runDashCBCPaymentsCalculations(job, start, mode)
};

// ==========================================
// 🗄️ GLOBAL SPREADSHEET CACHE
// ==========================================
const _ssCache = {};
function safeOpenById(id) {
  if (_ssCache[id]) return _ssCache[id];
  
  const startOpen = Date.now();
  _ssCache[id] = withExponentialBackoff(() => {
    if (Date.now() - startOpen > 60000)
      throw new Error("OpenTimeout: Sheet took too long.");
    return SpreadsheetApp.openById(id);
  });
  return _ssCache[id];
}

/**
 * ==============================================================================
 * PART 1: THE SENTINEL (Scheduler & Resume Logic)
 * ==============================================================================
 */

function triggerSentinel() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("⏭️ [SENTINEL] Another instance is already running. Skipping this wake-up.");
    return;
  }

  const p = PropertiesService.getScriptProperties();
  const runStartMs = Date.now();
  let pipelineLogged = "-";
  let jobsDone = 0;
  let outcome = "💤 No jobs due";

  // SECONDARY GUARD: stale semaphore detection
  const runningPid = p.getProperty("SENTINEL_RUNNING");
  const nowMs = runStartMs;

  if (runningPid) {
    const startedAt = parseInt(runningPid);
    const runningForMs = nowMs - startedAt;

    if (runningForMs < 28 * 60 * 1000) {
      Logger.log(`⏭️ [SENTINEL] Long-running instance active (started ${Math.round(runningForMs / 60000)}m ago). Skipping.`);
      lock.releaseLock();
      return;
    } else {
      Logger.log(`⚠️ [SENTINEL] Stale semaphore detected (${Math.round(runningForMs / 60000)}m old). Clearing and proceeding.`);
    }
  }

try {
    // Heartbeat: record that Sentinel just woke up

    p.setProperty("LAST_SENTINEL_HEARTBEAT", nowMs.toString());

// ⏸️ PAUSE CHECK
const pausedUntil = parseInt(p.getProperty("PIPELINE_PAUSED_UNTIL") || "0");
if (pausedUntil > nowMs) {
  const remaining = Math.round((pausedUntil - nowMs) / 60000);
  Logger.log(`⏸️ Pipeline paused. ${remaining} mins remaining.`);
  updateSentinelDashboard(`⏸️ Paused — resumes in ${remaining} mins`);
  outcome = `⏸️ Paused (${remaining}m remaining)`;
  const pausedAt = parseInt(p.getProperty("PIPELINE_PAUSED_AT") || "0");
  if (pausedAt > 0 && (nowMs - pausedAt) > (2 * 60 * 60 * 1000)) {
    if (!p.getProperty("PAUSE_ALERT_SENT")) {
      MailApp.sendEmail({
        to: Session.getActiveUser().getEmail(),
        subject: "⏸️ FinanceOrg Pipeline — Paused for over 2 hours",
        body: `The CBC & Penal Recovery Pipeline has been paused since ${new Date(pausedAt).toLocaleString()}.\n\nPlease resume manually from the Control Center.`
      });
      p.setProperty("PAUSE_ALERT_SENT", "true");
      Logger.log("📧 Pause alert email sent.");
    }
  }
  return;
}

// Validation gate: check Routing_Config integrity...
const validation = validateRoutingConfig();

    if (!validation.valid) {
      Logger.log(`🚨 [SENTINEL] Routing_Config validation FAILED. Pipeline aborted.`);
      validation.errors.forEach(e => Logger.log("   • " + e));
      outcome = "🚨 Aborted: config invalid";
      return; // skip pipeline work
    }
    if (validation.warnings.length > 0) {
      Logger.log(`⚠️ [SENTINEL] ${validation.warnings.length} freshness warning(s). Pipeline continuing.`);
      validation.warnings.forEach(w => Logger.log("   • " + w));
    }

    p.setProperty("SENTINEL_RUNNING", nowMs.toString());

    const tz = GLOBAL_TZ;
    const now = new Date();
    const hour1 = parseInt(Utilities.formatDate(now, tz, "H"));
    const min = parseInt(Utilities.formatDate(now, tz, "m"));

    // NIGHTLY RESET
    if (hour1 === 23 && min >= 30) {
      cleanupRelays();
      updateSentinelDashboard("💤 Nightly Reset Complete");
      outcome = "💤 Nightly Reset";
      return;
    }

    Logger.log(`👁️ [SENTINEL] Woke up. Checking Time-Blocks...`);

    const relayRaw = p.getProperty("ACTIVE_RELAY");
    let relay = null;
    if (relayRaw) {
      try { relay = JSON.parse(relayRaw); }
      catch(e) {
        Logger.log('[SENTINEL] Corrupt relay: ' + e.message);
        p.deleteProperty("ACTIVE_RELAY");
      }
    }

    // --- RULE 3: Starting a relay ---
    if (relay && relay.pipeline && relay.id) {
      pipelineLogged = relay.pipeline;
      Logger.log(`🏃 [SENTINEL] Triggerless Relay active for "${relay.id}" (Try #${relay.count || 0}). Resuming ${relay.pipeline}...`);
      updateSentinelDashboard(`⏳ Starting relay at job: ${relay.id}`);
      const completed = runMasterSync(relay.pipeline, "triggerSentinel");

      if (completed) {
        p.deleteProperty("ACTIVE_RELAY");

        const current1D_stamp = Utilities.formatDate(now, tz, "yyyy-MM-dd");
        const current1H_stamp = Utilities.formatDate(now, tz, "yyyy-MM-dd-HH");
        const minVal_stamp = parseInt(Utilities.formatDate(now, tz, "mm"));
        const current30M_stamp = current1H_stamp + (minVal_stamp < 30 ? "-A" : "-B");

        if (relay.pipeline === "1D") p.setProperty("LAST_RUN_1D", current1D_stamp);
        if (relay.pipeline === "1H") p.setProperty("LAST_RUN_1H", current1H_stamp);
        if (relay.pipeline === "30M") p.setProperty("LAST_RUN_30M", current30M_stamp);
        if (relay.pipeline === "NIGHTLY") p.setProperty("LAST_RUN_NIGHT", current1D_stamp);

        updateSentinelDashboard("✅ Execution complete for all jobs");
        outcome = "✅ Relay completed";
        jobsDone = parseInt(p.getProperty("LAST_RUN_JOB_COUNT") || "0");
      } else {
        const updatedRelayRaw = p.getProperty("ACTIVE_RELAY");
        if (updatedRelayRaw) {
          const updatedRelay = JSON.parse(updatedRelayRaw);
          updateSentinelDashboard(`⏳ Relay set at job: ${updatedRelay.id} and will resume in the next run`);
          outcome = `⏳ Paused at ${updatedRelay.id}`;
        }
      }
      return;
    }

    const current1D = Utilities.formatDate(now, tz, "yyyy-MM-dd");
    const current1H = Utilities.formatDate(now, tz, "yyyy-MM-dd-HH");
    const minVal = parseInt(Utilities.formatDate(now, tz, "mm"));
    const current30M = current1H + (minVal < 30 ? "-A" : "-B");

    const lastNight = p.getProperty("LAST_RUN_NIGHT");
    const last1D = p.getProperty("LAST_RUN_1D");
    const last1H = p.getProperty("LAST_RUN_1H");
    const last30M = p.getProperty("LAST_RUN_30M");

    const handleSync = (pipeline, desc, stateKey, value) => {
    pipelineLogged = pipeline;
    p.setProperty("SENTINEL_PIPELINE", pipeline); // ✅ Track active tier
    updateSentinelDashboard(`🚀 Starting ${desc} pipeline...`);
    
    const completed = runMasterSync(pipeline, "triggerSentinel");

      if (completed) {
        p.setProperty(stateKey, value);
        p.deleteProperty("ACTIVE_RELAY");
        updateSentinelDashboard("✅ Execution complete");
        outcome = "✅ Full run complete";
        jobsDone = parseInt(p.getProperty("LAST_RUN_JOB_COUNT") || "0");
      } else {
        const newRelayRaw = p.getProperty("ACTIVE_RELAY");
        if (newRelayRaw) {
          const newRelay = JSON.parse(newRelayRaw);
          updateSentinelDashboard(`⏳ Relay set at job: ${newRelay.id} and will resume in the next run`);
          outcome = `⏳ Paused at ${newRelay.id}`;
        }
      }
    };

    if (current1D !== lastNight && hour1 === 21) {
      handleSync("NIGHTLY", "NIGHTLY", "LAST_RUN_NIGHT", current1D);
      return;
    }
    if (current1D !== last1D && hour1 >= 8) {
      handleSync("1D", "1D", "LAST_RUN_1D", current1D);
      return;
    }
    if (current1H !== last1H) {
      handleSync("1H", "1 hour", "LAST_RUN_1H", current1H);
      return;
    }
    if (current30M !== last30M) {
      handleSync("30M", "30m", "LAST_RUN_30M", current30M);
      return;
    }

    updateSentinelDashboard("💤 No jobs due and sleeping");

  } finally {
    p.deleteProperty("SENTINEL_RUNNING");
    p.deleteProperty("SENTINEL_PIPELINE");
    lock.releaseLock();

    // ✅ Phase 2: Log this run to the health dashboard
    try {
      const durationMs = Date.now() - runStartMs;
      // Only log runs that actually did something (skip the "no jobs due" pings)
      if (outcome !== "💤 No jobs due" || durationMs > 10000) {
        logSentinelRun(pipelineLogged, durationMs, outcome, jobsDone, "");
      }
      updateSentinelHealthState();
    } catch (e) {
      Logger.log("Phase 2 logging failed (non-fatal): " + e.message);
    }
  }
}

/**
 * ==============================================================================
 * PART 2: ORCHESTRATOR (V6.0 - Removed Analytics Bloat)
 * ==============================================================================
 */

function runMasterSync(scheduleMode, triggerFuncName) {
  if (!isWithinOperatingHours()) return false; 
  const start = Date.now();
  const failedJobs = [];

  try {
    const allJobs = loadSystemConfig();
    const tiers = { "30M": 1, "1H": 2, "1D": 3, "NIGHTLY": 4, "DEDICATED": 5 };
    const jobs = allJobs.filter(j => {
      if (scheduleMode === "MANUAL") return true;
      // DEDICATED mode means a single job is being run by its own trigger
      // — it should NEVER match the main pipeline's tier filter.
      if (scheduleMode === "DEDICATED") return false;
      const jobTier = tiers[j.schedule] || 99;
      const currentTier = tiers[scheduleMode] || 99;
      return jobTier <= currentTier;
    });
    if (jobs.length === 0) {
      PropertiesService.getScriptProperties().setProperty("LAST_RUN_JOB_COUNT", "0");
      return true;
    }
    let _sentinelJobsCompleted = 0;
    const _jobTimings = {}; // { configRow: durationString }

    const p = PropertiesService.getScriptProperties();
    let relay = null;
    try { 
      const storedRelay = p.getProperty("ACTIVE_RELAY");
      if (storedRelay) {
        relay = JSON.parse(storedRelay); 
      }
    } 
    catch(e) {
      Logger.log(`⚠️ [CRITICAL WARNING] Corrupted ACTIVE_RELAY detected. Wiping memory to prevent infinite loops. Error: ${e.message}`);
      p.deleteProperty("ACTIVE_RELAY");
      relay = null; 
    }
    
    let isSkipping = (relay && relay.pipeline === scheduleMode) ? true : false;
    let currentRelayCount = (relay && relay.count) ? parseInt(relay.count) : 0;

    for (let job of jobs) {

      if (job.name && job.name.includes("[SKIP]")) {
        updateJobStatus(job.configRow, "⚠️ Skipped (User Request)");
        continue;
      }

      if (isSkipping) {
        if (job.name === relay.id) { isSkipping = false; } 
        else { continue; }
      }

      if (currentRelayCount >= 3 && relay && job.name === relay.id) {
        Logger.log(`🚨 [FATAL] Job "${job.name}" exhausted 3 retries. Downgrading to Fatal Error.`);
        updateJobStatus(job.configRow, "❌ Error: API Exhausted (3 Strikes)");
        failedJobs.push({ name: job.name, message: "Exhausted 3 retries due to timeouts or API limits." });
        p.deleteProperty("ACTIVE_RELAY");
        continue; 
      }

    if (Date.now() - start > (MAX_EXECUTION_TIME_MS - 90000)) {
        // ✅ Phase 2: Track a "soft strike" for time relays. If the same job
        // relays for time 5 times in a row, something is structurally wrong
        // (e.g., data size exceeds the 30-min window consistently) and we
        // should alert rather than loop forever.
        const softStrikeCount = (relay && relay.id === job.name)
          ? (parseInt(relay.count) || 0) + 1
          : 1;

        if (softStrikeCount >= 5) {
          Logger.log(`🚨 [STRUCTURAL] Job "${job.name}" exceeded 5 time-relays. This job is too large for the 30-min window.`);
          updateJobStatus(job.configRow, "❌ Error: Exceeds 30-min window (5x)");
          failedJobs.push({
            name: job.name,
            message: `Job consistently exceeds 30-minute execution window after 5 time-relay attempts. Data volume likely too large — consider sharding or optimizing.`
          });
          p.deleteProperty("ACTIVE_RELAY");
          continue;
        }

        p.setProperty("ACTIVE_RELAY", JSON.stringify({
          pipeline: scheduleMode, id: job.name, timestamp: Date.now(),
          count: softStrikeCount
        }));
        updateJobStatus(job.configRow, `⏳ Waiting for relay trigger (soft-strike ${softStrikeCount}/5)`);
        updateSentinelDashboard(`⏳ Paused for Relay: ${job.name} (Time Limit, ${softStrikeCount}/5)`);
        return false;
      }

      updateJobStatus(job.configRow, "⚙️ Executing...");

try {
        if (job.srcId === "CUSTOM_SCRIPT") {
          if (ALLOWED_SCRIPTS.includes(job.logic) && typeof this[job.logic] === "function") {
            const _jobStart = Date.now();
            this[job.logic]();
            updateJobStatus(job.configRow, "✅ Script Executed");
            _sentinelJobsCompleted++;
            _jobTimings[job.configRow] = formatDuration(Date.now() - _jobStart);
          }
        } else {
          // ✅ ROUTER: Named job types go to their dedicated runner.
          // Everything else (COPY_ALL, filter logic, etc.) falls back to runHybridSync.
          const _jobStart = Date.now();
          let success;
          if (JOB_RUNNERS[job.logic]) {
            success = JOB_RUNNERS[job.logic](job, start, scheduleMode);
          } else {
            success = runHybridSync(job, start, scheduleMode, currentRelayCount);
          }
          if (!success) return false;
          _sentinelJobsCompleted++;
          _jobTimings[job.configRow] = formatDuration(Date.now() - _jobStart);
        }
      } catch (e) {
        const errMsg = e.message.toLowerCase();
        
// ✅ Phase 2: Added 'INTERNAL' and 'unexpected error' classifications.
        // Google sometimes crashes with code INTERNAL — this is their infra,
        // not our code, so we should relay and retry, not fail fatally.
        const isTransient = errMsg.includes("simultaneous invocations") ||
                            errMsg.includes("exhausted") ||
                            errMsg.includes("timed out") ||
                            errMsg.includes("timeout") ||
                            errMsg.includes("internal error") ||
                            errMsg.includes("internal") ||
                            errMsg.includes("unexpected error") ||
                            errMsg.includes("javascript engine") ||
                            errMsg.includes("rate limit") ||
                            errMsg.includes("service unavailable") ||
                            errMsg.includes("backend error");

        if (isTransient) {
          Logger.log(`⏳ [TRANSIENT ERROR] Google API is busy (${e.message}). Resting for 10 mins...`);
          p.setProperty("ACTIVE_RELAY", JSON.stringify({
            pipeline: scheduleMode, id: job.name, timestamp: Date.now(),
            count: currentRelayCount + 1 // Kept +1 so true API hangs eventually die
          }));
          updateJobStatus(job.configRow, "⏳ Paused (Google API Busy)");
          updateSentinelDashboard(`⏳ Paused for Relay: ${job.name} (API Busy)`);
          return false; 
        } 
        else {
          Logger.log(`❌ [FATAL ERROR] Job "${job.name}": ${e.message}`);
          updateJobStatus(job.configRow, `❌ Error: ${e.message}`);
          failedJobs.push({ name: job.name, message: e.message });
          p.deleteProperty("ACTIVE_RELAY");
        }
      }
    }

    // 🚨 FATAL ERROR ALARM SYSTEM
if (failedJobs.length > 0) {
      Logger.log("⚠️ Fatal errors detected. Aborting Post-Processing to protect data integrity.");

      // ✅ Phase 2: Rich diagnostic email
      const errBody = failedJobs.map(f => `❌ ${f.name}: ${f.message}`).join("\n\n");
      const p = PropertiesService.getScriptProperties();
      const relayRaw = p.getProperty("ACTIVE_RELAY");
      const relayInfo = relayRaw ? `Active Relay: ${relayRaw}` : "Active Relay: (none)";
      const durationMs = Date.now() - start;
      const durationStr = formatDuration(durationMs);
      const recentLogs = getRecentLogTail(30);

      const fullBody = [
        `The Sentinel encountered fatal errors during the ${scheduleMode} run.`,
        ``,
        `RUN DURATION: ${durationStr}`,
        `FAILED JOB COUNT: ${failedJobs.length}`,
        relayInfo,
        ``,
        `---- FAILED JOBS ----`,
        errBody,
        ``,
        `---- LAST 30 LOG ENTRIES ----`,
        recentLogs,
        ``,
        `Check the Sentinel_Health tab in your Control Center for context.`
      ].join("\n");

      try {
        MailApp.sendEmail({
          to: getAlertEmail(),
          subject: `🚨 WE-RIZE PIPELINE ALERT: ${failedJobs.length} Job(s) Failed (${scheduleMode})`,
          body: fullBody
        });
      } catch (mailErr) {
        Logger.log("Could not send alert email: " + mailErr);
      }
    }
    // ✅ NEW: Trigger analytics only if everything was perfect
    else {
      Logger.log("✅ Sync complete. Marking for post-processing");
      _setPostSentinelFlag(scheduleMode, p);
    }
    
    // ✅ Save job count so Sentinel can log it to Sentinel_Health
    PropertiesService.getScriptProperties().setProperty(
      "LAST_RUN_JOB_COUNT",
      _sentinelJobsCompleted.toString()
    );

    // ✅ Batch write per-job durations into the status column
    // One sheet open + N setValue calls at the very end — not per-job overhead
    if (Object.keys(_jobTimings).length > 0) {
      try {
        const _ccSheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(CONTROL_TAB_NAME);
        Object.entries(_jobTimings).forEach(([row, dur]) => {
          const cell     = _ccSheet.getRange(parseInt(row), 10); // Col J = Last Run Status
          const existing = String(cell.getValue() || '');
          // Only append if duration not already there and status looks current
          if (existing && !existing.includes('(')) {
            cell.setValue(existing + ' (' + dur + ')');
          }
        });
        Logger.log(`⏱️ Wrote job timings for ${Object.keys(_jobTimings).length} jobs.`);
      } catch(e) {
        Logger.log('Could not write job timings (non-fatal): ' + e.message);
      }
    }

    cleanupRelays();
    return true;

  } catch (e) {
    Logger.log("MasterSync fatal error: " + e.stack);
    return false;
  }
}

/**
 * ==============================================================================
 * PART 3: SYNC ENGINE (V6.1 - Smart Calc & Guardrails)
 * ==============================================================================
 */
function runHybridSync(job, startTime, scheduleMode, relayCount) {

  // ── HEADER GUARD ───────────────────────────────────────────
  const headerCheck = validateDestinationHeaders(job);
  if (!headerCheck.valid) {
    throw new Error(`Header guard: ${headerCheck.error}`);
  }

  const props = PropertiesService.getScriptProperties();
  const stateKeys = { run: `R_${job.name}`, read: `RD_${job.name}`, write: `WR_${job.name}` };
  
if (job.forceReset) {
    // 1. Delete the row tracking states
    props.deleteProperty(stateKeys.read); 
    props.deleteProperty(stateKeys.write);
    
    // 2. 🧨 THE NUKE: Delete every single hash associated with this job
    const allKeys = props.getKeys();
    let deletedHashes = 0;
    for (let key of allKeys) {
      if (key.startsWith(`H_${job.name}_`)) {
        props.deleteProperty(key);
        deletedHashes++;
      }
    }
    Logger.log(`🧨 HARD RESET: Cleared row states and purged ${deletedHashes} hashes for ${job.name}.`);

    // 3. Uncheck the "Force Reset" box in the Control Center
    safeUpdate({values: [[false]]}, CONTROL_CENTER_ID, `${CONTROL_TAB_NAME}!K${job.configRow}`, {valueInputOption: "USER_ENTERED"});
  }

// --- 🛰️ SURGICAL LOOKUP UPGRADE (With Error Guard) ---
  let lookupMap = null;
  
  // Detect if this job is trying to use a Lookup based on the logic string
  const requiresLookup = job.logic && job.logic.includes("LOOKUP");

  if (job.lookupId && job.lookupTab && job.lookupKeyCol !== null) {
    const buildStart = Date.now();
    Logger.log(`🔍 [${job.name}] Building Surgical Lookup Map...`);
    
const lSheet = safeOpenById(job.lookupId).getSheetByName(job.lookupTab);
    if (lSheet) {
      // ✅ FIX: Use getLastRow() instead of getMaxRows() — getMaxRows includes
      // all empty grid rows (often 1M+), which can cause safeGet to return
      // sparse/empty responses that crash keys[i][0] dereferences.
      const lastDataRow = lSheet.getLastRow();
      const targetCol = job.lookupKeyCol + 1;
      const dateCol = job.lookupDateCol !== null ? job.lookupDateCol + 1 : null;

      // ✅ FIX: Guard against empty sheets entirely.
      if (lastDataRow < 2) {
        Logger.log(`⚠️ [${job.name}] Lookup tab "${job.lookupTab}" has no data rows. Skipping job.`);
        updateJobStatus(job.configRow, "⚠️ Skipped (Lookup Empty)");
        return true;
      }

      let keys = safeGet(job.lookupId, `${job.lookupTab}!${columnToLetter(targetCol)}1:${columnToLetter(targetCol)}${lastDataRow}`);
      let dates = dateCol ? safeGet(job.lookupId, `${job.lookupTab}!${columnToLetter(dateCol)}1:${columnToLetter(dateCol)}${lastDataRow}`) : null;

      // ✅ FIX: Defensive guards for every possible safeGet pathology.
      // safeGet can return: undefined, [], [[]], or truncated arrays.
      if (!keys || !Array.isArray(keys) || keys.length === 0) {
        Logger.log(`⚠️ [${job.name}] Lookup returned empty keys array for "${job.lookupTab}". Skipping job.`);
        updateJobStatus(job.configRow, "⚠️ Skipped (Empty Lookup Response)");
        return true;
      }
      if (dateCol && (!dates || !Array.isArray(dates))) {
        Logger.log(`⚠️ [${job.name}] Lookup returned empty dates array for "${job.lookupTab}". Skipping job.`);
        updateJobStatus(job.configRow, "⚠️ Skipped (Empty Dates Response)");
        return true;
      }

      // ✅ FIX: Safe scan for actual last row, guarding each row access.
      let actualLastRow = 0;
      for (let i = keys.length - 1; i >= 0; i--) {
        const row = keys[i];
        // Row might be undefined, empty array, or have a blank first cell
        if (row && row.length > 0 && row[0] !== "" && row[0] !== null && row[0] !== undefined) {
          actualLastRow = i + 1;
          break;
        }
      }

      if (actualLastRow === 0) {
        Logger.log(`⚠️ [${job.name}] No non-empty keys found in lookup column. Skipping job.`);
        updateJobStatus(job.configRow, "⚠️ Skipped (All Keys Empty)");
        return true;
      }

      keys = keys.slice(0, actualLastRow);
      if (dates) dates = dates.slice(0, actualLastRow);

      lookupMap = new Map();
      for (let i = 0; i < actualLastRow; i++) {
        // ✅ FIX: Guard each row access during map build.
        const keyRow = keys[i];
        if (!keyRow || keyRow.length === 0) continue;

        const k = cleanId(keyRow[0]);
        if (!k) continue;

        let val = true;
        if (dates) {
          const dateRow = dates[i];
          val = (dateRow && dateRow.length > 0) ? dateRow[0] : "";
        }
        lookupMap.set(k, val);
      }
      Logger.log(`✅ [${job.name}] Map built in ${Math.round((Date.now() - buildStart)/1000)}s (${lookupMap.size} keys).`);
    } else {
      // Error: Sheet ID is valid but Tab name is wrong
      const errorMsg = `❌ Error: Tab "${job.lookupTab}" not found in Lookup Sheet.`;
      Logger.log(`[${job.name}] ${errorMsg}`);
      updateJobStatus(job.configRow, errorMsg);
      return true; // Skip this job and move to next
    }
    
  } else if (requiresLookup) {
    // --- 🚨 NEW ERROR GUARD ---
    // The logic wants a lookup, but the config (ID, Tab, or Col) is missing.
    const errorMsg = "❌ Error: Missing Lookup Config (ID/Tab/Col)";
    Logger.log(`[${job.name}] ${errorMsg}`);
    
    // Update the "Status" column in your Control Center
    updateJobStatus(job.configRow, errorMsg);
    
    // Returning 'true' tells the orchestrator this job is "finished" (even though it failed)
    // so it can move on to the next row in your Control Center.
    return true; 
  }

  let currentRun = (parseInt(props.getProperty(stateKeys.run)) || 0) + 1;
  let readRow = parseInt(props.getProperty(stateKeys.read)) || 2;
  let writeRow = parseInt(props.getProperty(stateKeys.write)) || job.writeStartRow || 2;
  
  const srcSheet = safeOpenById(job.srcId).getSheetByName(job.srcTab);
  const dstSheet = safeOpenById(job.dstId).getSheetByName(job.dstTab);
  const lastRow = srcSheet.getLastRow();
  const lastCol = srcSheet.getLastColumn();

  // --- 🛑 CIRCUIT BREAKER (DROP GUARD) ---
  const dropGuardKey = `GUARD_${job.name}`;
  const previousCount = parseInt(props.getProperty(dropGuardKey)) || 0;

  if (lastRow <= 1) {
    Logger.log(`⚠️ [CIRCUIT BREAKER] Job "${job.name}" source is empty. Skipping to protect destination.`);
    updateJobStatus(job.configRow, "⚠️ Skipped (Source Empty)");
    props.deleteProperty(`LAST_RUN_${scheduleMode}`);
    return true; 
  }

  if (previousCount > 0 && lastRow < (previousCount * 0.5)) {
    Logger.log(`⚠️ [CIRCUIT BREAKER] Job "${job.name}" rows dropped from ${previousCount} to ${lastRow}. Skipping.`);
    updateJobStatus(job.configRow, "⚠️ Skipped (>50% Drop)");
    props.deleteProperty(`LAST_RUN_${scheduleMode}`);
    return true; 
  }
  // ---------------------------------------

  const minDstCol = Math.min(...job.dstCols);
  const maxDstColRequired = Math.max(...job.dstCols) + 1;
  const numColsToWrite = maxDstColRequired - minDstCol;
  const startColLetter = columnToLetter(minDstCol + 1);

  let currentMaxRows = dstSheet.getMaxRows();

  if (readRow === 2) {
    const headerRaw = safeGet(job.srcId, `${job.srcTab}!A1:${columnToLetter(lastCol)}1`)[0];
    if (headerRaw) {
      let mappedHeader = new Array(numColsToWrite).fill("");
      job.srcCols.forEach((sIdx, i) => { 
        let val = headerRaw[sIdx];
        mappedHeader[job.dstCols[i] - minDstCol] = (val === undefined || val === null) ? "" : val; 
      });
      
      // If CALC:, add a generic header for the final calculated column
      if(job.logic && job.logic.startsWith("CALC:") && job.dstCols.length > job.srcCols.length) {
        mappedHeader[job.dstCols[job.dstCols.length - 1] - minDstCol] = "Calculated Result";
      }
      
      safeUpdate({ values: [mappedHeader] }, job.dstId, `${job.dstTab}!${startColLetter}1`, { valueInputOption: "USER_ENTERED" });
    }
  }

  const isFull = (currentRun >= job.cycle) || job.forceReset;
  
  const config = getOptimalBatchSize(lastRow, job.dstTab, job.dstCols.length);
  const BATCH = config.batch;
  const SAFE_BATCH_LIMIT = config.limit;

  // ========================================================================
  // 🛡️ PRE-FLIGHT GUARDRAILS (Config Validation)
  // ========================================================================
  if (job.dstCols.length < job.srcCols.length) {
    Logger.log(`❌ [FATAL ERROR] Job "${job.name}": Destination columns (${job.dstCols.length}) are fewer than Source columns (${job.srcCols.length}).`);
    updateJobStatus(job.configRow, "❌ Error: Col Mismatch");
    return false; // Abort immediately
  }

  const filter = createSafeFilter(job.logic);
  let calculator = null;
  const isCalcJob = job.logic && job.logic.startsWith("CALC:");

  if (isCalcJob) {
    if (job.dstCols.length === job.srcCols.length) {
      Logger.log(`❌ [FATAL ERROR] Job "${job.name}" uses CALC: but has no extra destination column defined for the result.`);
      updateJobStatus(job.configRow, "❌ Error: Missing Calc Col");
      return false; // Abort immediately
    }
    
    if (!job.logic.includes("FORMAT_DATE")) {
    try {
      calculator = createSafeCalculator(job.logic);
      const dummyRow = new Array(Math.max(...job.srcCols) + 1).fill(1);
      const testRun = calculator(dummyRow);
      
      if (isNaN(testRun)) {
        Logger.log(`⚠️ [WARNING] Calculator for "${job.name}" returned NaN during the test run. Double check your math columns.`);
      }
    } catch (e) {
      Logger.log(`❌ [FATAL ERROR] Job "${job.name}" has invalid CALC syntax: ${e.message}`);
      updateJobStatus(job.configRow, "❌ Error: Bad Calc Syntax");
      return false; // Abort immediately
    }
  }
  }
  // ========================================================================

  let fastFailColIdx = -1;
  if (lookupMap && job.logic && job.logic.includes("LOOKUP")) {
    const match = job.logic.match(/COL_(\d+)/);
    if (match) fastFailColIdx = parseInt(match[1]) - 1; 
  }

  const HARD_STOP = MAX_EXECUTION_TIME_MS - 120000; 

  while (readRow <= lastRow) {
    if (Date.now() - startTime > HARD_STOP) {
      props.setProperty("ACTIVE_RELAY", JSON.stringify({ 
        pipeline: scheduleMode, id: job.name, timestamp: Date.now(), 
        count: 0 
      }));
      Logger.log(`⏳ [RELAY] Job "${job.name}" yielded at row ${readRow}. Sentinel will resume this on its next pass.`);
      updateJobStatus(job.configRow, "⏳ Waiting for relay trigger");
      return false; 
    }

    const num = Math.min(BATCH, lastRow - readRow + 1);
    const raw = safeGet(job.srcId, `${job.srcTab}!A${readRow}:${columnToLetter(lastCol)}${readRow + num - 1}`);

    const blockIdx = Math.floor((readRow - 2) / BATCH);

    const hashString = JSON.stringify(raw) + job.logic + job.srcCols.join() + job.dstCols.join();
    const blockHash = md5Hash(hashString);

    const hashKey = `H_${job.name}_B${blockIdx}`;
    
    if (!isFull && props.getProperty(hashKey) === blockHash) {
      writeRow += parseInt(props.getProperty(`L_${job.name}_B${blockIdx}`) || "0");
      Logger.log(`⏭️ [${job.name}] Block ${blockIdx} unchanged.`); 
    } else {
      let filtered = [];
      
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        if (fastFailColIdx >= 0) {
          const id = cleanId(r[fastFailColIdx]);
          if (!lookupMap.has(id)) continue; 
        }

        // If it passes standard filtering, OR if it's a dedicated CALC job (which copies all rows)
        if (filter(r, lookupMap) || isCalcJob) {
          let mapped = new Array(numColsToWrite).fill("");
          
          // 1. Normal Mapping 
          for (let j = 0; j < job.srcCols.length; j++) {
            let val = r[job.srcCols[j]];
            mapped[job.dstCols[j] - minDstCol] = (val === undefined || val === null) ? "" : val;
          }
          
          // 2. Calculated Column Mapping
          if (job.dstCols.length > job.srcCols.length) {
             const lastDstIdx = job.dstCols[job.dstCols.length - 1] - minDstCol; 

             if (job.logic.includes("FORMAT_DATE")) {
                // 🚀 Date Interceptor: 'r' is the current row. Col 6 is index 5.
                const ms = parseTimestampToMs(r[5]);
                mapped[lastDstIdx] = ms 
                   ? Utilities.formatDate(new Date(ms), GLOBAL_TZ, "dd-MMM-yyyy") 
                   : "";
                   
             } else if (calculator) {
                // Standard Math Calculator
                const mathResult = calculator(r);
                mapped[lastDstIdx] = Math.round(mathResult * 100) / 100; 
             }
          }
          
          filtered.push(mapped);
        }
      }
      
      if (filtered.length > 0) {
        if (writeRow + filtered.length > currentMaxRows) {
           dstSheet.insertRowsAfter(currentMaxRows, (writeRow + filtered.length) - currentMaxRows);
           currentMaxRows = writeRow + filtered.length;
        }
        
        const batchRequests = [];
        for (let w = 0; w < filtered.length; w += SAFE_BATCH_LIMIT) {
          batchRequests.push({
            range: `${job.dstTab}!${startColLetter}${writeRow + w}`,
            values: filtered.slice(w, w + SAFE_BATCH_LIMIT)
          });
        }
        
        if (batchRequests.length > 0) {
          safeBatchUpdate(job.dstId, batchRequests);
        }
        
        writeRow += filtered.length;
      }
      Logger.log(`✅ [${job.name}] Block ${blockIdx}: Kept ${filtered.length} rows.`); 
      props.setProperties({ [hashKey]: blockHash, [`L_${job.name}_B${blockIdx}`]: filtered.length.toString() });
    }
    readRow += num;
    props.setProperties({ [stateKeys.read]: readRow.toString(), [stateKeys.write]: writeRow.toString() });
  }

  // --- 🧹 SAFE GRID-CLAMPED CLEANUP ---
  // Refresh the physical max rows right before clearing to avoid stale cache errors
  const finalDstSheet = safeOpenById(job.dstId).getSheetByName(job.dstTab);
  const physicalMaxRows = finalDstSheet.getMaxRows();

  if (physicalMaxRows >= writeRow) {
    // Open-ended range (e.g., A340:E). The API safely clears to the true bottom without crashing.
    const safeClearRange = `${job.dstTab}!${startColLetter}${writeRow}:${columnToLetter(maxDstColRequired)}`;
    safeClear(job.dstId, safeClearRange);
    Logger.log(`🧹 [${job.name}] Cleared leftover data from row ${writeRow} downwards.`);
  }
  
  props.setProperty(stateKeys.run, isFull ? "0" : currentRun.toString());
  props.deleteProperty(stateKeys.read); props.deleteProperty(stateKeys.write);
  if (readRow > lastRow) props.setProperty(dropGuardKey, lastRow.toString());
  
  // --- 🧹 SMART GARBAGE COLLECTION ---
  const maxBlockIdx = Math.floor((lastRow - 2) / BATCH);
  cleanUpJobProperties(job.name, maxBlockIdx);

  updateJobStatus(job.configRow, "✅ Success");
  Utilities.sleep(3000);
  return true;
}

/**
 * ==============================================================================
 * PART 4: WRAPPERS & UI
 * ==============================================================================
 */

function cleanupRelays() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty("ACTIVE_RELAY");
}

function isWithinOperatingHours() {
  const tz = GLOBAL_TZ;
  const now = new Date();
  
  // 🛡️ Force ALL date variables to respect your timezone to prevent midnight bugs
  const year = parseInt(Utilities.formatDate(now, tz, "yyyy"));
  const month = parseInt(Utilities.formatDate(now, tz, "MM")) - 1; // -1 because JS dates are 0-indexed
  const date_today = parseInt(Utilities.formatDate(now, tz, "dd"));
  const hour = parseInt(Utilities.formatDate(now, tz, "H"));
  
  // Calculate remaining days in the month
  const max_days = new Date(year, month + 1, 0).getDate();
  const rem_days = max_days - date_today;
  
  // Rule 0: Allow relays to finish no matter what time it is
  if (PropertiesService.getScriptProperties().getProperty("ACTIVE_RELAY")) return true;
  
  // Rule 1 & 2: First 3 days OR Last 2 days (Run 24/7)
  if (date_today <= 3 || rem_days <= 1) {
    return true;
  }
  
  // Rule 3: All other days (Run 8:00 AM to 10:59 PM)
  return (hour >= 8 && hour < 23);
}

function cleanId(val) {
  if (val === null || val === undefined || val === "") return "";
  let s = String(val).trim();
  if (s.includes('E+') || s.includes('e+')) s = Number(val).toLocaleString('fullwide', {useGrouping:false});
  if (s.endsWith('.0')) s = s.slice(0, -2); 
  return s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function safeGet(sid, range) { return withExponentialBackoff(() => Sheets.Spreadsheets.Values.get(sid, range).values || []); }

function safeUpdate(b, sid, range, opt) { return withExponentialBackoff(() => Sheets.Spreadsheets.Values.update(b, sid, range, opt)); }

function safeClear(sid, range) { 
  return withExponentialBackoff(() => {
    try {
      return Sheets.Spreadsheets.Values.clear({}, sid, range);
    } catch (e) {
      if (e.message.includes("exceeds grid limits")) {
        Logger.log(`⚠️ Grid limit detected for ${range}. Activating Smart Shield...`);
        const parts = range.split("!");
        if (parts.length < 2) throw e; 
        
        const tabName = parts[0].replace(/'/g, ""); 
        const a1 = parts[1];
        const targetSheet = safeOpenById(sid).getSheetByName(tabName);
        if (!targetSheet) throw e;
        const maxRows = targetSheet.getMaxRows();
        const match = a1.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);
        
        if (match) {
          const startCol = match[1];
          const startRow = parseInt(match[2], 10);
          const endCol = match[3];
          let endRow = parseInt(match[4], 10);
          
          if (startRow > maxRows) {
            Logger.log(`✅ Rows already deleted. Skipping clear for ${range}`);
            return {}; 
          }
          endRow = Math.min(endRow, maxRows);
          const safeRange = `${parts[0]}!${startCol}${startRow}:${endCol}${endRow}`;
          Logger.log(`🔄 Adjusted clear command to safe range: ${safeRange}`);
          return Sheets.Spreadsheets.Values.clear({}, sid, safeRange);
        }
      }
      throw e; 
    }
  });
}


function updateJobStatus(row, status) {
  const ts = Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm");
  safeUpdate({values: [[`${ts} - ${status}`]]}, CONTROL_CENTER_ID, `${CONTROL_TAB_NAME}!J${row}`, {valueInputOption: "USER_ENTERED"});
}

function updateSentinelDashboard(actionText) {
  try {
    const p = PropertiesService.getScriptProperties();
    const tz = GLOBAL_TZ;
    const nowStr = Utilities.formatDate(new Date(), tz, "dd/MM HH:mm:ss");
    const statusText = `🤖 Sentinel Last Checked: ${nowStr} | Action: ${actionText}`;
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(CONTROL_TAB_NAME);
    sheet.getRange("J1:P2").mergeAcross().setValue(statusText).setBackground("#e8f0fe").setFontColor("#1a73e8").setFontWeight("bold").setVerticalAlignment("middle").setWrap(true);
  } catch(e) {}
}

/**
 * ==============================================================================
 * 🎯 DEDICATED RUNNER: CBC_Payments_to_PB_Dash (Phase 2.5)
 * ==============================================================================
 * This job was removed from the main 1H pipeline because it was consistently
 * hitting Google Sheets API quota throttling when running after 16+ other jobs.
 * 
 * Running it on its own trigger at :15 past each hour gives Google's per-user
 * quota window time to fully reset, eliminating the 2-6 minute per-block
 * throttle delays observed in production logs.
 * 
 * This function:
 *   - Is designed to be called from a dedicated time trigger (every hour at :15)
 *   - Uses its own lock so it won't block or be blocked by the main Sentinel
 *   - Logs to Sentinel_Health tab like any other pipeline run
 *   - Uses the relay system if it still can't finish in one 30-min window
 *   - Does NOT touch POST_PROCESS_PENDING — only the Sentinel should do that
 */
function runCBCPaymentsDedicated() {
  // Use a DIFFERENT lock key than the main Sentinel. These two functions
  // must be able to run concurrently without blocking each other.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("⏭️ [CBC-DEDICATED] Could not acquire lock. Skipping this run.");
    return;
  }
  const p = PropertiesService.getScriptProperties();
  const runStartMs = Date.now();
  let outcome = "💤 No work";
  // Guard: if the main Sentinel is currently running, skip this invocation.
  // We don't want to fight over the same spreadsheets.
  const sentinelRunning = p.getProperty("SENTINEL_RUNNING");
  if (sentinelRunning) {
    const age = Date.now() - parseInt(sentinelRunning);
    if (age < 28 * 60 * 1000) {
      Logger.log(`⏭️ [CBC-DEDICATED] Main Sentinel is running (${Math.round(age/60000)}m). Skipping to avoid contention.`);
      lock.releaseLock();
      return;
    }
    // If > 28m old, it's a stale semaphore — self-heal will eventually clear it.
    // We still skip this run to be safe.
    Logger.log(`⚠️ [CBC-DEDICATED] Main Sentinel semaphore is stale (${Math.round(age/60000)}m). Skipping anyway.`);
    lock.releaseLock();
    return;
  }
  // Stamp our OWN semaphore so main Sentinel knows we're active
  p.setProperty("CBC_DEDICATED_RUNNING", runStartMs.toString());
  try {
    Logger.log(`🎯 [CBC-DEDICATED] Waking up at :15 for CBC_Payments_to_PB_Dash`);

    // ✅ Respect operating hours (same logic as main Sentinel).
    // Note: isWithinOperatingHours() already allows relays to finish 24/7.
    if (!isWithinOperatingHours()) {
      Logger.log(`💤 [CBC-DEDICATED] Outside operating hours. Skipping.`);
      outcome = "💤 Outside hours";
      return;
    }

    // Load the job config from the Control Center
    const allJobs = loadSystemConfig();
    const job = allJobs.find(j => j.name === "CBC_Payments_to_PB_Dash");
    if (!job) {
      Logger.log(`⚠️ [CBC-DEDICATED] Job "CBC_Payments_to_PB_Dash" not found in Control Center. Nothing to do.`);
      outcome = "⚠️ Job not found";
      return;
    }
    // Check if the job is [SKIP]'d — if so, respect that
    if (job.name && job.name.includes("[SKIP]")) {
      Logger.log(`⏭️ [CBC-DEDICATED] Job is marked [SKIP]. Skipping.`);
      outcome = "⚠️ Skipped (user)";
      return;
    }
    updateJobStatus(job.configRow, "⚙️ Executing (Dedicated)...");
    const success = runHybridSync(job, runStartMs, "DEDICATED", 0);
    if (success) {
      const _dedDur = formatDuration(Date.now() - runStartMs);
      updateJobStatus(job.configRow, `✅ Success (Dedicated) (${_dedDur})`);
      outcome = "✅ Dedicated run complete";
      Logger.log(`✅ [CBC-DEDICATED] Job completed successfully in ${_dedDur}.`);
    } else {
      // Job returned false = it set a relay. Our NEXT invocation at :15 will resume it.
      updateJobStatus(job.configRow, "⏳ Waiting for relay trigger (Dedicated)");
      outcome = "⏳ Paused (will resume)";
      Logger.log(`⏳ [CBC-DEDICATED] Job relayed. Will resume on next :15 trigger.`);
    }
  } catch (e) {
    Logger.log(`❌ [CBC-DEDICATED] Error: ${e.message}\n${e.stack}`);
    outcome = `❌ Error: ${e.message}`;
    // Send alert (dedicated runner failures are noteworthy)
    try {
      MailApp.sendEmail({
        to: getAlertEmail(),
        subject: `🚨 WE-RIZE: CBC_Payments Dedicated Runner Failed`,
        body: `The dedicated CBC_Payments_to_PB_Dash runner hit an error:\n\n${e.message}\n\nStack:\n${e.stack}\n\nThe relay system will retry on the next :15 trigger.`
      });
    } catch(mailErr) {
      Logger.log("Could not send error email: " + mailErr);
    }
  } finally {
    p.deleteProperty("CBC_DEDICATED_RUNNING");
    lock.releaseLock();
    // Log to Sentinel_Health tab
    try {
      const durationMs = Date.now() - runStartMs;
      logSentinelRun("CBC-DED", durationMs, outcome, 1, "Dedicated CBC_Payments trigger");
      updateSentinelHealthState();
    } catch(logErr) {
      Logger.log("Phase 2.5 logging failed (non-fatal): " + logErr.message);
    }
  }
}