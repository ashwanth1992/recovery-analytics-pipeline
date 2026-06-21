/**
 * ==============================================================================
 * 🛠️ CORE ENGINE UTILITIES (Utils.gs)
 * ==============================================================================
 * This file contains ONLY the active, high-performance runtime functions
 * used by the Sentinel pipeline. 
 * (One-off setup scripts and manual tools live in Setup_And_Tools.gs)
 * ==============================================================================
 */

// ─── 1. DATA PARSING & MATH ───────────────────────────────────────────────────

function parseTimestampToMs(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) return dateVal.getTime();
  
  let dStr = String(dateVal).trim();
  const ddmmRegex = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(.*)$/;
  const match = dStr.match(ddmmRegex);
  
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    const timeRemainder = match[4] || "";
    dStr = `${year}-${month}-${day}${timeRemainder}`;
  }
  
  const d = new Date(dStr);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function toNumber(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "-";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

function columnToLetter(c) {
  let l = '';
  while (c > 0) {
    let t = (c - 1) % 26;
    l = String.fromCharCode(t + 65) + l;
    c = (c - t - 1) / 26;
  }
  return l;
}

// ─── 2. API THROTTLING & BATCHING ─────────────────────────────────────────────

function withExponentialBackoff(action, maxRetries = 4) {
  const API_START_TIME = Date.now();
  const MAX_API_FIGHT_TIME = 5 * 60 * 1000;
  for (let i = 0; i <= maxRetries; i++) {
    try { return action(); } 
    catch (e) {
      if ((Date.now() - API_START_TIME) > MAX_API_FIGHT_TIME) {
        Logger.log(`🚨 CRITICAL: API unresponsive for over 5 mins. Pulling the plug.`);
        throw new Error("CRITICAL_TIMEOUT");
      }
      if (i === maxRetries) throw e;
      Utilities.sleep((Math.pow(2, i) * 1000) + Math.round(Math.random() * 1000));
    }
  }
}

function safeBatchUpdate(sid, requests) {
  return withExponentialBackoff(() => {
    return Sheets.Spreadsheets.Values.batchUpdate({
      valueInputOption: "USER_ENTERED",
      data: requests
    }, sid);
  });
}

function getOptimalBatchSize(lastRow, dstTab, numCols) {
  numCols = numCols || 10;
  const NORMAL_CELL_TARGET = 250000;
  const HEAVY_CELL_TARGET  = 50000; 

  const heavyKeywords = ["2. Penal Inputs", "0bkt_input", "2. PENAL DATA", "4. Daily_Inputs"];
  const safeDstTab = String(dstTab || "");
  const isHeavy = heavyKeywords.some(kw => safeDstTab.includes(kw));

  if (isHeavy) {
    const rows = Math.max(1, Math.floor(HEAVY_CELL_TARGET / numCols));
    return { batch: rows, limit: rows };
  }
  const rows = Math.max(1, Math.floor(NORMAL_CELL_TARGET / numCols));
  return { batch: rows, limit: rows };
}

// ─── 3. LOGIC & CONFIG PARSERS ────────────────────────────────────────────────

function loadSystemConfig() {
  const ss = safeOpenById(CONTROL_CENTER_ID), sheet = ss.getSheetByName(CONTROL_TAB_NAME);
  const data = sheet.getRange(4, 1, Math.max(1, sheet.getLastRow() - 3), 20).getValues();
 
  return data.map((r, i) => {
    if (!r[0] || String(r[0]).trim() === "") return null;
    return {
      name: r[0],
      configRow: i + 4,
      srcId: r[1], srcTab: r[2], dstId: r[3], dstTab: r[4],
      cycle: parseInt(r[5]) || 1,
      logic: (r[6] || "").toString(),
      srcCols: r[7] ? r[7].toString().split(",").map(n => parseInt(n.trim()) - 1) : [],
      dstCols: r[8] ? r[8].toString().split(",").map(n => parseInt(n.trim()) - 1) : [],
      lastStatus: r[9] ? String(r[9]) : "",
      forceReset: r[10] === true,
      lookupId: r[11] || null, lookupTab: r[12] || null,
      lookupKeyCol: r[13] ? parseInt(r[13]) - 1 : null,
      lookupDateCol: r[14] ? parseInt(r[14]) - 1 : null,
      schedule: (r[15] || '1H').toString().toUpperCase().trim(),
      displayName: r[16] ? String(r[16]).trim() : "",
      writeStartRow: r[19] ? parseInt(r[19]) : 2
    };
  }).filter(job => job !== null);
}

function createSafeFilter(logicString) {
  if (logicString === "COPY_ALL" || !logicString || logicString.startsWith("CALC:")) return () => true;
  const SAFE_PATTERN = /^[\w\s().&|!=><,'"+\-*/%?:[\]]+$/;
  if (!SAFE_PATTERN.test(logicString)) throw new Error(`[SECURITY] Unsafe characters in filter logic.`);

  const safeCol = (row, idx) => {
    let val = row[idx];
    if (val instanceof Date) return Utilities.formatDate(val, GLOBAL_TZ, "yyyy-MM-dd HH:mm:ss");
    return val === undefined || val === null ? "" : String(val);
  };

  let jsCode = logicString;
  jsCode = jsCode.replace(/LOOKUP_DATE_MATCH\(COL_(\d+),\s*COL_(\d+)\)/g, (match, c1, c2) => `(lookupMap && lookupMap.has(cleanId(row[${parseInt(c1)-1}])) && parseTimestampToMs(row[${parseInt(c2)-1}]) >= parseTimestampToMs(lookupMap.get(cleanId(row[${parseInt(c1)-1}]))))`);
  jsCode = jsCode.replace(/IS_IN_LOOKUP\(COL_(\d+)\)/g, (match, c1) => `(lookupMap && lookupMap.has(cleanId(row[${parseInt(c1)-1}])))`);
  jsCode = jsCode.replace(/COL_(\d+)/g, (match, c1) => `safeCol(row, ${parseInt(c1)-1})`);
 
  const compiledFn = new Function('row', 'lookupMap', 'safeCol', 'cleanId', 'parseTimestampToMs', '"use strict"; return (' + jsCode + ');');
  return (row, lookupMap) => compiledFn(row, lookupMap, safeCol, cleanId, parseTimestampToMs);
}

function createSafeCalculator(logicString) {
  if (!logicString || !logicString.startsWith("CALC:")) return null;
  let jsCode = logicString.replace("CALC:", "").trim();

  // 🚀 OPTIMIZED: Supports both FORMAT_DATE(COL_6) and FORMAT_DATE_COL_6
  jsCode = jsCode.replace(/FORMAT_DATE(?:_|\()COL_(\d+)\)?/g, (match, c1) => `(formatDateSafe(row[${parseInt(c1)-1}]))`);

  // Standard Math fallback for everything else
  jsCode = jsCode.replace(/COL_(\d+)/g, (match, c1) => `(toNumber(row[${parseInt(c1)-1}]) || 0)`);

  // ⚡ THE V8 NATIVE DATE FORMATTER (Zero Java Bridge Crossings)
  const formatDateSafe = (val) => {
    if (!val) return "";
    try {
      const ms = parseTimestampToMs(val);
      if (!ms) return val; // Fallback to raw string if invalid
      
      // Pure math conversion to Sheets Serial Number (IST Shift + Epoch)
      const localMs = ms + 19800000; 
      return (localMs / 86400000) + 25569;
    } catch(e) { return val; }
  };

  const compiledFn = new Function('row', 'toNumber', 'formatDateSafe', '"use strict"; return (' + jsCode + ');');
  return (row) => compiledFn(row, toNumber, formatDateSafe);
}

// ─── 4. STATE, HASHING, & MEMORY MANAGEMENT ───────────────────────────────────

function md5Hash(data) {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str));
}

function checkHashState(dataArray, jobName, blockIdx, props) {
  const chunkHash = md5Hash(dataArray);
  if (props.getProperty(`H_${jobName}_B${blockIdx}`) === chunkHash) return true;
  return chunkHash; 
}

function cleanUpJobProperties(jobName, maxValidBlock) {
  const props = PropertiesService.getScriptProperties();
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[HL]_${escaped}_B(\\d+)$`);
  
  let deletedCount = 0;
  props.getKeys().forEach(key => {
    const match = key.match(pattern);
    if (match && parseInt(match[1]) > maxValidBlock) {
      props.deleteProperty(key);
      deletedCount++;
    }
  });

  // Restored logging!
  if (deletedCount > 0) {
    Logger.log(`🧹 Memory Trimmed: Deleted ${deletedCount} orphaned hashes for ${jobName}`);
  } else {
    Logger.log(`🧹 GC: No orphaned hashes found for ${jobName}`);
  }
}

function checkAndSetRelay(startTime, job, scheduleMode, props) {
  if (Date.now() - startTime > (MAX_EXECUTION_TIME_MS - 120000)) {
    props.setProperty("ACTIVE_RELAY", JSON.stringify({
      pipeline: scheduleMode, id: job.name, timestamp: Date.now(), count: 0
    }));
    updateJobStatus(job.configRow, "⏳ Waiting for relay trigger");
    return true;
  }
  return false;
}

// ─── 5. HIGH SPEED LOOKUPS & PROCESSING ───────────────────────────────────────

function buildFastMap(ssId, rangeString, keyColIdx, valueProcessor) {
  const dataMap = new Map();
  const rawData = safeGet(ssId, rangeString);
  if (!rawData || rawData.length === 0) return dataMap;

  for (let r of rawData) {
    const key = cleanId(r[keyColIdx]);
    if (key) dataMap.set(key, valueProcessor(r));
  }
  return dataMap;
}

function runBatchedRowProcessor(opts) {
  const { job, startTime, scheduleMode, readRange, writeRange, transform, dstLastRow, auditFirstN } = opts;
  const props = PropertiesService.getScriptProperties();
  const readSheetId = opts.readSheetId || job.dstId;
  const stateKey = opts.stateKey || `RD_${job.name}`;

  const config = getOptimalBatchSize(dstLastRow, job.dstTab);
  let startRow = parseInt(props.getProperty(stateKey)) || 2;

  while (startRow <= dstLastRow) {
    if (checkAndSetRelay(startTime, job, scheduleMode, props)) return false;

    const numRows = Math.min(config.batch, dstLastRow - startRow + 1);
    const rawData = safeGet(readSheetId, readRange(startRow, numRows));
    const outputArray = [];

    for (let i = 0; i < rawData.length; i++) {
      const outRow = transform(rawData[i], i);
      outputArray.push(outRow);
      if (auditFirstN && startRow === 2 && i < 3) try { auditFirstN(startRow, i, rawData[i], outRow); } catch (e) {}
    }

    if (outputArray.length > 0) {
      const blockIdx = Math.floor((startRow - 2) / config.batch);
      const hashResult = checkHashState(outputArray, job.name, blockIdx, props);

      if (hashResult !== true) {
        for (let w = 0; w < outputArray.length; w += config.limit) {
          const chunk = outputArray.slice(w, w + config.limit);
          safeUpdate({ values: chunk }, job.dstId, writeRange(startRow + w, chunk.length), { valueInputOption: "USER_ENTERED" });
        }
        props.setProperty(`H_${job.name}_B${blockIdx}`, hashResult);
      }
    }
    startRow += numRows;
    props.setProperty(stateKey, startRow.toString());
  }

  cleanUpJobProperties(job.name, Math.floor((dstLastRow - 2) / config.batch));
  props.deleteProperty(stateKey);
  return true;
}

// ─── 6. SENTINEL UI & HEALTH DASHBOARD ────────────────────────────────────────

function updateModuleStatus(cell, status) {
  try {
    const ts = Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss");
    safeOpenById(CONTROL_CENTER_ID).getSheetByName(CONTROL_TAB_NAME).getRange(cell).setValue(`${ts} — ${status}`);
  } catch(e) {}
}

function ensureSentinelHealthTab() {
  const ss = safeOpenById(CONTROL_CENTER_ID);
  let sheet = ss.getSheetByName("Sentinel_Health");

  if (!sheet) {
    sheet = ss.insertSheet("Sentinel_Health");
    sheet.getRange("A1:F1").mergeAcross().setValue("🤖 SENTINEL HEALTH DASHBOARD").setBackground("#1a73e8").setFontColor("#ffffff").setFontWeight("bold").setHorizontalAlignment("center");
    sheet.getRange("A2:A5").setValues([["Current Semaphore:"],["Active Relay:"],["Post-Process Pending:"],["Last Self-Heal:"]]).setFontWeight("bold");
    sheet.getRange("B2:B5").setValue("-");
    sheet.getRange("A7:F7").setValues([["Timestamp", "Pipeline", "Duration", "Outcome", "Jobs Done", "Notes"]]).setBackground("#4c1130").setFontColor("#ffffff").setFontWeight("bold").setHorizontalAlignment("center");
    sheet.setFrozenRows(7);
  }
  return sheet;
}

function logSentinelRun(pipeline, durationMs, outcome, jobsDone, notes) {
  try {
    const sheet = ensureSentinelHealthTab();
    const ts = Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss");
    sheet.insertRowAfter(7);
    sheet.getRange(8, 1).setNumberFormat("@");
    const range = sheet.getRange(8, 1, 1, 6);
    range.setValues([[ts, pipeline || "-", formatDuration(durationMs), outcome || "-", jobsDone != null ? jobsDone : "-", notes || ""]]);

    const bgColor = outcome.includes("✅") ? "#e6f4ea"
                  : outcome.includes("❌") ? "#fce8e6"
                  : outcome.includes("⏳") ? "#fef9e7"
                  : "#ffffff";

    // Explicitly reset formatting — insertRowAfter inherits dark header style
    range.setBackground(bgColor)
         .setFontColor("#000000")
         .setFontWeight("normal")
         .setFontStyle("normal")
         .setFontSize(10)
         .setWrap(true)
         .setBorder(null, null, true, null, null, null, "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID);

    const currentRows = sheet.getLastRow();
    if (currentRows > 57) sheet.deleteRows(58, currentRows - 57);
  } catch (e) {}
}

function updateSentinelHealthState() {
  try {
    const sheet = ensureSentinelHealthTab();
    const p = PropertiesService.getScriptProperties();
    const now = Date.now();

    const semaphore = p.getProperty("SENTINEL_RUNNING");
    let semaphoreDisplay = semaphore ? (now - parseInt(semaphore) > 1800000 ? "🔴 STUCK — auto-heal will clear" : "🟡 Running") : "🟢 Idle";

    const relayRaw = p.getProperty("ACTIVE_RELAY");
    let relayDisplay = relayRaw ? "🟡 Pending Relay" : "🟢 None";

    sheet.getRange("B2:B5").setValues([[semaphoreDisplay], [relayDisplay], [p.getProperty("POST_PROCESS_PENDING") === "true" ? "🟡 Pending" : "🟢 Idle"], [p.getProperty("LAST_SELF_HEAL") || "Never run"]]);
  } catch (e) {}
}

function getRecentLogTail(n) {
  try { return Logger.getLog().split("\n").filter(l => l.trim()).slice(-n).join("\n"); } catch(e) { return ""; }
}

// ─── 7. SELF-HEALING CRON ─────────────────────────────────────────────────────

function selfHealStuckStates() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  const actions = [];
  const semaphore = p.getProperty("SENTINEL_RUNNING");
  if (semaphore && (now - parseInt(semaphore)) > 32 * 60 * 1000) {
    p.deleteProperty("SENTINEL_RUNNING"); actions.push(`Cleared stuck SENTINEL_RUNNING`);
  }
  const relayRaw = p.getProperty("ACTIVE_RELAY");
  if (relayRaw) {
    try {
      const r = JSON.parse(relayRaw);
      if ((now - (r.timestamp || 0)) > 4 * 60 * 60 * 1000) { p.deleteProperty("ACTIVE_RELAY"); actions.push(`Cleared stuck ACTIVE_RELAY`); }
    } catch(e) { p.deleteProperty("ACTIVE_RELAY"); }
  }
  // ── DISPO AGG ──
  const dispoRunning = p.getProperty("DISPO_AGG_RUNNING");
  if (dispoRunning && (now - parseInt(dispoRunning)) > 32 * 60 * 1000) {
    p.deleteProperty("DISPO_AGG_RUNNING"); actions.push(`Cleared stuck DISPO_AGG_RUNNING`);
  }
  if (p.getProperty("DISPO_AGG_PHASE") && !p.getProperty("DISPO_AGG_PENDING")) {
    p.deleteProperty("DISPO_AGG_PHASE"); p.deleteProperty("DISPO_AGG_READ_ROW"); p.deleteProperty("DISPO_AGG_START");
    actions.push(`Cleared orphan DISPO_AGG flags`);
  }
  // ── CALL AGG ──
  const callRunning = p.getProperty("CALL_AGG_RUNNING");
  if (callRunning && (now - parseInt(callRunning)) > 32 * 60 * 1000) {
    p.deleteProperty("CALL_AGG_RUNNING"); actions.push(`Cleared stuck CALL_AGG_RUNNING`);
  }
  if (p.getProperty("CALL_AGG_PHASE") && !p.getProperty("CALL_AGG_PENDING")) {
    p.deleteProperty("CALL_AGG_PHASE");
    p.deleteProperty("CALL_AGG_START");
    p.deleteProperty("CALL_AGG_READ_ROW");
    actions.push(`Cleared orphan CALL_AGG flags`);
  }
  // ── FENCE DEADLOCK RESCUE ──
  // If one engine's DONE flag has been sitting >2 hours, the other likely failed.
  // Fire PP anyway so the pipeline doesn't deadlock indefinitely.
  const dispoDone = p.getProperty("DISPO_AGG_DONE") === "true";
  const callDone  = p.getProperty("CALL_AGG_DONE")  === "true";
  const dispoStart = parseInt(p.getProperty("DISPO_AGG_START") || "0");
  const callStart  = parseInt(p.getProperty("CALL_AGG_START")  || "0");
  const FENCE_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours
  if ((dispoDone || callDone) && !(dispoDone && callDone)) {
    const olderStart = Math.max(dispoStart, callStart);
    if (olderStart > 0 && (now - olderStart) > FENCE_TIMEOUT) {
      Logger.log(`⚠️ [SELF_HEAL] Fence deadlock detected (one engine done >2h, other never completed). Forcing PP.`);
      p.setProperty("POST_PROCESS_PENDING", "true");
      p.deleteProperty("POST_PROCESS_STEP");
      p.deleteProperty("DISPO_AGG_DONE");
      p.deleteProperty("CALL_AGG_DONE");
      actions.push(`Resolved fence deadlock — forced POST_PROCESS_PENDING`);
    }
  }
  // ── POST PROCESS ──
  if (p.getProperty("POST_PROCESS_STEP") && !p.getProperty("POST_PROCESS_PENDING")) {
    p.deleteProperty("POST_PROCESS_STEP"); actions.push(`Cleared orphan POST_PROCESS_STEP`);
  }
  if (actions.length > 0) Logger.log(`🔧 [SELF_HEAL] Actions: ${actions.join(" | ")}`);
  p.setProperty("LAST_SELF_HEAL", Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss"));
  updateSentinelHealthState();
}

function testSingleJob() {
  const ss = SpreadsheetApp.openById(CONTROL_CENTER_ID);
  const sheet = ss.getSheetByName(CONTROL_TAB_NAME);
  
  const targetCell = sheet.getRange("Q2");
  const row = parseInt(targetCell.getValue());
  if (isNaN(row) || row < 4) {
    Logger.log("⚠️ ERROR: Please type a valid row number (4 or higher) into cell Q2 of your Control Center.");
    return;
  }
  const r = sheet.getRange(row, 1, 1, 16).getValues()[0];
  if (!r[0] || !r[1]) {
    Logger.log(`⚠️ ERROR: Row ${row} is empty or does not contain a valid job setup.`);
    return;
  }
  Logger.log(`🚀 MANUAL OVERRIDE INITIATED: Testing job "${r[0]}" on Row ${row}...`);
  const job = {
    name: r[0], configRow: row, srcId: r[1], srcTab: r[2], dstId: r[3], dstTab: r[4],
    cycle: parseInt(r[5]) || 1, logic: r[6].toString(),
    srcCols: r[7].toString().split(",").map(n => parseInt(n.trim()) - 1),
    dstCols: r[8].toString().split(",").map(n => parseInt(n.trim()) - 1),
    forceReset: r[10] === true, lookupId: r[11] || null, lookupTab: r[12] || null,
    lookupKeyCol: r[13] ? parseInt(r[13]) - 1 : null, lookupDateCol: r[14] ? parseInt(r[14]) - 1 : null,
    schedule: (r[15] || '1H').toString().toUpperCase().trim()
  };
  updateJobStatus(row, "🔄 Manual Test Running...");

  try {
    if (job.srcId === "CUSTOM_SCRIPT") {
      if (ALLOWED_SCRIPTS.includes(job.logic) && typeof this[job.logic] === "function") {
        this[job.logic]();
        updateJobStatus(row, "✅ Script Executed");
        Logger.log(`✅ SUCCESS: Custom Script "${job.logic}" executed perfectly!`);
      } else {
        throw new Error(`Function '${job.logic}' not found or blocked by security array.`);
      }
    } else {
      // ✅ FIX: Use JOB_RUNNERS router — same as runMasterSync
      let success;
      if (JOB_RUNNERS[job.logic]) {
        Logger.log(`🔗 Routing to dedicated runner for logic: ${job.logic}`);
        success = JOB_RUNNERS[job.logic](job, Date.now(), "MANUAL");
      } else {
        success = runHybridSync(job, Date.now(), "MANUAL", 0);
      }
      if (success) {
        updateJobStatus(row, "✅ Manual Test Success");
        Logger.log(`✅ SUCCESS: Data sync complete for ${job.name}!`);
      } else {
        updateJobStatus(row, "⏳ Manual Test - Relayed");
        Logger.log(`⚠️ TIME WARNING: The job was too large and returned false. It will relay correctly.`);
      }
    }
  } catch (e) {
    updateJobStatus(row, `❌ Error: ${e.message}`);
    Logger.log(`❌ JOB FAILED: ${e.message}`);
  }
}