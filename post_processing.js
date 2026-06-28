/**
 * ==============================================================================
 * PART 1: UPDATED POST-PROCESSING (Allocation-Shielded Edition)
 * ==============================================================================
 * Updated runPostProcessing — reads sheet IDs from Post_Sentinel tab
 * instead of hardcoded S1/S2/S3 cells in Routing_Config.
 * Includes Sentinel_Health logging so the Control Center UI tracks it.
 */

function runPostProcessing() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("⏭️ [POST-PROCESS] Another instance is running. Skipping.");
    return;
  }

  try {
    const p = PropertiesService.getScriptProperties();

    if (p.getProperty("POST_PROCESS_PENDING") !== "true") {
      Logger.log("💤 No post-processing pending.");
      return;
    }

    // Read sheet IDs from Post_Sentinel tab instead of S1/S2/S3
    const ppConfig  = loadPostSentinelConfig("Post_Processing");
    const getVal    = (key) => (ppConfig.find(c => c.key === key) || {}).ssId || "";

    const PENAL_ID     = getVal("PP_STEP_1");
    const CALL_LOG_ID  = getVal("PP_STEP_2");
    const DISPO_LOG_ID = getVal("PP_STEP_3");

    if (!PENAL_ID)     { Logger.log("❌ PP_STEP_1 missing from Post_Sentinel tab."); return; }
    if (!CALL_LOG_ID)  { Logger.log("❌ PP_STEP_2 missing from Post_Sentinel tab."); return; }
    if (!DISPO_LOG_ID) { Logger.log("❌ PP_STEP_3 missing from Post_Sentinel tab."); return; }

    const PP_START     = Date.now();
    const PP_HARD_STOP = 28 * 60 * 1000;
    let lastStep = parseInt(p.getProperty("POST_PROCESS_STEP") || "0");
    Logger.log(`🧮 Post-Processing resuming from step ${lastStep + 1}...`);

    try {
      if (lastStep < 1) {
        Logger.log("🧮 Step 1: Running Penal Metrics...");
        if (typeof calculatePenalMetrics === "function") calculatePenalMetrics(PENAL_ID, CALL_LOG_ID, DISPO_LOG_ID);
        p.setProperty("POST_PROCESS_STEP", "1"); lastStep = 1;
        Logger.log("✅ Step 1 complete.");
      } else { Logger.log("⏭️ Step 1 already done."); }

      if (Date.now() - PP_START > PP_HARD_STOP) {
        Logger.log("⚠️ [POST-PROCESS] Time limit after Step 1. Resuming next trigger.");
        try { logSentinelRun("PP", Date.now() - PP_START, "⏳ Paused after Step 1", 0, "Will resume"); updateSentinelHealthState(); } catch(e) {}
        return;
      }

      if (lastStep < 2) {
        Logger.log("🧮 Step 2: Running Discount Calc...");
        if (typeof calculatediscountamt === "function") calculatediscountamt(PENAL_ID);
        p.setProperty("POST_PROCESS_STEP", "2"); lastStep = 2;
        Logger.log("✅ Step 2 complete.");
      } else { Logger.log("⏭️ Step 2 already done."); }

      if (Date.now() - PP_START > PP_HARD_STOP) {
        Logger.log("⚠️ [POST-PROCESS] Time limit after Step 2. Resuming next trigger.");
        try { logSentinelRun("PP", Date.now() - PP_START, "⏳ Paused after Step 2", 0, "Will resume"); updateSentinelHealthState(); } catch(e) {}
        return;
      }

      if (lastStep < 3) {
        Logger.log("🧮 Step 3: Running Daily Inputs...");
        if (typeof calculateDailyInputs === "function") calculateDailyInputs(PENAL_ID, CALL_LOG_ID);
        p.setProperty("POST_PROCESS_STEP", "3"); lastStep = 3;
        Logger.log("✅ Step 3 complete.");
      } else { Logger.log("⏭️ Step 3 already done."); }

      Logger.log("✅ All Post-Processing steps complete!");

    } catch(e) {
      Logger.log("❌ Post-processing failed at step " + lastStep + ": " + e.message);
      p.setProperty("POST_PROCESS_STEP", lastStep.toString());
      try {
        logSentinelRun("PP", Date.now() - PP_START, `❌ Failed at Step ${lastStep}`, 0, e.message);
        updateSentinelHealthState();
      } catch(logErr) {}
    } finally {
      if (lastStep >= 3) {
        p.deleteProperty("POST_PROCESS_PENDING");
        p.deleteProperty("POST_PROCESS_STEP");
        Logger.log("✅ Post-process flags cleared.");
        try {
          logSentinelRun("PP", Date.now() - PP_START, "✅ Post-processing complete", "-", "Penal · Discount · Daily");
          updateSentinelHealthState();
        } catch(logErr) { Logger.log("PP logging failed: " + logErr.message); }
      } else {
        Logger.log(`⏳ Post-process paused at step ${lastStep}. Resuming next trigger.`);
      }
    }

  } finally {
    lock.releaseLock();
  }
}


// ─── RUNMASTERSYNC PATCH ──────────────────────────────────────────────────────

function _setPostSentinelFlag(scheduleMode, p) {
  if (scheduleMode === "1H" || scheduleMode === "1D" || scheduleMode === "NIGHTLY") {
    p.setProperty("DISPO_AGG_PENDING", "true");
    p.setProperty("DISPO_AGG_START",   Date.now().toString());

    p.setProperty("CALL_AGG_PENDING", "true");
    p.setProperty("CALL_AGG_START",   Date.now().toString());

    p.deleteProperty("DISPO_AGG_DONE");
    p.deleteProperty("CALL_AGG_DONE");

    Logger.log("✅ Sync complete. Dispo + Call aggregations queued (parallel).");
  } else {
    Logger.log(`✅ Sync complete (${scheduleMode}). Skipping aggregations.`);
  }
}


/**
 * ==============================================================================
 * PART 2: ANALYTICAL ENGINE (Allocation-Shielded Edition)
 * ==============================================================================
 */

function calculatePenalMetrics(PENAL_ID, CALL_LOG_ID, DISPO_LOG_ID) {
  if (!PENAL_ID || !CALL_LOG_ID || !DISPO_LOG_ID) return;

  const targetSheetName = "2. PENAL DATA";
  const dispoSheetName  = "Combined_Dispo_Logs";

  const targetSheet  = safeOpenById(PENAL_ID).getSheetByName(targetSheetName);
  const dispoLogSheet = safeOpenById(DISPO_LOG_ID).getSheetByName(dispoSheetName);

  const dispoRankMap = {
    "ALREADY PAID": 1.0, "FULL CHARGES PAID": 1.0, "PAID": 1.1, "PAYMENT COLLECTED": 1.2, "PAYMENT COLLECTED (PAID)": 1.3,
    "PART CHARGES PAID": 2.0, "PTP": 3.0, "PTP (PROMISE TO PAY)": 3.1, "BPTP": 4.0, "BP": 4.1, "BP (BROKEN PTP)": 4.2,
    "LEFT MESSAGE": 5.0, "LM": 5.1, "ANSWERED": 6.0, "CALLBACK": 6.1, "CALL BACK": 6.2, "CBK": 6.3, "RTP": 7.0,
    "RTP (REFUSE TO PAY)": 7.1, "WRONG NUMBER": 8.1, "WRN": 8.2, "DISPUTE": 9.0, "QUERIES": 9.1, "EXP": 9.2, "EXPIRED": 9.3,
    "RINGING NOT RESPONDING": 10.0, "RNR": 10.1, "RNR (RINGING NO RESPONSE)": 10.3, "BUSY": 11.0, "CALL DISCONNECTED": 12.0,
    "CALL - DISCONNECTED": 12.1, "NOTANSWERED": 12.2, "UNANSWERED": 12.3, "NOT ANSWERED": 12.4, "NOT CONNECTED": 13.0,
    "TEMP - DISCON": 13.1, "NC": 13.2, "NC (NOT CONTACTABLE)": 13.3, "TEMP - DISCONNECTED": 13.3, "SWITCHED OFF": 14.0,
    "SWO": 14.1, "SWITCH OFF": 14.2, "LOAN CLOSED": 16.0, "NOC RECEIVED": 16.1,
    "NO CONTACT WITH BORROWER": 17.0, "WILL INFORM BORROWER": 18.0
  };

  const targetMaxRow = targetSheet ? targetSheet.getLastRow() : 0;
  if (targetMaxRow < 2) return;

  // FIX: declare callLogSheet here so CALL_BATCH is available to ALL loops below
  const callLogSheet = safeOpenById(CALL_LOG_ID).getSheetByName("Combined_Call_Logs");
  const CALL_BATCH = callLogSheet
    ? getOptimalBatchSize(callLogSheet.getLastRow(), "Combined_Call_Logs", 4).limit
    : Math.floor(250000 / 4); // 62,500 rows — fallback if sheet not found

  const config          = getOptimalBatchSize(targetMaxRow, targetSheetName);
  const SAFE_BATCH_LIMIT = config.limit;

  // --- 1. BUILD ALLOCATION SHIELDS ---
  Logger.log("🛡️ Building Allocation Shields from Column AB...");
  const allocMapLead = new Map();

  const baseData = safeGet(PENAL_ID, `'${targetSheetName}'!A2:AB${targetMaxRow}`);
  for (const r of baseData) {
    const lid     = cleanId(r[0]);   // Col A
    const allocTs = parseTimestampToMs(r[27]) || 0; // Col AB
    if (lid) allocMapLead.set(lid, allocTs);
  }

  const callMap = new Map();

  // --- 2. PRE-PROCESS COMBINED CALL LOGS ---
  if (!callLogSheet) {
    Logger.log(`❌ [PENAL] Combined_Call_Logs tab not found. Call attempts will be 0.`);
  } else {
    Logger.log("🧮 Mapping Combined Call Logs in batches...");
    updateModuleStatus("R1", "⏳ Penal: Mapping call logs...");
    const callMaxRow = callLogSheet.getLastRow();

    for (let startRow = 2; startRow <= callMaxRow; startRow += CALL_BATCH) {
      const numRows = Math.min(CALL_BATCH, callMaxRow - startRow + 1);
      // A=lead_id, B=phone, C=call_timestamp, D=talk_duration_sec
      const chunk = safeGet(CALL_LOG_ID, `'Combined_Call_Logs'!A${startRow}:D${startRow + numRows - 1}`);
      for (let i = 0; i < chunk.length; i++) {
        const row    = chunk[i];
        const leadId = cleanId(row[0]);
        if (!leadId) continue;
        const allocTs = allocMapLead.get(leadId) || 0;
        processLogEntry(callMap, leadId, row[2], row[3], allocTs);
      }
    }
  }

  // --- 3. PRE-PROCESS DISPO LOGS ---
  Logger.log("🧮 Mapping Dispositions in batches...");
  updateModuleStatus("R1", "⏳ Penal: Mapping dispositions...");
  const dispoMaxRow = dispoLogSheet ? dispoLogSheet.getLastRow() : 0;
  const dispoMap    = new Map();
  // FIX: use correct batch size for 6-col dispo read (not the 4-col call batch)
  const DISPO_BATCH = dispoMaxRow > 1
    ? getOptimalBatchSize(dispoMaxRow, dispoSheetName, 6).limit
    : Math.floor(250000 / 6);

  let tallyFilteredOldDispos = 0;

  if (dispoMaxRow > 1) {
    for (let startRow = 2; startRow <= dispoMaxRow; startRow += DISPO_BATCH) {
      const numRows       = Math.min(DISPO_BATCH, dispoMaxRow - startRow + 1);
      const dispoDataChunk = safeGet(DISPO_LOG_ID, `'${dispoSheetName}'!A${startRow}:F${startRow + numRows - 1}`);

      for (let i = 0; i < dispoDataChunk.length; i++) {
        const row = dispoDataChunk[i];
        const lid = cleanId(row[0]);
        if (!lid) continue;

        const allocTs = allocMapLead.get(lid) || 0;
        const ts      = parseTimestampToMs(row[2]); // col C = call_dialled_on

        if (ts > 0 && ts < allocTs) { tallyFilteredOldDispos++; continue; }

        const status = String(row[1] || "").toUpperCase().trim(); // col B = pb_calling_status
        if (!status) continue;
        const rank = dispoRankMap[status] || 99;

        if (!dispoMap.has(lid)) {
          dispoMap.set(lid, { best: status, bestRank: rank, last: status, lastDate: ts });
        } else {
          const entry = dispoMap.get(lid);
          if (rank < entry.bestRank) { entry.bestRank = rank; entry.best = status; }
          if (ts > entry.lastDate)   { entry.lastDate = ts; entry.last = status; }
        }
      }
    }
  }

  // --- 4. GENERATE OUTPUT (HASH-SKIPPED WRITES) ---
  Logger.log("✍️ Finalizing Penal Data calculations...");
  updateModuleStatus("R1", "⏳ Penal: Writing output...");
  const props = PropertiesService.getScriptProperties();
  let maxPenalBlock = -1;

  let tallyUntouched = 0; let tallyNoDispo = 0; let tallyDispoFound = 0;

  for (let startRow = 2; startRow <= targetMaxRow; startRow += CALL_BATCH) {
    const numRows        = Math.min(CALL_BATCH, targetMaxRow - startRow + 1);
    const targetDataChunk = safeGet(PENAL_ID, `'${targetSheetName}'!A${startRow}:D${startRow + numRows - 1}`);

    const outputChunk = [];
    for (let i = 0; i < targetDataChunk.length; i++) {
      const lid = cleanId(targetDataChunk[i][0]);
      if (lid === "") { outputChunk.push(["", "", "", "", "", ""]); continue; }

      const lidS = callMap.get(lid) || { attempts: 0, answered: 0, tt: 0, lastDate: -1 };
      // mobS kept for backward compatibility — always zero since callMap is lead-keyed
      const mob  = cleanId(targetDataChunk[i][3]);
      const mobS = callMap.get(mob) || { attempts: 0, answered: 0, tt: 0, lastDate: -1 };

      const totalAttempts = lidS.attempts + mobS.attempts;
      const answeredCalls = lidS.answered + mobS.answered;
      const totalTT       = Math.round((lidS.tt + mobS.tt) * 100) / 100;
      const lastAt        = Math.max(lidS.lastDate, mobS.lastDate);

      const fallbackStatus = totalAttempts > 0 ? "No Disposition" : "UNTOUCHED";
      const dStats = dispoMap.get(lid) || { best: fallbackStatus, last: fallbackStatus };

      if (dStats.best === "UNTOUCHED")       tallyUntouched++;
      else if (dStats.best === "No Disposition") tallyNoDispo++;
      else tallyDispoFound++;

      if (startRow === 2 && i < 3) {
        Logger.log(`🔍 [AUDIT Row ${startRow + i}] ID: ${lid} | Att: ${totalAttempts} | Ans: ${answeredCalls} | BestDispo: ${dStats.best}`);
      }

      let rawDateNumber = "";
      if (lastAt > 0) {
        const localMs = lastAt + 19800000; // shift to IST (+5:30)
        rawDateNumber = (localMs / 86400000) + 25569; // Sheets epoch serial
      }

      outputChunk.push([totalAttempts, answeredCalls, totalTT, rawDateNumber, dStats.best, dStats.last]);
    }

    if (outputChunk.length > 0) {
      for (let w = 0; w < outputChunk.length; w += SAFE_BATCH_LIMIT) {
        const smallChunk = outputChunk.slice(w, w + SAFE_BATCH_LIMIT);
        const currentRow = startRow + w;
        const blockIdx   = Math.floor(currentRow / SAFE_BATCH_LIMIT);

        if (blockIdx > maxPenalBlock) maxPenalBlock = blockIdx;

        const hashResult = checkHashState(smallChunk, "Penal_Metrics", blockIdx, props);
        if (hashResult !== true) {
          const targetRange = `'${targetSheetName}'!S${currentRow}:X${currentRow + smallChunk.length - 1}`;
          safeUpdate({ values: smallChunk }, PENAL_ID, targetRange, { valueInputOption: "USER_ENTERED" });
          props.setProperty(`H_Penal_Metrics_B${blockIdx}`, hashResult);
        }
      }
    }
  }

  Logger.log(`📊 ==== PENAL METRICS SUMMARY ====`);
  Logger.log(`   ├─ Leads Untouched : ${tallyUntouched}`);
  Logger.log(`   ├─ Calls/No Dispo  : ${tallyNoDispo}`);
  Logger.log(`   ├─ Dispo Found     : ${tallyDispoFound}`);
  Logger.log(`   └─ 🛡️ Old Dispos Blocked : ${tallyFilteredOldDispos}`);
  Logger.log(`📊 ===============================`);

  if (maxPenalBlock >= 0) cleanUpJobProperties("Penal_Metrics", maxPenalBlock);
  Logger.log("✅ Update Successful.");
  updateModuleStatus("R1", "✅ Penal: Complete");
}


/**
 * ⚡ HELPERS: Logic & Math Safeguards for Penal Metrics
 */
function processLogEntry(map, key, dateVal, ttVal, allocTs) {
  if (!key || key === "") return;
  const ts = parseTimestampToMs(dateVal);

  if (ts > 0 && ts < allocTs) return; // shield: ignore calls before allocation date

  let ttSeconds = toNumber(ttVal) || 0;
  if (ttSeconds > 43200 || ttSeconds < 0 || !isFinite(ttSeconds)) { ttSeconds = 0; }
  const ttMinutes = ttSeconds / 60;

  if (!map.has(key)) {
    map.set(key, { attempts: 1, answered: ttSeconds > 0 ? 1 : 0, tt: ttMinutes, lastDate: ts });
  } else {
    const s = map.get(key);
    s.attempts += 1;
    if (ttSeconds > 0) s.answered += 1;
    s.tt += ttMinutes;
    if (ts > s.lastDate) s.lastDate = ts;
  }
}


/**
 * ==============================================================================
 * PART 3: UNIFIED DASHBOARD RAM AGGREGATOR (Dynamic Layout Edition)
 * ==============================================================================
 */
function calculateDailyInputs(PENAL_ID, CALL_LOG_ID) {
  const targetSheetName = "4. Daily_Inputs";

  // FIX: ROW_T3_CONFIG kept as config-cell reference (not a table position)
  const ROW_T3_CONFIG = 42; // Row containing start date (col C) and range divisor (col G)

  updateModuleStatus("R3", "⏳ Dashboard: Calculating...");
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING UNIFIED DASHBOARD AGGREGATOR (MERGED CALL LOG)`);
  Logger.log(`=======================================================`);

  const penalSS  = safeOpenById(PENAL_ID);
  const callLogSS = safeOpenById(CALL_LOG_ID);

  const dashSheet  = penalSS.getSheetByName(targetSheetName);
  const penalSheet = penalSS.getSheetByName("2. PENAL DATA");
  const callSheet  = callLogSS.getSheetByName("Combined_Call_Logs");

  if (!dashSheet || !penalSheet || !callSheet) {
    Logger.log("❌ CRITICAL ERROR: Could not resolve required sheets.");
    return;
  }

  const penalMaxRow = penalSheet.getLastRow();
  const callMaxRow  = callSheet.getLastRow();
  // FIX: batch size computed from call log dimensions (4 cols), not penal data
  const CALL_BATCH  = getOptimalBatchSize(callMaxRow, "Combined_Call_Logs", 4).limit;

  // FIX: use Utilities.formatDate with GLOBAL_TZ to avoid UTC/IST mismatch
  const safeFormatDate = (val) => {
    const ms = parseTimestampToMs(val);
    if (!ms) return "";
    try { return Utilities.formatDate(new Date(ms), GLOBAL_TZ, "yyyy-MM-dd"); }
    catch(e) { return ""; }
  };

  const dateToInt = (dateStr) => parseInt(dateStr.replace(/-/g, ""));

  // --- STEP 1: Config dates ---
  Logger.log(`\n📅 STEP 1: Fetching Config Dates from Dashboard...`);
  const todayStr     = safeFormatDate(dashSheet.getRange("C1").getValue());
  const tillDateStr  = safeFormatDate(dashSheet.getRange("N1").getValue());
  const startDateStr = safeFormatDate(dashSheet.getRange(`C${ROW_T3_CONFIG}`).getValue());
  const rangeDays    = toNumber(dashSheet.getRange(`G${ROW_T3_CONFIG}`).getValue()) || 1;

  Logger.log(`   ├─ Target Date (C1)   : ${todayStr || "NOT FOUND"}`);
  Logger.log(`   ├─ Till Date (N1)     : ${tillDateStr || "NOT FOUND"}`);
  Logger.log(`   ├─ Start Date (C${ROW_T3_CONFIG})  : ${startDateStr || "NOT FOUND"}`);
  Logger.log(`   └─ Range Divisor (G${ROW_T3_CONFIG}): ${rangeDays} days`);

  const todayInt    = dateToInt(todayStr);
  const tillDateInt = dateToInt(tillDateStr);
  const startInt    = dateToInt(startDateStr);

  // --- STEP 2: Agent ownership map ---
  Logger.log(`\n🗺️ STEP 2: Mapping Agent Ownership from Penal Data...`);
  const leadToAgent  = new Map();
  const phoneToAgent = new Map();
  const uniqueAgentsFound = new Set();

  if (penalMaxRow > 1) {
    const penalData = safeGet(PENAL_ID, `'2. PENAL DATA'!A2:Z${penalMaxRow}`);
    for (let i = 0; i < penalData.length; i++) {
      const agent = String(penalData[i][25] || "").trim(); // Col Z
      if (!agent) continue;
      uniqueAgentsFound.add(agent);
      const lead  = cleanId(penalData[i][0]);
      const phone = cleanId(penalData[i][3]);
      if (lead)  leadToAgent.set(lead, agent);
      if (phone) phoneToAgent.set(phone, agent);
    }
  }

  Logger.log(`   ├─ Active Agents Found : ${uniqueAgentsFound.size}`);
  Logger.log(`   ├─ Lead IDs Mapped     : ${leadToAgent.size}`);
  Logger.log(`   └─ Phone Numbers Mapped: ${phoneToAgent.size}`);

  const createStatBucket = () => ({
    attempts: 0, uAttSet: new Set(), connects: 0, uConnSet: new Set(), ttSec: 0
  });

  const t1Stats = {}; const t2Stats = {}; const t3Stats = {};
  const t4Stats = {};

  // --- STEP 2B: Detect dashboard layout dynamically ---
  Logger.log(`\n📐 STEP 2B: Detecting Dashboard Layout...`);
  let layout;
  try {
    layout = _detectDashboardLayout(dashSheet);
  } catch(e) {
    Logger.log(`❌ Layout detection failed: ${e.message}`);
    return;
  }
  const { t1, t2, t3, t4 } = layout;

  // Initialise t4Stats keys from detected date rows
  for (const { rawDate } of t4.dates) {
    const dStr = safeFormatDate(rawDate);
    if (dStr) t4Stats[dStr] = createStatBucket();
  }

  // --- STEP 3: Scan Combined Call Logs ---
  Logger.log(`\n📞 STEP 3: Scanning Combined Call Logs...`);
  let totalCallsMatched = 0;

  for (let startRow = 2; startRow <= callMaxRow; startRow += CALL_BATCH) {
    const numRows = Math.min(CALL_BATCH, callMaxRow - startRow + 1);
    // A=lead_id, B=phone, C=call_timestamp, D=talk_duration_sec
    const logs = safeGet(CALL_LOG_ID, `'Combined_Call_Logs'!A${startRow}:D${startRow + numRows - 1}`);
    let batchMatches = 0;

    for (let i = 0; i < logs.length; i++) {
      const r         = logs[i];
      const leadId    = cleanId(r[0]);
      const dateStr   = safeFormatDate(r[2]);
      const dateInt   = dateToInt(dateStr);
      const ttSec     = toNumber(r[3]) || 0;
      const uniqueKey = leadId;

      if (!dateStr) continue;

      // T4 — all calls regardless of agent ownership
      if (t4Stats[dateStr]) {
        const b4 = t4Stats[dateStr];
        b4.attempts++; b4.ttSec += ttSec;
        if (uniqueKey) b4.uAttSet.add(uniqueKey);
        if (ttSec > 0) { b4.connects++; if (uniqueKey) b4.uConnSet.add(uniqueKey); }
      }

      // T1/T2/T3 — only calls owned by an active agent
      const matchAgent = leadToAgent.get(leadId) || phoneToAgent.get(cleanId(r[1]));
      if (!matchAgent) continue;
      batchMatches++; totalCallsMatched++;

      if (dateInt === todayInt) {
        if (!t1Stats[matchAgent]) t1Stats[matchAgent] = createStatBucket();
        const b = t1Stats[matchAgent];
        b.attempts++; b.ttSec += ttSec;
        if (uniqueKey) b.uAttSet.add(uniqueKey);
        if (ttSec > 0) { b.connects++; if (uniqueKey) b.uConnSet.add(uniqueKey); }
      }
      if (dateInt <= tillDateInt) {
        if (!t2Stats[matchAgent]) t2Stats[matchAgent] = createStatBucket();
        const b2 = t2Stats[matchAgent];
        b2.attempts++; b2.ttSec += ttSec;
        if (uniqueKey) b2.uAttSet.add(uniqueKey);
        if (ttSec > 0) { b2.connects++; if (uniqueKey) b2.uConnSet.add(uniqueKey); }
      }
      if (dateInt >= startInt && dateInt <= tillDateInt) {
        if (!t3Stats[matchAgent]) t3Stats[matchAgent] = createStatBucket();
        const b3 = t3Stats[matchAgent];
        b3.attempts++; b3.ttSec += ttSec;
        if (uniqueKey) b3.uAttSet.add(uniqueKey);
        if (ttSec > 0) { b3.connects++; if (uniqueKey) b3.uConnSet.add(uniqueKey); }
      }
    }
    Logger.log(`   ├─ Scanned Rows ${startRow} to ${startRow + numRows - 1} | Agent Matches: ${batchMatches}`);
  }

  Logger.log(`   └─ Total calls matched to active agents: ${totalCallsMatched}`);

  // --- STEP 4: Build + write outputs using dynamic layout ---
  Logger.log(`\n📝 STEP 4: Writing outputs to Dashboard...`);
  const updates = [];

  _buildTableUpdates(targetSheetName, t1.metricMap, t1.labels, t1Stats, 1,         updates);
  _buildTableUpdates(targetSheetName, t2.metricMap, t2.labels, t2Stats, 1,         updates);
  _buildTableUpdates(targetSheetName, t3.metricMap, t3.labels, t3Stats, rangeDays, updates);

  // T4 — map date rows to their stat bucket key
  _buildTableUpdates(targetSheetName, t4.metricMap, t4.dates.map(d => ({
    label: safeFormatDate(d.rawDate), // key into t4Stats
    row:   d.row                      // 1-indexed sheet row for write position
  })), t4Stats, 1, updates);

  Logger.log(`   ├─ T1: ${t1.labels.length} agents | T2: ${t2.labels.length} | T3: ${t3.labels.length} | T4: ${t4.dates.length} dates`);
  Logger.log(`   └─ ${updates.length} column updates queued.`);

  if (updates.length > 0) {
    safeBatchUpdate(PENAL_ID, updates);
    Logger.log(`   └─ Batch write complete.`);
  }

  Logger.log("✅ UNIFIED DASHBOARD CALCULATED SUCCESSFULLY!");
  updateModuleStatus("R3", "✅ Dashboard: Complete");
}


// ─── DEBUG HELPER ─────────────────────────────────────────────────────────────

function debugT4Dates() {
  const ppConfig = loadPostSentinelConfig("Post_Processing");
  const PENAL_ID = (ppConfig.find(c => c.key === "PP_STEP_1") || {}).ssId || "";
  if (!PENAL_ID) { Logger.log("❌ PP_STEP_1 not found in Post_Sentinel config."); return; }

  const dashSheet = safeOpenById(PENAL_ID).getSheetByName("4. Daily_Inputs");
  if (!dashSheet) { Logger.log("❌ 4. Daily_Inputs tab not found."); return; }

  // FIX: corrected to row 84 (actual table start)
  const ROW_T4 = 84;
  const raw = dashSheet.getRange(ROW_T4, 2, 5, 1).getValues();
  raw.forEach((r, i) => {
    Logger.log(`Row ${ROW_T4 + i} col B: type=${typeof r[0]} | value="${r[0]}" | falsy=${!r[0]}`);
  });
}

function manualRunPostProcessing() {
  const p = PropertiesService.getScriptProperties();

  // 1. Clear any stale step memory so it starts fresh from Step 1
  p.deleteProperty("POST_PROCESS_STEP");

  // 2. Set the master flag to true so the engine bypasses the "sleep" check
  p.setProperty("POST_PROCESS_PENDING", "true");

  Logger.log("🔄 [POST-PROCESS] Manual reset complete. Starting run...");
  
  // 3. Fire the engine
  runPostProcessing();
}