/**
 * ==============================================================================
 * ⚙️ SETUP & TOOLS (Setup_And_Tools.gs)
 * ==============================================================================
 * This file contains manual developer tools, setup scripts, and backup utilities.
 * None of these functions are called automatically by the active pipeline.
 * ==============================================================================
 */

// ─── 1. INSTALLATION & SETUP ──────────────────────────────────────────────────

function setupControlCenter() {
  const ss = SpreadsheetApp.openById(CONTROL_CENTER_ID);
  let sheet = ss.getSheetByName(CONTROL_TAB_NAME) || ss.insertSheet(CONTROL_TAB_NAME);
  sheet.clear();

  sheet.getRange("A1:D1").mergeAcross().setValue("🛑 WE-RIZE PIPELINE CONTROL CENTER 6.0 🛑").setBackground("#fce8e6").setFontColor("#c5221f").setFontWeight("bold").setFontSize(14).setHorizontalAlignment("center");
  sheet.getRange("A2:D2").mergeAcross().setValue("Lookup Syntax: 'LOOKUP_DATE_MATCH(COL_1, COL_4)'").setBackground("#f1f3f4").setFontStyle("italic").setHorizontalAlignment("center");
  
  const headers = ["Job Name", "Source ID", "Source Tab", "Dest ID", "Dest Tab", "Refresh Cycle", "Logic Condition", "Source Cols", "Dest Cols", "Last Run Status", "Force Reset", "Lookup ID", "Lookup Tab", "Lookup Key Col #", "Lookup Date Col #", "Schedule", "Display Name", "Freshness Threshold Hours", "Is Transform"];
  sheet.getRange(4, 1, 1, headers.length).setValues([headers]).setBackground("#4c1130").setFontColor("white").setFontWeight("bold").setHorizontalAlignment("center");

  sheet.setFrozenRows(4); sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 180); sheet.setColumnWidth(7, 300); sheet.setColumnWidth(10, 220); sheet.setColumnWidth(17, 280);

  sheet.getRange(5, 11, 100, 1).insertCheckboxes();
  sheet.getRange(5, 19, 100, 1).insertCheckboxes();

  SpreadsheetApp.getUi().alert("✅ Control Center Setup Complete!");
}

function setupCBCDedicatedTriggerAt45() {
  const functionName = "runCBCPaymentsDedicated";
  
  // Clear any existing triggers for this specific function
  ScriptApp.getProjectTriggers().forEach(t => { 
    if (t.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(t); 
  });

  const now = new Date();
  const next45 = new Date(now);
  
  // Set the target time to the 45-minute mark
  next45.setMinutes(45, 0, 0);
  
  // If we are already past the 45-minute mark this hour, push it to the next hour
  if (next45 <= now) {
    next45.setHours(next45.getHours() + 1);
  }

  // Create the one-time trigger for the exact calculated time
  ScriptApp.newTrigger(functionName).timeBased().at(next45).create();
  
  // Create the recurring hourly trigger
  ScriptApp.newTrigger(functionName).timeBased().everyHours(1).create();
  
  Logger.log(`✅ Set up CBC Dedicated trigger starting at: ${next45.toString()}`);
}

function setupDispoAggregationTrigger() {
  const functionName = "triggerDispoAggregation";
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(functionName).timeBased().everyMinutes(10).create();
  Logger.log(`✅ Set up Dispo Aggregation trigger (every 10 minutes).`);
}

// ─── 2. DEVELOPER OVERRIDES ───────────────────────────────────────────────────

function forceRunSentinel() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty("LAST_RUN_30M");
  p.deleteProperty("LAST_RUN_1H");
  p.deleteProperty("LAST_RUN_1D");
  Logger.log("🧠 Memory wiped. Triggering Sentinel...");
  triggerSentinel();
}

function clearAllProperties() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log("✅ All script properties cleared (Month-End Protocol).");
}

// ─── 3. PRE-FLIGHT DIAGNOSTICS ────────────────────────────────────────────────

function runPreFlightCheck() {
  Logger.log("🚀 Starting Pre-Flight Permission Check...");
  const sheet = SpreadsheetApp.openById(CONTROL_CENTER_ID).getSheetByName(CONTROL_TAB_NAME);
  const data = sheet.getRange(5, 1, sheet.getLastRow() - 4, 16).getValues();
  
  let failures = 0;
  data.forEach((row, index) => {
    if (!row[0] || !row[1] || row[1] === "CUSTOM_SCRIPT") return;
    try { DriveApp.getFileById(row[1]); } catch(e) { Logger.log(`❌ SRC ERROR (Row ${index+5}): ${classifyOpenErrorMsg(e.message)}`); failures++; }
    if (row[3]) { try { DriveApp.getFileById(row[3]); } catch(e) { Logger.log(`❌ DST ERROR (Row ${index+5}): ${classifyOpenErrorMsg(e.message)}`); failures++; } }
  });

  if (failures === 0) Logger.log("🟢 ALL SYSTEMS GO.");
}

function classifyOpenErrorMsg(msg) {
  msg = String(msg || "").toLowerCase();
  if (/file not found|could not find/.test(msg)) return "NOT_FOUND";
  if (/permission denied|access denied/.test(msg)) return "NO_ACCESS";
  if (/trashed|in trash/.test(msg)) return "TRASHED";
  return "OTHER";
}

// ─── 4. LOCAL BACKUP ──────────────────────────────────────────────────────────

function exportProjectToDrive() {
  const scriptId = ScriptApp.getScriptId();
  const response = UrlFetchApp.fetch(`https://script.googleapis.com/v1/projects/${scriptId}/content`, {
    headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  
  if (response.getResponseCode() !== 200) return Logger.log("❌ Export failed.");
  const files = JSON.parse(response.getContentText()).files;
  
  const blobs = files.map(f => Utilities.newBlob(f.source, 'text/plain', f.name + (f.type === 'HTML' ? '.html' : '.js')));
  const d = new Date();
  DriveApp.createFile(Utilities.zip(blobs, `Sentinel_Codebase_${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.zip`));
  Logger.log("✅ Backup saved to root of Google Drive.");
}

/**
 * ⏪ Developer Tool: Dispo Aggregation Time Machine
 * Adjust the two constants below to control exactly how the engine rewinds.
 */
function manualDispoTimeMachine() {
  
  // ⚡ USER CONFIGURATION ⚡
  // Set to true to completely wipe all aggregation state and stop the engine.
  // Set to false to rewind to a specific phase below.
  const FULL_RESET = false;   
  
  // If FULL_RESET is false, the engine will resume at this exact phase (0 to 5)
  // Phase 0: PB Dispo | Phase 1: TCN 1 | Phase 2: TCN 2 | Phase 3: TCN 3 | Phase 4: Dedup | Phase 5: 0Bkt Input
  const TARGET_PHASE = 0;     
  // ========================

  const p = PropertiesService.getScriptProperties();

  if (FULL_RESET) {
    // 🛑 The Nuke: Wipes everything. The engine goes dormant.
    p.deleteProperty("DISPO_AGG_PENDING");
    p.deleteProperty("DISPO_AGG_PHASE");
    p.deleteProperty("DISPO_AGG_START");
    p.deleteProperty("DISPO_AGG_READ_ROW");
    p.deleteProperty("DISPO_AGG_RUNNING");
    
    Logger.log("🛑 FULL RESET EXECUTED: All Dispo Aggregation memory wiped. The engine will not run again until the next 1H Sentinel trigger.");
  
  } else {
    // ⏪ The Scalpel: Rewinds to a specific phase
    
    // 1. Ensure the engine knows it still has work to do
    p.setProperty("DISPO_AGG_PENDING", "true");
    
    // 2. Set the exact phase you want to target
    p.setProperty("DISPO_AGG_PHASE", TARGET_PHASE.toString());
    
    // 3. Clear any mid-phase row progress or stuck locks
    p.deleteProperty("DISPO_AGG_READ_ROW");
    p.deleteProperty("DISPO_AGG_RUNNING");
    
    Logger.log(`⏪ REWOUND TO PHASE ${TARGET_PHASE}: Memory updated. You can now manually run 'triggerDispoAggregation' to resume from this phase.`);
  }
}

/**
 * Scans the dashboard sheet and dynamically detects the layout of all 4 tables.
 * Finds tables by searching for metric header text, not hardcoded row/col numbers.
 * Returns layout objects used by calculateDailyInputs for reading + writing.
 */
function _detectDashboardLayout(dashSheet) {
// 🚀 V8 OPTIMIZATION: Regex matchers to catch spelling, spacing, and plural variations
  const METRIC_MATCHERS = {
    "Total attmpt": /total[\s_]*att?e?mpts?/i,          
    "Avg Dial": /avg[\s_\.]*dial/i,                     
    "Unique Attempts": /unique[\s_]*att?e?mpts?/i,      
    "Total Connects": /total[\s_]*connects?/i,
    "Unique Connects": /unique[\s_]*connects?(?![\s_]*%)/i, 
    "Unique Connects %": /unique[\s_]*connects?[\s_]*%/i,
    "Total TT (Mins)": /total[\s_]*tt/i,
    "Avg. TT/Call (Mins)": /avg[\s_\.]*tt/i,
    "Avg. TT/Call (Mins)": /avg[\s_\.]*(tt|talktime)/i
  };
  const STOP_WORDS = ["total", "avg", "grand", "average"];

  const allData  = dashSheet.getDataRange().getValues();
  const nR = allData.length;
  const nC = allData[0] ? allData[0].length : 0;

  // ── Core helpers ───────────────────────────────────────────────────────────

  const cell = (r, c) => String(allData[r]?.[c] || "").trim();
  
  // Flexible matcher: Checks the Regex dictionary first. If not found, falls back to string match.
  const matches = (r, c, query) => {
    const val = cell(r, c);
    if (METRIC_MATCHERS[query]) return METRIC_MATCHERS[query].test(val);
    return val.toLowerCase() === query.toLowerCase().trim();
  };

  // Find every (row, col) where a text value appears
  const findAll = (query) => {
    const hits = [];
    for (let r = 0; r < nR; r++) {
      for (let c = 0; c < nC; c++) {
        if (matches(r, c, query)) hits.push({ r, c });
      }
    }
    return hits;
  };

  // In a header row, map each metric name → its col index (or -1 if missing)
  // fromCol lets us restrict to one side of the sheet (for T2 detection)
  const mapMetrics = (headerRow, fromCol = 0, toCol = nC) => {
    const map = {};
    for (const m of Object.keys(METRIC_MATCHERS)) { // 🚀 Updated to use dictionary keys
      map[m] = -1;
      for (let c = fromCol; c < toCol; c++) {
        if (matches(headerRow, c, m)) { map[m] = c; break; }
      }
    }
    return map;
  };

// 🚀 SMARTER LABEL DETECTION: Hunts for the actual Agent Name header
  const labelColFor = (headerRow, firstMetricCol) => {
    // 1. Scan backwards looking specifically for the Name/TC column
    for (let c = firstMetricCol - 1; c >= 0; c--) {
      const headerText = cell(headerRow, c).toLowerCase();
      if (headerText.includes("name") || headerText.includes("tc") || headerText.includes("agent") || headerText.includes("caller")) {
        return c;
      }
    }
    // 2. Fallback: If no obvious header is found, just pick the first non-empty header we hit
    for (let c = firstMetricCol - 1; c >= 0; c--) {
      if (cell(headerRow, c)) return c;
    }
    return Math.max(0, firstMetricCol - 1);
  };


  // Extract {label, row} entries below a header row until empty/stop word
  const extractLabels = (headerRow, labelCol) => {
    const out = [];
    for (let r = headerRow + 1; r < nR; r++) {
      const v = cell(r, labelCol);
      if (!v) break;
      if (STOP_WORDS.some(sw => v.toLowerCase().includes(sw))) break;
      out.push({ label: v, row: r + 1 }); // row is 1-indexed for Sheets API
    }
    return out;
  };

  // ── Find T4: Daily Trends ──────────────────────────────────────────────────
  const t4AnchorHits = findAll("Daily trends");
  if (!t4AnchorHits.length) throw new Error("❌ 'Daily trends' header not found in dashboard.");
  const t4Anchor = t4AnchorHits[0];
  const t4MetricMap = mapMetrics(t4Anchor.r);
  // Extract date rows (stop on first empty cell — no stop-word logic for dates)
  const t4Dates = [];
  for (let r = t4Anchor.r + 1; r < nR; r++) {
    const rawDate = allData[r][t4Anchor.c];
    if (!rawDate) break;
    t4Dates.push({ rawDate, row: r + 1 }); // 1-indexed
  }

  // ── Find T1+T2: side-by-side tables sharing a header row ─────────────────
  // T1 = first "Total attmpt" occurrence above T4
  const allTA = findAll("Total attmpt");
  const t1Hit = allTA.find(h => h.r < t4Anchor.r);
  if (!t1Hit) throw new Error("❌ T1 'Total attmpt' header not found.");
  const t12HeaderRow = t1Hit.r;

  // T2 = second "Total attmpt" in the SAME row, to the right of T1
  const t2Hit = allTA.find(h => h.r === t12HeaderRow && h.c > t1Hit.c);

  const t1LabelCol = labelColFor(t12HeaderRow, t1Hit.c);
  const t1MetricMap = mapMetrics(t12HeaderRow, 0, t2Hit ? t2Hit.c : nC);
  const t1Labels = extractLabels(t12HeaderRow, t1LabelCol);

  let t2MetricMap = {}, t2Labels = [];
  if (t2Hit) {
    const t2LabelCol = labelColFor(t12HeaderRow, t2Hit.c);
    t2MetricMap = mapMetrics(t12HeaderRow, t2Hit.c, nC);
    t2Labels = extractLabels(t12HeaderRow, t2LabelCol);
  }

  // ── Find T3: "Total attmpt" between T1 row and T4 row ────────────────────
  const t3Hit = allTA.find(h => h.r > t12HeaderRow && h.r < t4Anchor.r);
  let t3MetricMap = {}, t3Labels = [];
  if (t3Hit) {
    const t3LabelCol = labelColFor(t3Hit.r, t3Hit.c);
    t3MetricMap = mapMetrics(t3Hit.r);
    t3Labels = extractLabels(t3Hit.r, t3LabelCol);
  }

  Logger.log(`📐 Layout detected:`);
  Logger.log(`   T1: header row ${t12HeaderRow + 1}, ${t1Labels.length} agents`);
  Logger.log(`   T2: header row ${t12HeaderRow + 1}, ${t2Labels.length} agents`);
  Logger.log(`   T3: ${t3Hit ? `header row ${t3Hit.r + 1}` : "NOT FOUND"}, ${t3Labels.length} agents`);
  Logger.log(`   T4: header row ${t4Anchor.r + 1}, ${t4Dates.length} date rows`);

  return { t1: { metricMap: t1MetricMap, labels: t1Labels },
           t2: { metricMap: t2MetricMap, labels: t2Labels },
           t3: { metricMap: t3MetricMap, labels: t3Labels },
           t4: { metricMap: t4MetricMap, dates: t4Dates } };
}

/**
 * For a single table, pushes one batchUpdate entry per metric column.
 * Each entry writes the full column of values in one API call.
 * Much more efficient than one entry per cell.
 */
function _buildTableUpdates(sheetName, metricMap, labels, statBucket, divisor, updates) {
  if (!labels.length) return;

  const computeMetric = (m, st) => {
    const d = divisor || 1;
    const totAtt  = st.attempts / d;
    const uAtt    = st.uAttSet.size / d;
    const totConn = st.connects / d;
    const uConn   = st.uConnSet.size / d;
    const totTT   = (st.ttSec / 60) / d;
    switch (m) {
      case "Total attmpt":       return totAtt;
      case "Avg Dial":           return uAtt > 0 ? totAtt / uAtt : 0;
      case "Unique Attempts":    return uAtt;
      case "Total Connects":     return totConn;
      case "Unique Connects":    return uConn;
      case "Unique Connects %":  return uAtt > 0 ? uConn / uAtt : 0;
      case "Total TT (Mins)":    return totTT;
      case "Avg. TT/Call (Mins)":return uConn > 0 ? totTT / uConn : 0;
      default: return 0;
    }
  };

  const createStatBucket = () => ({ attempts: 0, uAttSet: new Set(), connects: 0, uConnSet: new Set(), ttSec: 0 });

  for (const [metric, colIdx] of Object.entries(metricMap)) {
    if (colIdx < 0) continue; // metric not in this table's header
    const colLetter = columnToLetter(colIdx + 1);
    const values = labels.map(({ label }) => {
      const st = statBucket[label] || createStatBucket();
      return [computeMetric(metric, st)];
    });
    const startRow = labels[0].row;
    updates.push({
      range: `'${sheetName}'!${colLetter}${startRow}:${colLetter}${startRow + values.length - 1}`,
      values
    });
  }
}

// ─── 5. PAUSE / RESUME ────────────────────────────────────────────────────────

function pausePipeline(hours) {
  const props = PropertiesService.getScriptProperties();
  const until = Date.now() + (hours * 60 * 60 * 1000);
  props.setProperty("PIPELINE_PAUSED_UNTIL", until.toString());
  props.setProperty("PIPELINE_PAUSED_AT", Date.now().toString());
  props.deleteProperty("PAUSE_ALERT_SENT");
  Logger.log(`⏸️ Pipeline paused for ${hours}h until ${new Date(until).toLocaleString()}`);
}

function resumePipeline() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("PIPELINE_PAUSED_UNTIL");
  props.deleteProperty("PIPELINE_PAUSED_AT");
  props.deleteProperty("PAUSE_ALERT_SENT");
  Logger.log(`▶️ Pipeline manually resumed.`);
}