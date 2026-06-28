/**
 * ==============================================================================
 * POST-SENTINEL ENGINE
 * ==============================================================================
 * Handles all processing that runs AFTER the Sentinel pipeline completes.
 *
 * CHAIN (triggered by 1H Sentinel completion):
 *   triggerSentinel (1H) → sets DISPO_AGG_PENDING
 *       ↓
 *   triggerDispoAggregation (every 10 min)
 *     Dynamically reads all active "Dispo_Merge" rows from Post_Sentinel tab,
 *     in config order. Adding a new source = add a row, no code change needed.
 *     Final step: dedup + write to DESTINATION
 *       ↓ sets POST_PROCESS_PENDING
 *   triggerPostProcessing (every 5 min) — unchanged
 *
 * CONFIG:
 *   All sheet IDs for sources and destinations live in the "Post_Sentinel" tab
 *   of the Control Center sheet. Read via loadPostSentinelConfig(functionName).
 *
 * TABS IN CONTROL CENTER (created by setupPostSentinelTab):
 *   Post_Sentinel  — config store for all post-sentinel functions
 *   Dispo_Temp     — intermediate storage during aggregation (cleared each run)
 *   Dispo_Audit    — anomaly log (Rule 2b: PB-only, Rule 4: conflicting outcomes)
 * ==============================================================================
 */


// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const POST_SENTINEL_TAB  = "Post_Sentinel";
const DISPO_TEMP_TAB     = "Dispo_Temp";
const DISPO_AUDIT_TAB    = "Dispo_Audit";

// 15-minute window in ms for cross-source dedup
const DISPO_DEDUP_WINDOW_MS = 15 * 60 * 1000;

// Resume sentinel values stored in DISPO_AGG_SOURCE_KEY
const DISPO_STAGE_DEDUP = "__DEDUP__";

// Output columns written to destination and Dispo_Temp
// Normalized from both PB and TCN schemas
const DISPO_OUTPUT_HEADERS = [
  "mx_collection_lead_id",  // A
  "pb_calling_status",      // B
  "call_dialled_on",        // C
  "agent_name",             // D
  "campaign_name",          // E
  "source"                  // F
];


// ─── CONFIG READER ────────────────────────────────────────────────────────────

/**
 * Reads the Post_Sentinel tab and returns config entries for a given function,
 * filtered by the current day of month against each entry's Date Range.
 *
 * @param {string} functionName - e.g. "Dispo_Merge", "Post_Processing"
 * @returns {Array} Array of { key, ssId, tabName, dateRange, notes }
 */
function loadPostSentinelConfig(functionName) {
  try {
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(POST_SENTINEL_TAB);
    if (!sheet) {
      Logger.log(`❌ [POST_SENTINEL] Tab "${POST_SENTINEL_TAB}" not found in Control Center.`);
      return [];
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    // Read all 7 cols: Function | Config Key | Sheet ID | Tab Name | Date Range | Active | Notes
    const data  = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    const today = parseInt(Utilities.formatDate(new Date(), GLOBAL_TZ, "d"));
    const result = [];

    for (const r of data) {
      const fn        = String(r[0] || "").trim();
      const key       = String(r[1] || "").trim();
      const ssId      = String(r[2] || "").trim();
      const tabName   = String(r[3] || "").trim();
      const dateRange = String(r[4] || "").trim();
      const active    = r[5] === true;
      const notes     = String(r[6] || "").trim();

      if (!active || fn !== functionName || !key || !ssId) continue;

      // Date range filter — blank means always active
      if (dateRange) {
        const parts = dateRange.split("-").map(Number);
        const from  = parts[0] || 1;
        if (today < from) continue;  // cumulative — active once today >= from
      }

      result.push({ key, ssId, tabName, dateRange, notes });
    }

    return result;
  } catch(e) {
    Logger.log(`❌ loadPostSentinelConfig error: ${e.message}`);
    return [];
  }
}


// ─── CRON ENTRY POINT ─────────────────────────────────────────────────────────

/**
 * Called by a time-based trigger every 10 minutes.
 * Dynamically iterates all active Dispo_Merge sources from the Post_Sentinel
 * config tab. Resume state is stored as the config key of the current source
 * (DISPO_AGG_SOURCE_KEY) rather than a hardcoded phase number — adding or
 * removing source sheets requires no code change.
 */
function triggerDispoAggregation() {
  const p = PropertiesService.getScriptProperties();

  if (p.getProperty("DISPO_AGG_PENDING") !== "true") {
    Logger.log("💤 [DISPO_AGG] No aggregation pending. Skipping.");
    return;
  }

  const runningTs = p.getProperty("DISPO_AGG_RUNNING");
  if (runningTs) {
    const ageMs = Date.now() - parseInt(runningTs);
    if (ageMs < 28 * 60 * 1000) {
      Logger.log(`⏭️ [DISPO_AGG] Instance running since ${Math.round(ageMs/60000)}m ago. Skipping.`);
      return;
    }
    Logger.log(`⚠️ [DISPO_AGG] Stale DISPO_AGG_RUNNING (${Math.round(ageMs/60000)}m). Clearing and proceeding.`);
  }

  p.setProperty("DISPO_AGG_RUNNING", Date.now().toString());

  const startMs  = Date.now();
  const hardStop = MAX_EXECUTION_TIME_MS - 60000;

  try {
    const currentKey = p.getProperty("DISPO_AGG_SOURCE_KEY");
    const freshStart = !currentKey;

    // ── Stage 1: Read all active sources into Dispo_Temp ──────────────────
    if (currentKey !== DISPO_STAGE_DEDUP) {
      const sources = loadPostSentinelConfig("Dispo_Merge")
        .filter(s => s.key !== "DESTINATION");

      if (sources.length === 0) {
        Logger.log("⚠️ [DISPO_AGG] No active Dispo_Merge sources in Post_Sentinel tab. Aborting.");
        _dispoAggReset(p);
        return;
      }

      if (freshStart) {
        p.setProperty("DISPO_AGG_START", Date.now().toString());
        const tempSheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(DISPO_TEMP_TAB);
        if (tempSheet && tempSheet.getLastRow() > 1) {
          safeClear(CONTROL_CENTER_ID, `${DISPO_TEMP_TAB}!A2:F${tempSheet.getLastRow()}`);
        }
        Logger.log(`🧹 [DISPO_AGG] Dispo_Temp cleared for fresh run.`);
      }

      const allocMap = _buildDispoAllocMap();
      if (allocMap.size === 0) {
        Logger.log(`⚠️ [DISPO_AGG] Allocation map empty. Aborting.`);
        _dispoAggReset(p);
        return;
      }
      Logger.log(`✅ [DISPO_AGG] Allocation map: ${allocMap.size} leads. ${sources.length} source(s) active.`);

      let startIdx = 0;
      if (currentKey) {
        const idx = sources.findIndex(s => s.key === currentKey);
        startIdx = idx !== -1 ? idx : 0;
      }

      for (let i = startIdx; i < sources.length; i++) {
        const src = sources[i];
        p.setProperty("DISPO_AGG_SOURCE_KEY", src.key);
        Logger.log(`🚀 [DISPO_AGG] Source ${i + 1}/${sources.length}: "${src.key}"...`);

        const done = _dispoPhase_ReadSource(src, allocMap, startMs, hardStop);
        if (!done) {
          p.deleteProperty("DISPO_AGG_RUNNING");
          Logger.log(`⏳ [DISPO_AGG] "${src.key}" yielded. Resuming next trigger.`);
          return;
        }

        p.deleteProperty("DISPO_AGG_READ_ROW");
        Logger.log(`✅ [DISPO_AGG] "${src.key}" complete.`);
      }

      p.setProperty("DISPO_AGG_SOURCE_KEY", DISPO_STAGE_DEDUP);
    }

    // ── Stage 2: Dedup + write destination ────────────────────────────────
    Logger.log(`🚀 [DISPO_AGG] Starting dedup + write...`);
    if (!_dispoPhase_DedupAndWrite(startMs, hardStop)) {
      p.deleteProperty("DISPO_AGG_RUNNING");
      Logger.log(`⏳ [DISPO_AGG] Dedup yielded. Resuming next trigger.`);
      return;
    }

    _dispoAggComplete(p);

  } catch(e) {
    Logger.log(`❌ [DISPO_AGG] Error: ${e.message}\n${e.stack}`);
    p.deleteProperty("DISPO_AGG_RUNNING");
  }
}


// ─── SOURCE READER: FILTER + APPEND TO DISPO_TEMP ────────────────────────────

/**
 * Reads one TCN dispo source sheet, filters to allocated leads after their
 * allocation date, and appends matching rows to Dispo_Temp.
 *
 * Called dynamically for each active Dispo_Merge source in config order.
 * Clearing of Dispo_Temp and alloc map building are handled by the caller.
 *
 * @param {Object} src       - Config entry { key, ssId, tabName, ... }
 * @param {Map}    allocMap  - leadId → allocDateMs, built once per trigger run
 * @param {number} startMs   - Execution start time ms
 * @param {number} hardStop  - Max execution ms before yielding
 * @returns {boolean}        - true if complete, false if yielded
 */
function _dispoPhase_ReadSource(src, allocMap, startMs, hardStop) {
  const p = PropertiesService.getScriptProperties();

  const srcSheet = safeOpenById(src.ssId).getSheetByName(src.tabName);
  if (!srcSheet) {
    Logger.log(`❌ [DISPO_AGG] Source tab "${src.tabName}" not found for key "${src.key}".`);
    return true;
  }
  const srcLastRow = srcSheet.getLastRow();
  if (srcLastRow < 2) {
    Logger.log(`ℹ️ [DISPO_AGG] Source "${src.key}" is empty. Skipping.`);
    return true;
  }

  const headers = safeGet(src.ssId, `${src.tabName}!1:1`);
  if (!headers || !headers[0]) {
    Logger.log(`❌ [DISPO_AGG] Could not read headers for "${src.key}".`);
    return true;
  }

  const hdr = headers[0].map(h => String(h || "").trim().toLowerCase());

  const colLeadId             = hdr.indexOf("mx_collection_lead_id");
  const colTimestampPrimary   = hdr.indexOf("cld_created_on");
  const colTimestampSecondary = hdr.indexOf("created_at");
  const colOutcome            = hdr.indexOf("pb_calling_status");
  const colAgent              = hdr.indexOf("tcn_agent_first_name");
  const colCampaign           = hdr.indexOf("tcn_process_name");

  if (colLeadId === -1 || (colTimestampPrimary === -1 && colTimestampSecondary === -1) || colOutcome === -1) {
    Logger.log(`❌ [DISPO_AGG] Required columns not found in "${src.key}". Headers: ${hdr.join(", ")}`);
    return true;
  }

  const numCols      = hdr.length;
  const CHUNK        = getOptimalBatchSize(srcLastRow, src.tabName, numCols).limit;
  let readRow        = parseInt(p.getProperty("DISPO_AGG_READ_ROW") || "2");
  let tempWriteRow   = _getDispoTempLastRow() + 1;
  const tempSheetObj = safeOpenById(CONTROL_CENTER_ID).getSheetByName(DISPO_TEMP_TAB);
  let tempMaxRows    = tempSheetObj.getMaxRows();
  let filteredCount  = 0;
  let totalRead      = 0;

  Logger.log(`📖 [DISPO_AGG] Reading "${src.key}" (${srcLastRow - 1} rows) from row ${readRow}...`);

  while (readRow <= srcLastRow) {
    if (Date.now() - startMs > hardStop) {
      p.setProperty("DISPO_AGG_READ_ROW", readRow.toString());
      Logger.log(`⏳ [DISPO_AGG] Yielding "${src.key}" at row ${readRow}.`);
      return false;
    }

    const end   = Math.min(readRow + CHUNK - 1, srcLastRow);
    const chunk = safeGet(src.ssId, `${src.tabName}!A${readRow}:${columnToLetter(numCols)}${end}`);

    if (!chunk || chunk.length === 0) { readRow = end + 1; continue; }

    const filtered = [];
    for (const row of chunk) {
      const leadId = cleanId(row[colLeadId]);
      if (!leadId || !allocMap.has(leadId)) continue;

      const allocDateMs = allocMap.get(leadId);
      const rawTs = (colTimestampPrimary >= 0 && row[colTimestampPrimary] !== "" && row[colTimestampPrimary] !== null && row[colTimestampPrimary] !== undefined)
        ? row[colTimestampPrimary]
        : row[colTimestampSecondary];
      const callTs = parseTimestampToMs(rawTs);
      if (!callTs || callTs < allocDateMs) continue;

      filtered.push([
        leadId,
        callTs,
        String(row[colOutcome]  || "").trim(),
        String(colAgent    >= 0 ? row[colAgent]    : "").trim(),
        String(colCampaign >= 0 ? row[colCampaign] : "").trim(),
        "TCN"
      ]);
    }

    if (filtered.length > 0) {
      if (tempWriteRow + filtered.length - 1 > tempMaxRows) {
        const needed = (tempWriteRow + filtered.length - 1) - tempMaxRows + 10000;
        tempSheetObj.insertRowsAfter(tempMaxRows, needed);
        tempMaxRows += needed;
        Logger.log(`📐 [DISPO_AGG] Expanded Dispo_Temp by ${needed} rows (now ${tempMaxRows})`);
      }
      safeUpdate(
        { values: filtered },
        CONTROL_CENTER_ID,
        `${DISPO_TEMP_TAB}!A${tempWriteRow}:F${tempWriteRow + filtered.length - 1}`,
        { valueInputOption: "RAW" }
      );
      tempWriteRow  += filtered.length;
      filteredCount += filtered.length;
    }

    totalRead += chunk.length;
    readRow    = end + 1;
  }

  Logger.log(`   ├─ Read: ${totalRead.toLocaleString('en-IN')} | Matched: ${filteredCount.toLocaleString('en-IN')} | Source: TCN`);
  return true;
}


// ─── PHASE 4: DEDUP + WRITE DESTINATION ──────────────────────────────────────

/**
 * Reads all filtered rows from Dispo_Temp, applies dedup rules,
 * writes clean output to the destination sheet, and writes anomalies to Dispo_Audit.
 */
function _dispoPhase_DedupAndWrite(startMs, hardStop) {
  const p = PropertiesService.getScriptProperties();

  // Load destination config
  const allConfig = loadPostSentinelConfig("Dispo_Merge");
  const destConfig = allConfig.find(s => s.key === "DESTINATION");
  if (!destConfig) {
    Logger.log(`❌ [DISPO_AGG] DESTINATION config not found in Post_Sentinel tab.`);
    return true; // don't block chain
  }

  // Read all temp data
  const tempSheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(DISPO_TEMP_TAB);
  if (!tempSheet || tempSheet.getLastRow() < 2) {
    Logger.log(`ℹ️ [DISPO_AGG] Dispo_Temp is empty. Nothing to dedup.`);
    return true;
  }

  const tempLastRow = tempSheet.getLastRow();
  const CHUNK       = getOptimalBatchSize(tempLastRow, DISPO_TEMP_TAB, 6).limit;
  const allRows     = [];

  Logger.log(`🔀 [DISPO_AGG] Reading Dispo_Temp (${tempLastRow - 1} filtered rows) for dedup...`);

  // Read Dispo_Temp in chunks (it's in Control Center, small-ish)
  for (let r = 2; r <= tempLastRow; r += CHUNK) {
    const end   = Math.min(r + CHUNK - 1, tempLastRow);
    const chunk = safeGet(CONTROL_CENTER_ID, `${DISPO_TEMP_TAB}!A${r}:F${end}`);
    if (chunk) chunk.forEach(row => {
      // 🚀 V8 OPTIMIZATION: It's already milliseconds, no parsing needed!
      const tsMs = Number(row[1]) || 0; 
      allRows.push([row[0], tsMs, row[2], row[3], row[4], row[5]]);
    });
  }

  Logger.log(`   ├─ Loaded ${allRows.length.toLocaleString('en-IN')} rows into RAM for dedup`);

  // Group by lead ID
  const byLead = new Map(); // leadId → [rows]
  for (const row of allRows) {
    const id = String(row[0] || "").trim();
    if (!id) continue;
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(row);
  }

  // Apply dedup rules
  const output    = []; // final rows to write
  const anomaly2b = []; // PB only — no TCN within 15 min
  const anomaly4  = []; // conflicting outcomes within 15 min

  for (const [leadId, entries] of byLead) {
    // Sort by timestamp ascending
    entries.sort((a, b) => (a[1] || 0) - (b[1] || 0));

    const kept = _deduplicateLeadEntries(leadId, entries, anomaly2b, anomaly4);
    kept.forEach(r => output.push(r));
  }

  Logger.log(`   ├─ After dedup: ${output.length.toLocaleString('en-IN')} rows`);
  Logger.log(`   ├─ Anomaly 2b (PB only): ${anomaly2b.length}`);
  Logger.log(`   ├─ Anomaly 4  (conflicts): ${anomaly4.length}`);

  // Hash check — skip write if output unchanged
  const outputHash = md5Hash(output);
  const storedHash = p.getProperty("H_DISPO_MERGE_OUTPUT");
  if (storedHash && storedHash === outputHash) {
    Logger.log(`⏭️ [DISPO_AGG] Output unchanged (hash match). Skipping destination write.`);
    _writeDispoAudit(anomaly2b, anomaly4);
    return true;
  }

  // Write to destination
  Logger.log(`📝 [DISPO_AGG] Writing ${output.length.toLocaleString('en-IN')} rows to destination...`);
  const dstSheet = safeOpenById(destConfig.ssId).getSheetByName(destConfig.tabName);
  if (!dstSheet) {
    Logger.log(`❌ [DISPO_AGG] Destination tab "${destConfig.tabName}" not found.`);
    return true;
  }

  // ── EXPAND destination if output exceeds grid limits ──────────────────────
  const dstMaxRows = dstSheet.getMaxRows();
  if (output.length + 1 > dstMaxRows) {
    const needed = output.length + 1 - dstMaxRows + 10000;
    withExponentialBackoff(() => dstSheet.insertRowsAfter(dstMaxRows, needed));
    Logger.log(`📐 [DISPO_AGG] Expanded destination by ${needed} rows (now ${dstMaxRows + needed})`);
  }

  // Clear destination and write headers
  const dstLastRow = dstSheet.getLastRow();
  if (dstLastRow > 1) safeClear(destConfig.ssId, `${destConfig.tabName}!A2:F${dstLastRow}`);
  safeUpdate(
    { values: [DISPO_OUTPUT_HEADERS] },
    destConfig.ssId,
    `${destConfig.tabName}!A1:F1`,
    { valueInputOption: "USER_ENTERED" }
  );

  // Write output in chunks — convert ms timestamps to formatted dates for readability
  const WRITE_CHUNK = getOptimalBatchSize(output.length, destConfig.tabName, 6).limit;
  for (let w = 0; w < output.length; w += WRITE_CHUNK) {
    const chunk = output.slice(w, w + WRITE_CHUNK).map(r => {
      // 🚀 V8 OPTIMIZATION: Pure Math to Google Sheets Serial Number (+5.5 hrs IST shift)
      let rawDateNumber = "";
      if (r[1]) {
        const localMs = r[1] + 19800000;
        rawDateNumber = (localMs / 86400000) + 25569;
      }

      return [
        r[0],           // lead ID
        r[2],           // outcome
        rawDateNumber,  // native sheets serial date
        r[3],           // agent
        r[4],           // campaign
        r[5]            // source
      ];
    });
    safeUpdate(
      { values: chunk },
      destConfig.ssId,
      `${destConfig.tabName}!A${2 + w}:F${2 + w + chunk.length - 1}`,
      { valueInputOption: "USER_ENTERED" }
    );
  }

  // Store hash + write audit
  p.setProperty("H_DISPO_MERGE_OUTPUT", outputHash);
  _writeDispoAudit(anomaly2b, anomaly4);

  Logger.log(`✅ [DISPO_AGG] Destination write complete.`);
  return true;
}


// ─── PHASE 5: FILTERED DISPO → 0BKT INPUT ────────────────────────────────────

/**
 * Runs the Filtered_Dispo_to_0bkt_input job directly.
 * This job was previously in Sentinel — now runs here after dedup completes.
 */
function _dispoPhase_FilteredDispoToInput() {
  try {
    const allJobs = loadSystemConfig();
    const job = allJobs.find(j => j.name.includes("Filtered_Dispo_to_0bkt_input") ||
                                   j.name.replace(/\[SKIP\]\s*/i, "").trim() === "Filtered_Dispo_to_0bkt_input");
    if (!job) {
      Logger.log(`⚠️ [DISPO_AGG] Filtered_Dispo_to_0bkt_input not found in Routing_Config.`);
      return true;
    }

    // Temporarily clear [SKIP] in memory only — don't write back
    const activeJob = { ...job, name: job.name.replace(/\[SKIP\]\s*/i, "").trim() };

    // Force reset hashes so it re-evaluates the newly merged dispo data
    const p = PropertiesService.getScriptProperties();
    p.getKeys()
     .filter(k => k.startsWith(`H_${activeJob.name}_`) || k.startsWith(`R_${activeJob.name}`))
     .forEach(k => p.deleteProperty(k));

    const result = runHybridSync(activeJob, Date.now(), "POST_SENTINEL", 0);
    Logger.log(`✅ [DISPO_AGG] Filtered_Dispo_to_0bkt_input: ${result ? "complete" : "relayed"}`);
    return true; // Always advance — relay for this sub-job not needed at phase level
  } catch(e) {
    Logger.log(`❌ [DISPO_AGG] Phase 5 error: ${e.message}`);
    return true; // Don't block post-processing
  }
}


// ─── DEDUP LOGIC ─────────────────────────────────────────────────────────────

/**
 * Applies dedup rules to a single lead's sorted entries.
 *
 * Rules:
 *   Rule 1: TCN beats PB within 15 min (TCN is primary for predictive campaigns)
 *   Rule 2a: TCN with no PB within ±15 min → keep TCN
 *   Rule 2b: PB with no TCN within ±15 min → keep PB, log as anomaly
 *   Rule 3: Same-source duplicates within 15 min → keep later timestamp
 *   Rule 4: Conflicting outcomes (PB+TCN within 15 min, different outcomes) → keep both, log
 *
 * @param {string} leadId
 * @param {Array}  entries  - Sorted ascending by timestamp (ms at index 1)
 * @param {Array}  anomaly2b - Accumulator for Rule 2b anomalies
 * @param {Array}  anomaly4  - Accumulator for Rule 4 conflicts
 * @returns {Array} Deduplicated entries for this lead
 */
function _deduplicateLeadEntries(leadId, entries, anomaly2b, anomaly4) {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    // Single entry — log if PB-only (Rule 2b)
    if (entries[0][5] === "PB") {
      anomaly2b.push({ leadId, ts: entries[0][1], outcome: entries[0][2], agent: entries[0][3] });
    }
    return entries;
  }

  const kept     = [];
  const consumed = new Set(); // indices of entries already handled

  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(i)) continue;

    const eI    = entries[i];
    const tsI   = eI[1];   // ms
    const srcI  = eI[5];   // "PB" or "TCN"

    // Find all entries within 15-min window of eI
    const windowGroup = [{ idx: i, entry: eI }];
    for (let j = i + 1; j < entries.length; j++) {
      if (consumed.has(j)) continue;
      const tsJ = entries[j][1];
      if (Math.abs(tsJ - tsI) <= DISPO_DEDUP_WINDOW_MS) {
        windowGroup.push({ idx: j, entry: entries[j] });
      }
    }

    if (windowGroup.length === 1) {
      // No partner within 15 min
      if (srcI === "PB") {
        // Rule 2b: PB only → keep but log anomaly
        anomaly2b.push({ leadId, ts: tsI, outcome: eI[2], agent: eI[3] });
      }
      // Rule 2a: TCN only → keep silently
      kept.push(eI);
      consumed.add(i);
      continue;
    }

    // Multiple entries in window — apply dedup
    const pbEntries  = windowGroup.filter(g => g.entry[5] === "PB");
    const tcnEntries = windowGroup.filter(g => g.entry[5] === "TCN");

    // Rule 3: Same-source duplicates → keep latest
    const bestPb  = pbEntries.length  > 0 ? pbEntries.reduce((a, b)  => b.entry[1] > a.entry[1] ? b : a) : null;
    const bestTcn = tcnEntries.length > 0 ? tcnEntries.reduce((a, b) => b.entry[1] > a.entry[1] ? b : a) : null;

    if (bestPb && bestTcn) {
      // Both PB and TCN present in window
      if (bestPb.entry[2] === bestTcn.entry[2]) {
        // Same outcome → Rule 1: TCN wins
        kept.push(bestTcn.entry);
      } else {
        // Different outcomes → Rule 4: keep both, log conflict
        anomaly4.push({
          leadId,
          pbTs:      bestPb.entry[1],  pbOutcome:  bestPb.entry[2],  pbAgent:  bestPb.entry[3],
          tcnTs:     bestTcn.entry[1], tcnOutcome: bestTcn.entry[2], tcnAgent: bestTcn.entry[3]
        });
        kept.push(bestTcn.entry);
        kept.push(bestPb.entry);
      }
    } else if (bestTcn) {
      // TCN only (after same-source dedup) — Rule 2a
      kept.push(bestTcn.entry);
    } else if (bestPb) {
      // PB only (after same-source dedup) — Rule 2b
      anomaly2b.push({ leadId, ts: bestPb.entry[1], outcome: bestPb.entry[2], agent: bestPb.entry[3] });
      kept.push(bestPb.entry);
    }

    // Mark all window group entries as consumed
    windowGroup.forEach(g => consumed.add(g.idx));
  }

  return kept;
}


// ─── AUDIT WRITER ─────────────────────────────────────────────────────────────

function _writeDispoAudit(anomaly2b, anomaly4) {
  try {
    const cc    = safeOpenById(CONTROL_CENTER_ID);
    let audit   = cc.getSheetByName(DISPO_AUDIT_TAB);
    if (!audit) audit = cc.insertSheet(DISPO_AUDIT_TAB);
    audit.clearContents();

    const ts  = Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM/yyyy HH:mm:ss");
    const rows = [[`Dispo Audit — Generated: ${ts}`], []];

    // Rule 2b section
    rows.push([`RULE 2b: PB-Only Entries (no TCN within 15 min) — ${anomaly2b.length} leads`]);
    rows.push(["Lead ID", "Call Timestamp", "PB Outcome", "PB Agent"]);
    for (const a of anomaly2b) {
      rows.push([
        a.leadId,
        a.ts ? Utilities.formatDate(new Date(a.ts), GLOBAL_TZ, "dd-MMM-yyyy HH:mm:ss") : "",
        a.outcome,
        a.agent
      ]);
    }

    rows.push([]);
    // Rule 4 section
    rows.push([`RULE 4: Conflicting Outcomes (PB+TCN within 15 min, different outcome) — ${anomaly4.length} cases`]);
    rows.push(["Lead ID", "PB Timestamp", "PB Outcome", "PB Agent", "TCN Timestamp", "TCN Outcome", "TCN Agent"]);
    for (const a of anomaly4) {
      rows.push([
        a.leadId,
        a.pbTs  ? Utilities.formatDate(new Date(a.pbTs),  GLOBAL_TZ, "dd-MMM-yyyy HH:mm:ss") : "",
        a.pbOutcome,  a.pbAgent,
        a.tcnTs ? Utilities.formatDate(new Date(a.tcnTs), GLOBAL_TZ, "dd-MMM-yyyy HH:mm:ss") : "",
        a.tcnOutcome, a.tcnAgent
      ]);
    }

    // Use 1 column for title/section header rows, pad others to 7
  const paddedRows = rows.map(r => {
  if (r.length === 0) return ["","","","","","",""];
  while (r.length < 7) r.push("");
  return r;
});
audit.getRange(1, 1, paddedRows.length, 7).setValues(paddedRows);
    Logger.log(`📋 [DISPO_AGG] Audit tab written — 2b: ${anomaly2b.length}, Rule 4: ${anomaly4.length}`);
  } catch(e) {
    Logger.log(`⚠️ Could not write audit tab: ${e.message}`);
  }
}


// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Builds Map<leadId, allocDateMs> from the same lookup source that
 * PB_Dispo_Filteration uses — reads lookupId/lookupTab/lookupKeyCol/lookupDateCol
 * from that job's Routing_Config row so config changes automatically propagate.
 *
 * Returns Map<leadId, allocDateMs> where allocDateMs is the date the lead
 * was allocated to the bounce/penal collection process.
 */
function _buildDispoAllocMap() {
  try {
    const allJobs = loadSystemConfig();

    // Find PB_Dispo_Filteration (may be [SKIP] prefixed now)
    const filterJob = allJobs.find(j =>
      j.name.replace(/\[SKIP\]\s*/i, "").trim() === "PB_Dispo_Filteration"
    );

    if (!filterJob) {
      Logger.log("⚠️ [DISPO_AGG] PB_Dispo_Filteration not found in Routing_Config.");
      return new Map();
    }
    if (!filterJob.lookupId || !filterJob.lookupTab) {
      Logger.log("⚠️ [DISPO_AGG] PB_Dispo_Filteration has no lookup config (lookupId/lookupTab missing).");
      return new Map();
    }

    const sheet   = safeOpenById(filterJob.lookupId).getSheetByName(filterJob.lookupTab);
    if (!sheet) {
      Logger.log(`⚠️ [DISPO_AGG] Lookup tab "${filterJob.lookupTab}" not found.`);
      return new Map();
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return new Map();

    // Determine which columns to read
    const keyCol  = filterJob.lookupKeyCol  !== null ? filterJob.lookupKeyCol  + 1 : 1;
    const dateCol = filterJob.lookupDateCol !== null ? filterJob.lookupDateCol + 1 : null;
    const maxCol  = dateCol ? Math.max(keyCol, dateCol) : keyCol;

  const raw = withExponentialBackoff(() =>
  Sheets.Spreadsheets.Values.get(
    filterJob.lookupId,
    `${filterJob.lookupTab}!A2:${columnToLetter(maxCol)}${lastRow}`,
    { valueRenderOption: "UNFORMATTED_VALUE" }
  ).values || []
);

    const allocMap = new Map();
    let noDateCount = 0;

for (const r of raw) {
  const id = cleanId(r[keyCol - 1]);
  if (!id) continue;

  let allocDateMs = 0;
  if (dateCol) {
    const rawDateVal = r[dateCol - 1];
      let parsed = null;
      if (typeof rawDateVal === 'number') {
        // Sheets serial number → ms (days since Dec 30 1899)
        parsed = (rawDateVal - 25569) * 86400000; // 25569 = days from 1899-12-30 to 1970-01-01
      } else if (rawDateVal) {
        parsed = parseTimestampToMs(rawDateVal);
      }
      if (parsed) {
          allocDateMs = parsed;
        } else {
          noDateCount++;
        }
      }

      allocMap.set(id, allocDateMs);
    }

    Logger.log(`✅ [DISPO_AGG] Alloc map: ${allocMap.size} leads from "${filterJob.lookupTab}"`);
    if (noDateCount > 0) {
      Logger.log(`   ⚠️ ${noDateCount} leads had no allocation date — all their dispositions will be included`);
    }

    return allocMap;

  } catch(e) {
    Logger.log(`❌ _buildDispoAllocMap error: ${e.message}`);
    return new Map();
  }
}

function _getDispoTempLastRow() {
  try {
    const sheet = safeOpenById(CONTROL_CENTER_ID).getSheetByName(DISPO_TEMP_TAB);
    return sheet ? sheet.getLastRow() : 1;
  } catch(e) { return 1; }
}

function _dispoAggComplete(p) {
  const dur = formatDuration(Date.now() - parseInt(p.getProperty("DISPO_AGG_START") || Date.now().toString()));
  Logger.log(`✅ [DISPO_AGG] All phases complete in ${dur}. Setting DISPO_AGG_DONE.`);

  // Clear temp tab
  try {
    const temp = safeOpenById(CONTROL_CENTER_ID).getSheetByName(DISPO_TEMP_TAB);
    if (temp && temp.getLastRow() > 1) {
      safeClear(CONTROL_CENTER_ID, `${DISPO_TEMP_TAB}!A2:F${temp.getLastRow()}`);
    }
  } catch(e) {}

  _logDispoToSentinelHealth(dur);
  _dispoAggReset(p);

  // Set done flag and check fence — PP only fires when call agg also done
  p.setProperty("DISPO_AGG_DONE", "true");
  _tryTriggerPostProcessing(p);
}

function _dispoAggReset(p) {
  p.deleteProperty("DISPO_AGG_PENDING");
  p.deleteProperty("DISPO_AGG_RUNNING");
  p.deleteProperty("DISPO_AGG_SOURCE_KEY");
  p.deleteProperty("DISPO_AGG_READ_ROW");
  p.deleteProperty("DISPO_AGG_START");
}

function _logDispoToSentinelHealth(duration) {
  try {
    const ss    = safeOpenById(CONTROL_CENTER_ID);
    const sheet = ss.getSheetByName("Sentinel_Health");
    if (!sheet) return;
    sheet.insertRowAfter(7);
    sheet.getRange(8, 1).setNumberFormat("@");
    const range = sheet.getRange(8, 1, 1, 6);
    const ts = Utilities.formatDate(new Date(), GLOBAL_TZ, "dd/MM HH:mm:ss");
    range.setValues([[ts, "DISPO", duration, "✅ Dispo aggregation complete", "", ""]]);
    // Explicitly reset formatting — insertRowAfter inherits dark header style
    range.setBackground("#e6f4ea");
    range.setFontColor("#000000");
    range.setFontWeight("normal");
    range.setFontStyle("normal");
    range.setFontSize(10);
    range.setBorder(null, null, true, null, null, null, "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID);
  } catch(e) {
    Logger.log(`⚠️ Could not log to Sentinel_Health: ${e.message}`);
  }
}



// ─── SETUP ────────────────────────────────────────────────────────────────────

/**
 * Creates the Post_Sentinel tab in the Control Center sheet.
 * Run once to set up. Safe to re-run — only creates if tab doesn't exist.
 */
function setupPostSentinelTab() {
  const ss = safeOpenById(CONTROL_CENTER_ID);
  let sheet = ss.getSheetByName(POST_SENTINEL_TAB);

  if (!sheet) {
    sheet = ss.insertSheet(POST_SENTINEL_TAB);
    Logger.log(`✨ Created "${POST_SENTINEL_TAB}" tab.`);
  } else {
    sheet.clearContents();
    Logger.log(`🔄 Cleared existing "${POST_SENTINEL_TAB}" tab.`);
  }

  // Headers
  const headers = ["Function", "Config Key", "Sheet ID", "Tab Name", "Date Range", "Active", "Notes"];
  sheet.getRange(1, 1, 1, 7).setValues([headers])
    .setBackground("#4c1130").setFontColor("white").setFontWeight("bold");

  // Seed rows — user fills in Sheet IDs
  const seed = [
    ["Post_Processing", "PP_STEP_1",       "", "",       "",      false, "Penal metrics source sheet ID"],
    ["Post_Processing", "PP_STEP_2",       "", "",       "",      false, "Call log source sheet ID"],
    ["Post_Processing", "PP_STEP_3",       "", "",       "",      false, "Dispo log source sheet ID"],
    ["Dispo_Merge",     "TCN_DISPO_1",     "", "Sheet1", "1-7",   false, "TCN dispo days 1-7"],
    ["Dispo_Merge",     "TCN_DISPO_2",     "", "Sheet1", "8-13",  false, "TCN dispo days 8-13"],
    ["Dispo_Merge",     "TCN_DISPO_3",     "", "Sheet1", "14-18", false, "TCN dispo days 14-18"],
    ["Dispo_Merge",     "TCN_DISPO_4",     "", "Sheet1", "19-23", false, "TCN dispo days 19-23"],
    ["Dispo_Merge",     "TCN_DISPO_5",     "", "Sheet1", "24-31", false, "TCN dispo days 24-end"],
    ["Dispo_Merge",     "DESTINATION",     "", "",       "",      false, "Merged dispo output destination tab"],
    ["Call_Merge",      "OZO_CALLS",       "", "Sheet1", "",      false, "Ozonetel call log (always active)"],
    ["Call_Merge",      "TCN_CALLS_1",     "", "Sheet1", "1-7",   false, "TCN call log days 1-7"],
    ["Call_Merge",      "TCN_CALLS_2",     "", "Sheet1", "8-13",  false, "TCN call log days 8-13"],
    ["Call_Merge",      "TCN_CALLS_3",     "", "Sheet1", "14-18", false, "TCN call log days 14-18"],
    ["Call_Merge",      "TCN_CALLS_4",     "", "Sheet1", "19-23", false, "TCN call log days 19-23"],
    ["Call_Merge",      "TCN_CALLS_5",     "", "Sheet1", "24-31", false, "TCN call log days 24-end"],
    ["Call_Merge",      "CALL_DESTINATION","", "",       "",      false, "Merged call log destination tab"],
    ["Call_Merge",      "CALL_AUDIT",      "", "",       "",      false, "Cross-source anomaly log tab"],
  ];

  sheet.getRange(2, 1, seed.length, 7).setValues(seed);

  // Checkboxes for Active col (col 6)
  sheet.getRange(2, 6, seed.length, 1).insertCheckboxes();

  // Column widths
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(4, 200);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 70);
  sheet.setColumnWidth(7, 280);

  sheet.setFrozenRows(1);

  // Create Dispo_Temp tab if not exists
  if (!ss.getSheetByName(DISPO_TEMP_TAB)) {
    const temp = ss.insertSheet(DISPO_TEMP_TAB);
    temp.getRange(1, 1, 1, 6).setValues([DISPO_OUTPUT_HEADERS])
      .setBackground("#fef3c7").setFontWeight("bold");
    Logger.log(`✨ Created "${DISPO_TEMP_TAB}" tab.`);
  }

  // Create Dispo_Audit tab if not exists
  if (!ss.getSheetByName(DISPO_AUDIT_TAB)) {
    ss.insertSheet(DISPO_AUDIT_TAB);
    Logger.log(`✨ Created "${DISPO_AUDIT_TAB}" tab.`);
  }

Logger.log(
    `✅ Post_Sentinel setup complete!\n` +
    `Next steps:\n` +
    `1. Fill in Sheet IDs in the Post_Sentinel tab\n` +
    `2. Check the Active checkbox for each configured row\n` +
    `3. In runMasterSync, replace p.setProperty("POST_PROCESS_PENDING"...) with _setPostSentinelFlag(scheduleMode, p)\n` +
    `4. Create trigger: triggerDispoAggregation every 10 minutes\n` +
    `5. Mark [SKIP] on PB_Dispo_Filteration in Routing_Config`
  );
}