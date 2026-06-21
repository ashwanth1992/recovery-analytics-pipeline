// ═══════════════════════════════════════════════════════════════════════════════
// Call_Agg.gs  —  Call Log Aggregation Engine
// Reads 1 Ozonetel + 3 TCN call log sheets, filters by alloc date, merges into
// a single destination tab. Runs in parallel with Dispo Agg. Post-processing
// fires only when BOTH engines complete (two-flag fence).
// ═══════════════════════════════════════════════════════════════════════════════

const CALL_AGG_PHASE_LABELS = {
  0: "Ozonetel calls read",
  1: "TCN Calls 1 read",
  2: "TCN Calls 2 read",
  3: "TCN Calls 3 read",
  4: "Anomaly scan"
};

const CALL_OUTPUT_HEADERS = [
  "lead_id", "phone_number", "call_timestamp",
  "talk_duration_sec", "source", "agent_name", "campaign_name"
];

// ── Ozonetel source column indices (0-based) ─────────────────────────────────
const OZ_COL = {
  uui:        2,
  campaign:   3,
  caller_id:  4,
  agent:      5,
  call_date:  6,
  start_time: 7,
  talk_time: 10,
};

// ── TCN source column indices (0-based) ──────────────────────────────────────
const TCN_CALL_COL = {
  loan_id:       0,
  mobile_no:     1,
  call_time:     3,
  process_name:  4,
  agent_name:    5,
  talk_duration: 7,
};

// ── Output column indices (0-based) ──────────────────────────────────────────
const OUT_COL = {
  lead_id:   0,
  phone:     1,
  timestamp: 2,
  talk_sec:  3,
  source:    4,
  agent:     5,
  campaign:  6,
};


// ─────────────────────────────────────────────────────────────────────────────
// MAIN TRIGGER  (run every 10 minutes)
// ─────────────────────────────────────────────────────────────────────────────

function triggerCallAggregation() {
  const p = PropertiesService.getScriptProperties();

  if (p.getProperty("CALL_AGG_PENDING") !== "true") return;

  const running = p.getProperty("CALL_AGG_RUNNING");
  if (running && (Date.now() - parseInt(running)) < 28 * 60 * 1000) {
    Logger.log(`⏳ [CALL_AGG] Already running since ${new Date(parseInt(running)).toLocaleTimeString()}. Skipping.`);
    return;
  }

  p.setProperty("CALL_AGG_RUNNING", Date.now().toString());

  try {
    let phase = parseInt(p.getProperty("CALL_AGG_PHASE") || "0");
    const startTime = Date.now();
    const HARD_STOP = 24 * 60 * 1000;

    Logger.log(`🚀 [CALL_AGG] Trigger fired. Resuming from phase ${phase}.`);

    // Build alloc map once per execution (rebuilt on each trigger if relayed)
    const allocMap = _buildCallAllocMap();
    if (!allocMap || allocMap.size === 0) {
      Logger.log(`⚠️ [CALL_AGG] Alloc map is empty. Aborting.`);
      _callAggReset(p);
      return;
    }
    Logger.log(`✅ [CALL_AGG] Allocation map: ${allocMap.size} leads.`);

    while (phase <= 4) {
      if (Date.now() - startTime > HARD_STOP) {
        Logger.log(`⏸️ [CALL_AGG] Hard stop before phase ${phase}. Will resume next trigger.`);
        p.setProperty("CALL_AGG_PHASE", phase.toString());
        p.deleteProperty("CALL_AGG_RUNNING");
        return;
      }

      Logger.log(`🚀 [CALL_AGG] Starting phase ${phase}: ${CALL_AGG_PHASE_LABELS[phase]}`);
      let done = false;

      switch (phase) {
        case 0: done = _callPhase_ReadOzonetel(allocMap, startTime, HARD_STOP); break;
        case 1: done = _callPhase_ReadTCN("TCN_CALLS_1", 1, allocMap, startTime, HARD_STOP); break;
        case 2: done = _callPhase_ReadTCN("TCN_CALLS_2", 2, allocMap, startTime, HARD_STOP); break;
        case 3: done = _callPhase_ReadTCN("TCN_CALLS_3", 3, allocMap, startTime, HARD_STOP); break;
        case 4: done = _callPhase_AnomalyScan(); break;
      }

      if (!done) {
        Logger.log(`⏸️ [CALL_AGG] Phase ${phase} incomplete. Will retry next trigger.`);
        p.setProperty("CALL_AGG_PHASE", phase.toString());
        p.deleteProperty("CALL_AGG_RUNNING");
        return;
      }

      Logger.log(`✅ [CALL_AGG] Phase ${phase} complete.`);
      phase++;
      p.setProperty("CALL_AGG_PHASE", phase.toString());
      p.deleteProperty("CALL_AGG_READ_ROW");
    }

    _callAggComplete(p);

  } catch(e) {
    Logger.log(`❌ [CALL_AGG] Fatal error: ${e.message}\n${e.stack}`);
    p.deleteProperty("CALL_AGG_RUNNING");
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION + RESET
// ─────────────────────────────────────────────────────────────────────────────

function _callAggComplete(p) {
  const startTs = parseInt(p.getProperty("CALL_AGG_START") || "0");
  const dur = startTs ? formatDuration(Date.now() - startTs) : "-";
  Logger.log(`✅ [CALL_AGG] All phases complete in ${dur}. Setting CALL_AGG_DONE.`);
  _logCallAggToSentinelHealth(dur);
  _callAggReset(p);
  p.setProperty("CALL_AGG_DONE", "true");
  _tryTriggerPostProcessing(p);
}

function _callAggReset(p) {
  ["CALL_AGG_PENDING", "CALL_AGG_RUNNING", "CALL_AGG_PHASE", "CALL_AGG_START", "CALL_AGG_READ_ROW"]
    .forEach(k => p.deleteProperty(k));
}


// ─────────────────────────────────────────────────────────────────────────────
// FENCE — PP fires only when BOTH dispo + call are done
// ─────────────────────────────────────────────────────────────────────────────

function _tryTriggerPostProcessing(p) {
  const dispoDone = p.getProperty("DISPO_AGG_DONE") === "true";
  const callDone  = p.getProperty("CALL_AGG_DONE")  === "true";

  if (dispoDone && callDone) {
    p.setProperty("POST_PROCESS_PENDING", "true");
    p.deleteProperty("POST_PROCESS_STEP");
    p.deleteProperty("DISPO_AGG_DONE");
    p.deleteProperty("CALL_AGG_DONE");
    Logger.log("✅ [FENCE] Both Dispo + Call Agg done. Post-processing queued.");
  } else {
    Logger.log(`⏳ [FENCE] Waiting — DISPO_AGG_DONE=${dispoDone}, CALL_AGG_DONE=${callDone}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// ALLOCATION MAP
// ─────────────────────────────────────────────────────────────────────────────

function _buildCallAllocMap() {
  // Identical source to dispo — reuse the same function
  return _buildDispoAllocMap();
}


// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0: OZONETEL (chunked read + chunked write + relay)
// ─────────────────────────────────────────────────────────────────────────────

function _callPhase_ReadOzonetel(allocMap, startMs, hardStop) {
  try {
    const p = PropertiesService.getScriptProperties();
    const allSources = loadPostSentinelConfig("Call_Merge");
    const src = allSources.find(s => s.key === "OZO_CALLS");
    const dst = allSources.find(s => s.key === "CALL_DESTINATION");

    if (!src) {
      Logger.log(`ℹ️ [CALL_AGG] OZO_CALLS not active today. Skipping phase 0.`);
      if (dst) _callAgg_ClearDestination(dst);
      return true;
    }
    if (!dst) { Logger.log(`❌ [CALL_AGG] CALL_DESTINATION not configured.`); return false; }

    // Resume from relay if mid-phase, else fresh phase 0 — clear destination
    let readRow = parseInt(p.getProperty("CALL_AGG_READ_ROW") || "2");
    if (readRow === 2) _callAgg_ClearDestination(dst);

    const srcSheet   = safeOpenById(src.ssId).getSheetByName(src.tabName);
    const srcLastRow = srcSheet ? srcSheet.getLastRow() : 0;
    if (srcLastRow < 2) {
      Logger.log(`ℹ️ [CALL_AGG] OZO_CALLS source empty. Skipping.`);
      p.deleteProperty("CALL_AGG_READ_ROW");
      return true;
    }

    const NUM_SRC_COLS = 11;
    const CHUNK = getOptimalBatchSize(srcLastRow, src.tabName, NUM_SRC_COLS).limit;
    const totalChunks = Math.ceil((srcLastRow - readRow + 1) / CHUNK);
    let chunkNum = 0;
    let totalRead = 0, filteredCount = 0;

    Logger.log(`📖 [CALL_AGG] Reading OZO_CALLS (${srcLastRow - 1} rows) from row ${readRow}...`);
    Logger.log(`   ├─ Chunk size: ${CHUNK.toLocaleString()} rows | Total chunks: ${totalChunks}`);

    const ozDateTracker = { rejected: 0, samples: [] };

    while (readRow <= srcLastRow) {
      if (Date.now() - startMs > hardStop) {
        p.setProperty("CALL_AGG_READ_ROW", readRow.toString());
        Logger.log(`⏳ [CALL_AGG] Yielding OZO at row ${readRow}. Resuming next trigger.`);
        return false;
      }

      chunkNum++;
      const end   = Math.min(readRow + CHUNK - 1, srcLastRow);
      Logger.log(`   ├─ Chunk ${chunkNum}/${totalChunks}: reading rows ${readRow.toLocaleString()}-${end.toLocaleString()}...`);

      const range = `'${src.tabName}'!A${readRow}:K${end}`;
      const chunk = safeGet(src.ssId, range);

      if (!chunk || chunk.length === 0) { readRow = end + 1; continue; }

      const filtered = [];
      for (const row of chunk) {
        const leadId = cleanId(row[OZ_COL.uui]);
        if (!leadId) continue;
        if (!allocMap.has(leadId)) continue;

      const callTs = _combineOZTimestamp(row[OZ_COL.call_date], row[OZ_COL.start_time], ozDateTracker);
        if (!callTs) continue;
        const allocDateMs = allocMap.get(leadId);
        if (allocDateMs > 0 && callTs < allocDateMs) continue;

        // 🚀 V8 OPTIMIZATION: Pure Math to Google Sheets Serial Number (+5.5 hrs IST shift)
        let rawDateNumber = "";
        if (callTs > 0) {
          const localMs = callTs + 19800000;
          rawDateNumber = (localMs / 86400000) + 25569;
        }

        filtered.push([
          leadId,
          cleanId(row[OZ_COL.caller_id]) || "",
          rawDateNumber,
          hhmmssToSec(row[OZ_COL.talk_time]),
          "OZO",
          String(row[OZ_COL.agent]    || "").trim(),
          String(row[OZ_COL.campaign] || "").trim(),
        ]);
      }

      // Append to destination
      if (filtered.length > 0) {
        const dstSheet = safeOpenById(dst.ssId).getSheetByName(dst.tabName);
        const writeRow = dstSheet.getLastRow() + 1;
        const dstMaxRows = dstSheet.getMaxRows();

  // Expand destination if write would exceed grid limit
  if (writeRow + filtered.length - 1 > dstMaxRows) {
    const needed = (writeRow + filtered.length - 1) - dstMaxRows + 10000;
    withExponentialBackoff(() => dstSheet.insertRowsAfter(dstMaxRows, needed));
    Logger.log(`📐 [CALL_AGG] Expanded destination by ${needed} rows (now ${dstMaxRows + needed})`);
  }

  safeUpdate(
    { values: filtered },
    dst.ssId,
    `'${dst.tabName}'!A${writeRow}:G${writeRow + filtered.length - 1}`,
    { valueInputOption: "RAW" }
  );
  filteredCount += filtered.length;
}

      totalRead += chunk.length;
      readRow    = end + 1;
    }

    // ── Date validation report ─────────────────────────────────────────
    if (ozDateTracker.rejected > 0) {
      const pct = totalRead > 0 
        ? ((ozDateTracker.rejected / totalRead) * 100).toFixed(1) 
        : "0";
      Logger.log(`⚠️ [CALL_AGG] OZO date validation: ${ozDateTracker.rejected} rows rejected (${pct}%) — samples: ${JSON.stringify(ozDateTracker.samples)}`);

      // Alert if >5% of rows have bad dates — likely a format issue
      if (ozDateTracker.rejected > totalRead * 0.05) {
        try {
          MailApp.sendEmail(
            ALERT_EMAIL,
            "⚠️ Finance Pipeline: OZO call_date format issue detected",
            `${ozDateTracker.rejected} of ${totalRead} OZO rows (${pct}%) had dates outside the valid window (90 days ago → 7 days future).\n\n` +
            `This usually means a date format change in the Ozonetel source sheet (e.g. DD/MM vs MM/DD vs YYYY-MM-DD).\n\n` +
            `Sample bad values:\n${JSON.stringify(ozDateTracker.samples, null, 2)}\n\n` +
            `Action: check the call_date column in OZO_CALLS source and update _combineOZTimestamp if needed.`
          );
          Logger.log(`📧 [CALL_AGG] Alert email sent for OZO date format issue.`);
        } catch(mailErr) {
          Logger.log(`⚠️ [CALL_AGG] Could not send alert email: ${mailErr.message}`);
        }
      }
    }

    p.deleteProperty("CALL_AGG_READ_ROW");
    Logger.log(`   ├─ Read: ${totalRead.toLocaleString()} | Matched: ${filteredCount.toLocaleString()} | Source: OZO`);
    return true;

  } catch(e) {
    Logger.log(`❌ [CALL_AGG] Phase 0 error: ${e.message}`);
    return false;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// PHASES 1-3: TCN CALLS (chunked read + chunked write + relay)
// ─────────────────────────────────────────────────────────────────────────────

function _callPhase_ReadTCN(key, phaseNum, allocMap, startMs, hardStop) {
  try {
    const p = PropertiesService.getScriptProperties();
    const allSources = loadPostSentinelConfig("Call_Merge");
    const src = allSources.find(s => s.key === key);
    const dst = allSources.find(s => s.key === "CALL_DESTINATION");

    if (!src) {
      Logger.log(`ℹ️ [CALL_AGG] Config key "${key}" not active today. Skipping phase ${phaseNum}.`);
      return true;
    }
    if (!dst) { Logger.log(`❌ [CALL_AGG] CALL_DESTINATION not configured.`); return false; }

    let readRow = parseInt(p.getProperty("CALL_AGG_READ_ROW") || "2");
    const srcSheet   = safeOpenById(src.ssId).getSheetByName(src.tabName);
    const srcLastRow = srcSheet ? srcSheet.getLastRow() : 0;
    if (srcLastRow < 2) {
      Logger.log(`ℹ️ [CALL_AGG] Source "${key}" is empty. Skipping.`);
      p.deleteProperty("CALL_AGG_READ_ROW");
      return true;
    }

    const NUM_SRC_COLS = 8;
    const CHUNK = getOptimalBatchSize(srcLastRow, src.tabName, NUM_SRC_COLS).limit;
    const totalChunks = Math.ceil((srcLastRow - readRow + 1) / CHUNK);
    let chunkNum = 0;
    let totalRead = 0, filteredCount = 0;

    Logger.log(`📖 [CALL_AGG] Reading "${key}" (${srcLastRow - 1} rows) from row ${readRow}...`);
    Logger.log(`   ├─ Chunk size: ${CHUNK.toLocaleString()} rows | Total chunks: ${totalChunks}`);

    while (readRow <= srcLastRow) {
      if (Date.now() - startMs > hardStop) {
        p.setProperty("CALL_AGG_READ_ROW", readRow.toString());
        Logger.log(`⏳ [CALL_AGG] Yielding ${key} at row ${readRow}. Resuming next trigger.`);
        return false;
      }

      chunkNum++;
      const end   = Math.min(readRow + CHUNK - 1, srcLastRow);
      Logger.log(`   ├─ Chunk ${chunkNum}/${totalChunks}: reading rows ${readRow.toLocaleString()}-${end.toLocaleString()}...`);

      const range = `'${src.tabName}'!A${readRow}:H${end}`;
      const chunk = safeGet(src.ssId, range);

      if (!chunk || chunk.length === 0) { readRow = end + 1; continue; }

      const filtered = [];
      for (const row of chunk) {
        const leadId = cleanId(row[TCN_CALL_COL.loan_id]);
        if (!leadId) continue;
        if (!allocMap.has(leadId)) continue;

      const callTs = parseTimestampToMs(row[TCN_CALL_COL.call_time]);
        if (!callTs) continue;
        const allocDateMs = allocMap.get(leadId);
        if (allocDateMs > 0 && callTs < allocDateMs) continue;

        // 🚀 V8 OPTIMIZATION: Pure Math to Google Sheets Serial Number (+5.5 hrs IST shift)
        let rawDateNumber = "";
        if (callTs > 0) {
          const localMs = callTs + 19800000;
          rawDateNumber = (localMs / 86400000) + 25569;
        }

        filtered.push([
          leadId,
          cleanId(row[TCN_CALL_COL.mobile_no]) || "",
          rawDateNumber,
          toNumber(row[TCN_CALL_COL.talk_duration]) || 0,
          "TCN",
          String(row[TCN_CALL_COL.agent_name]   || "").trim(),
          String(row[TCN_CALL_COL.process_name] || "").trim(),
        ]);
      }

     if (filtered.length > 0) {
  const dstSheet = safeOpenById(dst.ssId).getSheetByName(dst.tabName);
  const writeRow = dstSheet.getLastRow() + 1;
  const dstMaxRows = dstSheet.getMaxRows();

  // Expand destination if write would exceed grid limit
  if (writeRow + filtered.length - 1 > dstMaxRows) {
    const needed = (writeRow + filtered.length - 1) - dstMaxRows + 10000;
    withExponentialBackoff(() => dstSheet.insertRowsAfter(dstMaxRows, needed));
    Logger.log(`📐 [CALL_AGG] Expanded destination by ${needed} rows (now ${dstMaxRows + needed})`);
  }

  safeUpdate(
    { values: filtered },
    dst.ssId,
    `'${dst.tabName}'!A${writeRow}:G${writeRow + filtered.length - 1}`,
    { valueInputOption: "RAW" }
  );
  filteredCount += filtered.length;
}

      totalRead += chunk.length;
      readRow    = end + 1;
    }

    p.deleteProperty("CALL_AGG_READ_ROW");
    Logger.log(`   ├─ Read: ${totalRead.toLocaleString()} | Matched: ${filteredCount.toLocaleString()} | Source: TCN`);
    return true;

  } catch(e) {
    Logger.log(`❌ [CALL_AGG] Phase ${phaseNum} error: ${e.message}`);
    return false;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: CROSS-SOURCE ANOMALY SCAN
// ─────────────────────────────────────────────────────────────────────────────

function _callPhase_AnomalyScan() {
  try {
    const allSources = loadPostSentinelConfig("Call_Merge");
    const dst   = allSources.find(s => s.key === "CALL_DESTINATION");
    const audit = allSources.find(s => s.key === "CALL_AUDIT");

    if (!dst) return true;

    const dstSheet = safeOpenById(dst.ssId).getSheetByName(dst.tabName);
    const lastRow  = dstSheet ? dstSheet.getLastRow() : 0;

    if (lastRow < 2) {
      Logger.log(`ℹ️ [CALL_AGG] Destination empty. No anomaly scan needed.`);
      return true;
    }

    const data = withExponentialBackoff(() => dstSheet.getRange(2, 1, lastRow - 1, CALL_OUTPUT_HEADERS.length).getValues()
);

    const WINDOW_MS = 15 * 60 * 1000;

    // Group rows by lead_id
    const byLead = new Map();
    for (const row of data) {
      const leadId = cleanId(row[OUT_COL.lead_id]);
      if (!leadId) continue;
      if (!byLead.has(leadId)) byLead.set(leadId, []);
      byLead.get(leadId).push(row);
    }

    const anomalies = [];

    for (const [leadId, rows] of byLead) {
      const ozo = rows.filter(r => r[OUT_COL.source] === "OZO");
      const tcn = rows.filter(r => r[OUT_COL.source] === "TCN");
      if (!ozo.length || !tcn.length) continue; // no cross-source possible

      for (const oz of ozo) {
        const ozTs = parseTimestampToMs(oz[OUT_COL.timestamp]) || 0;
        for (const tc of tcn) {
          const tcTs = parseTimestampToMs(tc[OUT_COL.timestamp]) || 0;
          if (Math.abs(ozTs - tcTs) <= WINDOW_MS) {
            anomalies.push([
              leadId,
              oz[OUT_COL.timestamp], "OZO", oz[OUT_COL.agent],
              tc[OUT_COL.timestamp], "TCN", tc[OUT_COL.agent],
              "Cross-source within 15min"
            ]);
          }
        }
      }
    }

    Logger.log(`🔍 [CALL_AGG] Anomaly scan complete: ${anomalies.length} cross-source overlap(s) found.`);

    if (audit && anomalies.length > 0) {
      const auditSheet = safeOpenById(audit.ssId).getSheetByName(audit.tabName);
      if (auditSheet) {
        auditSheet.clearContents();
        const headers = [
          "lead_id",
          "oz_timestamp", "oz_source", "oz_agent",
          "tcn_timestamp","tcn_source","tcn_agent",
          "reason"
        ];
        auditSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        if (anomalies.length > 0) {
          auditSheet.getRange(2, 1, anomalies.length, headers.length).setValues(anomalies);
        }
      }
    }

    return true;

  } catch(e) {
    Logger.log(`❌ [CALL_AGG] Phase 4 (anomaly scan) error: ${e.message}`);
    return false;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Convert HH:MM:SS (or MM:SS, or already-numeric) to integer seconds */
function hhmmssToSec(val) {
  if (!val) return 0;
  const str = String(val).trim();
  if (!str.includes(":")) return toNumber(val) || 0; // already numeric
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return 0;
}

/** Combine Ozonetel's separate call_date + start_time into a ms timestamp */

function _combineOZTimestamp(callDate, startTime, tracker) {
  if (!callDate) return null;
  try {
    const datePart = callDate instanceof Date
      ? Utilities.formatDate(callDate, GLOBAL_TZ, "yyyy-MM-dd")
      : String(callDate).trim().substring(0, 10);
    const timePart = String(startTime || "00:00:00").trim();
    const combined = parseTimestampToMs(`${datePart} ${timePart}`);
    if (!combined) return null;

    // Smart date window: reject if date is > 90 days old or > 7 days future
    if (tracker) {
      const now = Date.now();
      const tooOld    = now - (90 * 24 * 60 * 60 * 1000);
      const tooFuture = now + (7  * 24 * 60 * 60 * 1000);

      if (combined < tooOld || combined > tooFuture) {
        tracker.rejected++;
        if (tracker.samples.length < 5) {
          tracker.samples.push({
            raw_date:  String(callDate),
            raw_time:  String(startTime),
            parsed_as: Utilities.formatDate(new Date(combined), GLOBAL_TZ, "dd-MMM-yyyy HH:mm:ss")
          });
        }
        return null; // reject the row
      }
    }

    return combined;
  } catch(e) {
    return null;
  }
}

/** Clear destination tab rows (keep header row 1) */
function _callAgg_ClearDestination(dst) {
  try {
    const dstSheet = safeOpenById(dst.ssId).getSheetByName(dst.tabName);
    if (!dstSheet) return;
    if (dstSheet.getLastRow() > 1) {
      withExponentialBackoff(() => dstSheet.getRange(2, 1, dstSheet.getLastRow() - 1, dstSheet.getLastColumn()).clearContent()
);
    }
    // Write headers
    withExponentialBackoff(() => dstSheet.getRange(1, 1, 1, CALL_OUTPUT_HEADERS.length).setValues([CALL_OUTPUT_HEADERS])
);
    Logger.log(`🧹 [CALL_AGG] Destination cleared for fresh run.`);
  } catch(e) {
    Logger.log(`⚠️ [CALL_AGG] Could not clear destination: ${e.message}`);
  }
}

/** Log completion to Sentinel_Health */
function _logCallAggToSentinelHealth(duration) {
  try {
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName("Sentinel_Health");
    if (!sheet) return;
    sheet.insertRowAfter(7);
    sheet.getRange(8, 1).setNumberFormat("@");
    const range = sheet.getRange(8, 1, 1, 6);
    range.setValues([[
      Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss"),
      "CALL", duration, "✅ Call aggregation complete", "", ""
    ]]);
    range.setBackground("#e6f4ea")
         .setFontColor("#000000")
         .setFontWeight("normal")
         .setFontStyle("normal")
         .setFontSize(10)
         .setBorder(null, null, true, null, null, null, "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID);
  } catch(e) {
    Logger.log(`⚠️ [CALL_AGG] Could not log to Sentinel_Health: ${e.message}`);
  }
}

function manualRunCallAgg() {
  const p = PropertiesService.getScriptProperties();

  // Clear any stale state from a previous run
  _callAggReset(p);
  p.deleteProperty("CALL_AGG_DONE");

  // Set up for a fresh run from phase 0
  p.setProperty("CALL_AGG_PENDING", "true");
  p.setProperty("CALL_AGG_PHASE",   "0");
  p.setProperty("CALL_AGG_START",   Date.now().toString());

  // Set DISPO_AGG_DONE so the fence doesn't block PP during manual testing
  p.setProperty("DISPO_AGG_DONE", "true");

  Logger.log("🔄 [CALL_AGG] Manual reset complete. Starting run...");
  triggerCallAggregation();
}