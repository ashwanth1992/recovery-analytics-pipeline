/**
 * ==============================================================================
 * UNIFIED VINTAGE ANALYSIS ENGINE
 * ==============================================================================
 * Replaces: Vintage.gs (V1), Vintage_2.gs (V2), Vintage_3.gs (V3), Vintage_4.gs (V4)
 *
 * ARCHITECTURE:
 *   copyAccruedToView3()     — copies View 2 accrued tabs → View 3, then calls generateVintageViews()
 *   generateVintageViews()   — standalone orchestrator (call this for UI tweaks without re-copying)
 *     ├── runView2Engine()   — tags DPD, aggregates all 4 tabs, builds View 2 summary
 *     ├── runWaterfallEngine() — reads View 2 paid, allocates via waterfall to View 3 accrued cols
 *     └── runView3Engine()   — reads pre-tagged View 3 data, builds View 3 summary
 *
 * SUMMARY ROW STRUCTURE (both views, consistent):
 *   Accrued → Paid → Remaining (Accrued - Paid) → Recovery %
 *
 * STALE DATA CHECK:
 *   generateVintageViews() checks when View 3 accrued was last copied.
 *   If > 7 days old, logs a warning and waits 10s before proceeding.
 * ==============================================================================
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const VINTAGE_VIEW2_ID  = 'YOUR_VINTAGE_VIEW2_SHEET_ID';
const VINTAGE_VIEW3_ID  = 'YOUR_VINTAGE_VIEW3_SHEET_ID';
const VINTAGE_MASTER_ID = 'YOUR_VINTAGE_MASTER_SHEET_ID';

const VINTAGE_ACCRUED_TABS = [
  "Accured Vintage_Due Wise",
  "Accured Vintage_Created Wise"
];
const VINTAGE_PAID_TABS = [
  "Paid Vintage_Due Wise",
  "Paid Vintage_Created Wise"
];
const VINTAGE_ALL_TABS = [...VINTAGE_ACCRUED_TABS, ...VINTAGE_PAID_TABS];

const VINTAGE_WORKABLE_BUCKETS    = ["Closed", "(1) 0", "(2) 0-30", "(3) 31-60", "(4) 61-90"];
const VINTAGE_NONWORKABLE_BUCKETS = ["(5) 91-120", "(6) 121-150", "(7) 151-180", "(8+) 180+"];
const VINTAGE_SUB_HEADERS         = ["BKT", "Metric", "0-3 Months", "4-6 Months", "7-12 Months", "13-24 Months", ">= 25 Months", "Total"];

// Timestamp cell in View 3 to track when accrued data was last copied
const VINTAGE_V3_TIMESTAMP_CELL = "A1";
const VINTAGE_STALE_DAYS        = 7;


// ─── PUBLIC ENTRY POINTS ──────────────────────────────────────────────────────

/**
 * Copies View 2 accrued tabs → View 3, then generates both summaries.
 * Call this when fresh base data has been loaded via the Python script.
 */
function copyAccruedToView3() {
  const startMs = Date.now();
  Logger.log("📋 =========================================");
  Logger.log("📋 COPY ACCRUED VIEW 2 → VIEW 3");
  Logger.log("📋 =========================================");

  try {
    const view2 = safeOpenById(VINTAGE_VIEW2_ID);
    const view3 = safeOpenById(VINTAGE_VIEW3_ID);

    VINTAGE_ACCRUED_TABS.forEach(tabName => {
      Logger.log(`\n📋 Copying '${tabName}' via REST API...`);

      // Get source row count using SpreadsheetApp (lightweight metadata call)
      const srcSheet = view2.getSheetByName(tabName);
      if (!srcSheet || srcSheet.getLastRow() < 2) {
        Logger.log(`   ⚠️ Source tab '${tabName}' is empty or missing. Skipping.`);
        return;
      }
      const srcLastRow = srcSheet.getLastRow();

      // Ensure destination tab exists (SpreadsheetApp for tab management)
      let dstSheet = view3.getSheetByName(tabName);
      if (!dstSheet) {
        Logger.log(`   ℹ️ Creating tab '${tabName}' in View 3...`);
        dstSheet = view3.insertSheet(tabName);
      }

      // Clear cols A-J in destination via REST (preserves K-P waterfall columns)
      const dstLastRow = dstSheet.getLastRow();
      if (dstLastRow > 0) {
        safeClear(VINTAGE_VIEW3_ID, `${tabName}!A1:J${dstLastRow}`);
      }

      // Use getOptimalBatchSize for consistent chunk sizing across the codebase
      const REST_CHUNK = getOptimalBatchSize(srcLastRow, tabName).limit;
      let totalCopied  = 0;

      for (let startRow = 1; startRow <= srcLastRow; startRow += REST_CHUNK) {
        const endRow   = Math.min(startRow + REST_CHUNK - 1, srcLastRow);
        const rangeStr = `${tabName}!A${startRow}:J${endRow}`;

        // Read from View 2 via REST API
        const chunk = safeGet(VINTAGE_VIEW2_ID, rangeStr);
        if (!chunk || chunk.length === 0) {
          Logger.log(`   ⚠️ Empty chunk at rows ${startRow}-${endRow}. Skipping.`);
          continue;
        }

        // Write to View 3 via REST API
        // RAW preserves existing values exactly — no re-parsing of dates or numbers
        safeUpdate(
          { values: chunk },
          VINTAGE_VIEW3_ID,
          `${tabName}!A${startRow}:J${endRow}`,
          { valueInputOption: "RAW" }
        );

        totalCopied += chunk.length;
        Logger.log(`   ├─ Rows ${startRow}–${endRow} (${chunk.length} rows)`);
      }

      Logger.log(`   ✅ Copied ${totalCopied} rows to View 3.`);
    });

    // Write timestamp to View 3 so stale-check works
    const ts = Utilities.formatDate(new Date(), GLOBAL_TZ, "yyyy-MM-dd HH:mm:ss");
    const firstAccSheet = view3.getSheetByName(VINTAGE_ACCRUED_TABS[0]);
    if (firstAccSheet) {
      firstAccSheet.getRange(VINTAGE_V3_TIMESTAMP_CELL).setValue(`Last copied: ${ts}`);
    }

    Logger.log(`\n✅ Copy complete in ${formatDuration(Date.now() - startMs)}.`);
    Logger.log("📊 Now generating vintage views...\n");

    // Automatically call the view generator after a successful copy
    generateVintageViews({ skipStaleCheck: true });

  } catch(e) {
    Logger.log(`❌ copyAccruedToView3 failed: ${e.message}\n${e.stack}`);
    throw e;
  }
}


/**
 * Generates both View 2 and View 3 summary tabs.
 * Call this standalone when tweaking the UI without needing to re-copy data.
 *
 * @param {Object} opts
 * @param {boolean} opts.skipStaleCheck - if true, skips the stale data warning (default: false)
 */
function generateVintageViews(opts) {
  opts = opts || {};
  const startMs = Date.now();

  Logger.log("📊 =========================================");
  Logger.log("📊 GENERATE VINTAGE VIEWS");
  Logger.log("📊 =========================================");

  // ── Stale data check ───────────────────────────────────────────────────────
  if (!opts.skipStaleCheck) {
    try {
      const view3     = safeOpenById(VINTAGE_VIEW3_ID);
      const tsSheet   = view3.getSheetByName(VINTAGE_ACCRUED_TABS[0]);
      const tsCell    = tsSheet ? tsSheet.getRange(VINTAGE_V3_TIMESTAMP_CELL).getValue() : null;
      const tsMatch   = tsCell ? String(tsCell).match(/(\d{4}-\d{2}-\d{2})/) : null;

      if (!tsMatch) {
        Logger.log("⚠️ [STALE DATA WARNING] No copy timestamp found in View 3.");
        Logger.log("   Run copyAccruedToView3() first if you want fresh accrued data.");
        Logger.log("   Proceeding with existing View 3 data in 10 seconds...");
        Utilities.sleep(10000);
      } else {
        const copiedDate  = new Date(tsMatch[1]);
        const daysSince   = Math.floor((Date.now() - copiedDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysSince > VINTAGE_STALE_DAYS) {
          Logger.log(`⚠️ [STALE DATA WARNING] View 3 accrued data was last copied ${daysSince} days ago (${tsMatch[1]}).`);
          Logger.log("   Run copyAccruedToView3() first if you want fresh results.");
          Logger.log("   Proceeding anyway in 10 seconds...");
          Logger.log("   (Call generateVintageViews({ skipStaleCheck: true }) to suppress this warning.)");
          Utilities.sleep(10000);
        } else {
          Logger.log(`✅ Data freshness OK — copied ${daysSince} day(s) ago (${tsMatch[1]}).`);
        }
      }
    } catch(e) {
      Logger.log(`⚠️ Could not check stale timestamp (non-fatal): ${e.message}`);
    }
  }

  // ── Run all three engines ──────────────────────────────────────────────────
  Logger.log("\n━━━ VIEW 2: Tagging + Summary ━━━");
  runView2Engine();

  Logger.log("\n━━━ WATERFALL: Allocate Paid to View 3 ━━━");
  runWaterfallEngine();

  Logger.log("\n━━━ VIEW 3: Summary ━━━");
  runView3Engine();

  Logger.log(`\n✅ All views generated in ${formatDuration(Date.now() - startMs)}.`);
}


// ─── VIEW 2 ENGINE ────────────────────────────────────────────────────────────

function runView2Engine() {
  const startMs = Date.now();
  Logger.log("🚀 Starting View 2 Engine...");

  const targetSS = safeOpenById(VINTAGE_VIEW2_ID);
  const masterSS = safeOpenById(VINTAGE_MASTER_ID);

  // Step 1: Build unique lead superset across all 4 tabs
  Logger.log("\n🔍 Step 1: Building unique lead superset...");
  const uniqueLeads = new Set();
  VINTAGE_ALL_TABS.forEach(name => {
    const sheet = targetSS.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      Logger.log(`   ├─ Scanning '${name}'...`);
      // FIX 1: REST API Read
      const ids = safeGet(VINTAGE_VIEW2_ID, `${name}!A2:A${sheet.getLastRow()}`);
      ids.forEach(r => { const id = cleanId(r[0]); if (id) uniqueLeads.add(id); });
    }
  });
  Logger.log(`✅ Superset: ${uniqueLeads.size.toLocaleString('en-IN')} unique leads.`);

  // Step 2: Load DPD map from Master (only for superset leads)
  Logger.log("\n🧮 Step 2: Loading DPD map from Master...");
  const masterSheet  = masterSS.getSheets()[0];
  const masterSheetName = masterSheet.getName(); // Dynamic name capture
  const masterLastRow = masterSheet.getLastRow();
  
  // FIX 2: Only read cols A and K via REST API
  const masterIds  = safeGet(VINTAGE_MASTER_ID, `${masterSheetName}!A1:A${masterLastRow}`);
  const masterDpds = safeGet(VINTAGE_MASTER_ID, `${masterSheetName}!K1:K${masterLastRow}`);
  const dpdMap     = new Map();
  
  for (let i = 1; i < masterIds.length; i++) {
    const leadId = cleanId((masterIds[i] || [])[0]);
    if (uniqueLeads.has(leadId)) {
      dpdMap.set(leadId, String(((masterDpds[i] || [])[0]) || "").trim());
    }
  }
  
  Logger.log(`✅ DPD map: ${dpdMap.size.toLocaleString('en-IN')} leads matched.`);
  if (uniqueLeads.size > dpdMap.size) {
    Logger.log(`⚠️ ${(uniqueLeads.size - dpdMap.size).toLocaleString('en-IN')} leads missing from Master.`);
  }

  // Step 3: Tag + aggregate all 4 tabs
  Logger.log("\n⚙️ Step 3: Tagging and aggregating...");
  const dueStats     = _createEmptyStatsObj();
  const createdStats = _createEmptyStatsObj();

  VINTAGE_ALL_TABS.forEach(name => {
    const sheet = targetSS.getSheetByName(name);
    if (!sheet) { Logger.log(`❌ Tab '${name}' not found. Skipping.`); return; }
    const isDue      = name.includes("Due");
    const isAccrued  = name.includes("Accured");
    const statsObj   = isDue ? dueStats : createdStats;
    const metricKey  = isAccrued ? "accrued" : "paid";
    _tagAndAggregateSheet(sheet, dpdMap, statsObj, metricKey);
  });

  // Step 4: Build summary
  Logger.log("\n📊 Step 4: Building View 2 summary...");
  _buildSummaryUI(targetSS, dueStats, createdStats);

  Logger.log(`✅ View 2 Engine complete in ${formatDuration(Date.now() - startMs)}.`);
}


// ─── WATERFALL ENGINE ─────────────────────────────────────────────────────────

function runWaterfallEngine() {
  const startMs = Date.now();
  Logger.log("🌊 Starting Waterfall Engine...");

  const view2 = safeOpenById(VINTAGE_VIEW2_ID);
  const view3 = safeOpenById(VINTAGE_VIEW3_ID);

  // Process Due Date pair
  _processWaterfall(view3, view2, "Accured Vintage_Due Wise", "Paid Vintage_Due Wise");
  // Process Created Date pair
  _processWaterfall(view3, view2, "Accured Vintage_Created Wise", "Paid Vintage_Created Wise");

  Logger.log(`✅ Waterfall Engine complete in ${formatDuration(Date.now() - startMs)}.`);
}


// ─── VIEW 3 ENGINE ────────────────────────────────────────────────────────────

function runView3Engine() {
  const startMs = Date.now();
  Logger.log("🚀 Starting View 3 Engine...");

  const targetSS     = safeOpenById(VINTAGE_VIEW3_ID);
  const dueStats     = _createEmptyStatsObj();
  const createdStats = _createEmptyStatsObj();

  Logger.log("\n⚙️ Step 1: Reading and aggregating pre-tagged data...");
  VINTAGE_ACCRUED_TABS.forEach(name => {
    const sheet = targetSS.getSheetByName(name);
    if (!sheet) { Logger.log(`❌ Tab '${name}' not found. Skipping.`); return; }
    const isDue    = name.includes("Due");
    const statsObj = isDue ? dueStats : createdStats;
    _aggregatePreTaggedSheet(sheet, statsObj);
  });

  Logger.log("\n📊 Step 2: Building View 3 summary...");
  _buildSummaryUI(targetSS, dueStats, createdStats);

  Logger.log(`✅ View 3 Engine complete in ${formatDuration(Date.now() - startMs)}.`);
}


// ─── DATA PROCESSING ──────────────────────────────────────────────────────────

function _createEmptyStatsObj() {
  return { total: {}, bounce: {}, penal: {} };
}


/**
 * Tags DPD Bucket + Loan Type back to cols I+J, then aggregates accrued OR paid
 * vintage bucket values (cols D-H) into the stats object.
 * Used by View 2 engine for all 4 tabs.
 */
function _tagAndAggregateSheet(sheet, dpdMap, globalStats, metricKey) {
  const sheetName = sheet.getName();
  Logger.log(`\n▶️ Tagging + aggregating '${sheetName}' (${metricKey.toUpperCase()})...`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("   ⚠️ Empty tab. Skipping."); return; }

  // Write column headers for tagged cols
  sheet.getRange(1, 9).setValue("Loan Type");
  sheet.getRange(1, 10).setValue("DPD Bucket");

  // FIX 3: REST API Read using dynamic last column letter
  const lastCol  = sheet.getLastColumn();
  const colLetter = columnToLetter(lastCol);
  const ssId     = sheet.getParent().getId();
  const READ_CHUNK = getOptimalBatchSize(lastRow, sheetName, lastCol).limit;
  const data = [];

  const header = safeGet(ssId, `${sheetName}!A1:${colLetter}1`);
  if (header && header[0]) data.push(header[0]);

  for (let startRow = 2; startRow <= lastRow; startRow += READ_CHUNK) {
    const endRow = Math.min(startRow + READ_CHUNK - 1, lastRow);
    const chunk  = safeGet(ssId, `${sheetName}!A${startRow}:${colLetter}${endRow}`);
    if (chunk && chunk.length > 0) chunk.forEach(r => data.push(r));
  }
  
  const updates = [];
  let auditRows = 0, auditMoney = 0, auditBounce = 0, auditPenal = 0, auditMissing = 0;

  for (let i = 1; i < data.length; i++) {
    const row      = data[i] || [];
    const leadId   = cleanId(row[0]);
    const category = String(row[1] || "").trim();

    // Determine loan type from Lead ID prefix
    let loanType = "PL";
    if (leadId.startsWith("LAP"))      loanType = "LAP";
    else if (leadId.startsWith("SME")) loanType = "SME";

    // Determine DPD bucket
    let dpdBucket = "";
    if (loanType === "LAP")      dpdBucket = "LAP";
    else if (loanType === "SME") dpdBucket = "SME";
    else {
      dpdBucket = dpdMap.get(leadId) || "Not Found";
      if (dpdBucket === "Not Found") auditMissing++;
    }

    updates.push([loanType, dpdBucket]);

    // Ensure bucket exists in stats
    if (!globalStats.total[dpdBucket]) {
      globalStats.total[dpdBucket]  = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
      globalStats.bounce[dpdBucket] = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
      globalStats.penal[dpdBucket]  = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
    }

    // Read vintage bucket values (cols D-H = indices 3-7)
    const v = [
      toNumber(row[3]), toNumber(row[4]), toNumber(row[5]),
      toNumber(row[6]), toNumber(row[7])
    ];
    const rowTotal = v.reduce((a, b) => a + b, 0);

    auditRows++; auditMoney += rowTotal;
    if (category === "Bounce") auditBounce++;
    else if (category === "Penal") auditPenal++;

    // Accumulate into stats
    for (let k = 0; k < 5; k++) {
      globalStats.total[dpdBucket][metricKey][k] += v[k];
    }
    if (category === "Bounce") {
      for (let k = 0; k < 5; k++) globalStats.bounce[dpdBucket][metricKey][k] += v[k];
    } else if (category === "Penal") {
      for (let k = 0; k < 5; k++) globalStats.penal[dpdBucket][metricKey][k] += v[k];
    }
  }

  // FIX 4: Batch write DPD tags back to sheet using REST API
  const optimal = getOptimalBatchSize(updates.length, sheetName);
  //const ssId = sheet.getParent().getId();
  
  for (let i = 0; i < updates.length; i += optimal.limit) {
    const chunk    = updates.slice(i, i + optimal.limit);
    const startRow = 2 + i;
    safeUpdate(
      { values: chunk },
      ssId,
      `${sheetName}!I${startRow}:J${startRow + chunk.length - 1}`,
      { valueInputOption: "RAW" }
    );
  }

  Logger.log(`   ├─ Rows: ${auditRows.toLocaleString('en-IN')} | ₹ ${auditMoney.toLocaleString('en-IN', {maximumFractionDigits:0})}`);
  Logger.log(`   ├─ Bounce: ${auditBounce.toLocaleString('en-IN')} | Penal: ${auditPenal.toLocaleString('en-IN')}`);
  if (auditMissing > 0) Logger.log(`   ⚠️ ${auditMissing.toLocaleString('en-IN')} rows had missing DPD.`);
  else Logger.log("   └─ 🟢 100% DPD matched.");
}


/**
 * Reads pre-tagged View 3 accrued tabs (cols D-H = accrued, cols L-P = waterfall paid).
 * No writes to the sheet — read-only aggregation.
 * Used by View 3 engine.
 */
function _aggregatePreTaggedSheet(sheet, globalStats) {
  const sheetName = sheet.getName();
  Logger.log(`\n▶️ Aggregating pre-tagged '${sheetName}'...`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("   ⚠️ Empty tab. Skipping."); return; }

  // Read in chunks — 16 cols × 273k rows = 4.4M cells, too large for one REST call
  const READ_CHUNK = getOptimalBatchSize(lastRow, sheetName, 16).limit;
  const data = [];

  // Always include header row in first chunk for column reference
  const header = safeGet(VINTAGE_VIEW3_ID, `${sheetName}!A1:P1`);
  if (header && header[0]) data.push(header[0]);

  for (let startRow = 2; startRow <= lastRow; startRow += READ_CHUNK) {
    const endRow = Math.min(startRow + READ_CHUNK - 1, lastRow);
    const chunk  = safeGet(VINTAGE_VIEW3_ID, `${sheetName}!A${startRow}:P${endRow}`);
    if (chunk && chunk.length > 0) {
      chunk.forEach(r => data.push(r));
    }
    Logger.log(`   ├─ Read rows ${startRow}–${endRow} (${chunk ? chunk.length : 0} rows)`);
  }

  let auditRows = 0, auditAccrued = 0, auditPaid = 0, auditMissing = 0;

  for (let i = 1; i < data.length; i++) {
    const row      = data[i] || [];
    const category = String(row[1] || "").trim();
    let dpdBucket  = String(row[9] || "").trim(); // Col J = DPD Bucket (pre-tagged by V2)

    if (!dpdBucket) { dpdBucket = "Not Found"; auditMissing++; }

    if (!globalStats.total[dpdBucket]) {
      globalStats.total[dpdBucket]  = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
      globalStats.bounce[dpdBucket] = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
      globalStats.penal[dpdBucket]  = { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
    }

    // Accrued: cols D-H (indices 3-7)
    const acc = [
      toNumber(row[3]), toNumber(row[4]), toNumber(row[5]),
      toNumber(row[6]), toNumber(row[7])
    ];
    // Waterfall paid: cols L-P (indices 11-15)
    const paid = [
      toNumber(row[11]), toNumber(row[12]), toNumber(row[13]),
      toNumber(row[14]), toNumber(row[15])
    ];

    auditRows++;
    auditAccrued += acc.reduce((a, b) => a + b, 0);
    auditPaid    += paid.reduce((a, b) => a + b, 0);

    for (let k = 0; k < 5; k++) {
      globalStats.total[dpdBucket].accrued[k] += acc[k];
      globalStats.total[dpdBucket].paid[k]    += paid[k];
    }
    if (category === "Bounce") {
      for (let k = 0; k < 5; k++) {
        globalStats.bounce[dpdBucket].accrued[k] += acc[k];
        globalStats.bounce[dpdBucket].paid[k]    += paid[k];
      }
    } else if (category === "Penal") {
      for (let k = 0; k < 5; k++) {
        globalStats.penal[dpdBucket].accrued[k] += acc[k];
        globalStats.penal[dpdBucket].paid[k]    += paid[k];
      }
    }
  }

  Logger.log(`   ├─ Rows: ${auditRows.toLocaleString('en-IN')}`);
  Logger.log(`   ├─ Total Accrued ₹: ${auditAccrued.toLocaleString('en-IN', {maximumFractionDigits:0})}`);
  Logger.log(`   ├─ Total Paid ₹: ${auditPaid.toLocaleString('en-IN', {maximumFractionDigits:0})}`);
  if (auditMissing > 0) Logger.log(`   ⚠️ ${auditMissing} rows had missing DPD Bucket.`);
  else Logger.log("   └─ 🟢 100% DPD matched.");
}


/**
 * Waterfall payment allocator.
 * Reads total paid per lead from View 2 paid tab, allocates to View 3 accrued cols K-P.
 */
function _processWaterfall(view3, view2, accTabName, paidTabName) {
  Logger.log(`\n⚙️ Waterfall: ${accTabName}`);

  const accSheet  = view3.getSheetByName(accTabName);
  const paidSheet = view2.getSheetByName(paidTabName);

  if (!accSheet || !paidSheet) {
    Logger.log(`❌ Could not find '${accTabName}' or '${paidTabName}'. Skipping.`);
    return;
  }

  // Load paid data into map: key = leadId_category, value = total paid
  const paidLastRow = paidSheet.getLastRow();
  const paidData    = safeGet(VINTAGE_VIEW2_ID, `${paidTabName}!A1:C${paidLastRow}`);
  const paidMap  = new Map();
  let auditTotalPaidFound = 0;

  for (let i = 1; i < paidData.length; i++) {
    const key       = cleanId(paidData[i][0]) + "_" + String(paidData[i][1]).trim();
    const totalPaid = toNumber(paidData[i][2]);
    if (totalPaid > 0) {
      paidMap.set(key, (paidMap.get(key) || 0) + totalPaid);
      auditTotalPaidFound += totalPaid;
    }
  }
  Logger.log(`   ├─ Paid map: ${paidMap.size} entries, ₹${auditTotalPaidFound.toLocaleString('en-IN', {maximumFractionDigits:0})} total.`);

  // Write waterfall headers to cols K-P
  accSheet.getRange(1, 11, 1, 6).setValues([["Total Paid","Paid 0-3","Paid 4-6","Paid 7-12","Paid 13-24","Paid >24"]])
    .setBackground("#F1F5F9").setFontColor("#334155").setFontWeight("bold");

  // Load accrued data and run waterfall math
  const accLastRow = accSheet.getLastRow();
  const accData    = safeGet(VINTAGE_VIEW3_ID, `${accTabName}!A1:H${accLastRow}`);
  const waterfallUpdates = [];
  let auditAllocated = 0, auditOverpaid = 0, auditWithPayments = 0;

  for (let i = 1; i < accData.length; i++) {
    const row = accData[i];
    const key = cleanId(row[0]) + "_" + String(row[1]).trim();

    let remPaid          = paidMap.get(key) || 0;
    const totalPaidTracker = remPaid;
    if (totalPaidTracker > 0) { auditWithPayments++; paidMap.delete(key); }

    // Accrued caps (cols D-H = indices 3-7) — waterfall oldest-first
    const cap0_3    = toNumber(row[3]);
    const cap4_6    = toNumber(row[4]);
    const cap7_12   = toNumber(row[5]);
    const cap13_24  = toNumber(row[6]);
    const capAbv24  = toNumber(row[7]);

    let paidAbv24 = Math.min(remPaid, capAbv24);  remPaid -= paidAbv24;
    let paid13_24 = Math.min(remPaid, cap13_24);  remPaid -= paid13_24;
    let paid7_12  = Math.min(remPaid, cap7_12);   remPaid -= paid7_12;
    let paid4_6   = Math.min(remPaid, cap4_6);    remPaid -= paid4_6;
    let paid0_3   = Math.min(remPaid, cap0_3);    remPaid -= paid0_3;

    auditAllocated += (totalPaidTracker - remPaid);

    // Overpayments overflow into 0-3 bucket
    if (remPaid > 0) { paid0_3 += remPaid; auditOverpaid += remPaid; }

    waterfallUpdates.push([totalPaidTracker, paid0_3, paid4_6, paid7_12, paid13_24, paidAbv24]);
  }

  // Batch write K-P
  const optimal = getOptimalBatchSize(waterfallUpdates.length, accTabName);
  for (let i = 0; i < waterfallUpdates.length; i += optimal.limit) {
    const chunk = waterfallUpdates.slice(i, i + optimal.limit);
    safeUpdate(
      { values: chunk },
      VINTAGE_VIEW3_ID,
      `${accTabName}!K${2 + i}:P${2 + i + chunk.length - 1}`,
      { valueInputOption: "RAW" }
    );
  }

  // Audit report
  Logger.log(`   ├─ Rows processed: ${(accData.length - 1).toLocaleString('en-IN')}`);
  Logger.log(`   ├─ Rows with payments: ${auditWithPayments.toLocaleString('en-IN')}`);
  Logger.log(`   ├─ ₹ Allocated: ${auditAllocated.toLocaleString('en-IN', {maximumFractionDigits:0})}`);
  if (auditOverpaid > 0)    Logger.log(`   ⚠️ Overpayments: ₹${auditOverpaid.toLocaleString('en-IN', {maximumFractionDigits:0})} (grouped into 0-3m bucket).`);
  const orphanCount = paidMap.size;
  if (orphanCount > 0) {
    let orphanMoney = 0; paidMap.forEach(v => orphanMoney += v);
    Logger.log(`   🚨 Orphans: ${orphanCount} payment records (₹${orphanMoney.toLocaleString('en-IN', {maximumFractionDigits:0})}) not in accrued sheet.`);
  } else {
    Logger.log("   └─ 🟢 100% of payments mapped to accrued leads.");
  }
}


// ─── SUMMARY UI ───────────────────────────────────────────────────────────────

/**
 * Unified summary builder — writes the Summary tab on the given spreadsheet.
 * Row structure per bucket: Accrued → Paid → Remaining → Recovery %
 * Includes heatmap on Accrued rows and percentage formatting on Recovery % rows.
 */
function _buildSummaryUI(ss, dueStats, createdStats) {
  let summarySheet = ss.getSheetByName("Summary");
  if (!summarySheet) summarySheet = ss.insertSheet("Summary");

  summarySheet.clear();
  if (summarySheet.getFilter()) summarySheet.getFilter().remove();
  summarySheet.showRows(1, summarySheet.getMaxRows());

  // Ensure enough physical rows (4 rows per bucket × ~12 buckets × 3 tables + buffers)
  if (summarySheet.getMaxRows() < 250) {
    summarySheet.insertRowsAfter(summarySheet.getMaxRows(), 250 - summarySheet.getMaxRows());
  }
  summarySheet.setHiddenGridlines(true);

  // Generate 6 tables: Due + Created × Total + Bounce + Penal
  const dueTotalRows     = _generateTableData((dueStats     || {}).total  || {});
  const createdTotalRows = _generateTableData((createdStats || {}).total  || {});
  const dueBounceRows    = _generateTableData((dueStats     || {}).bounce || {});
  const createdBounceRows= _generateTableData((createdStats || {}).bounce || {});
  const duePenalRows     = _generateTableData((dueStats     || {}).penal  || {});
  const createdPenalRows = _generateTableData((createdStats || {}).penal  || {});

  // Layout: 3 table groups stacked vertically, Due left (col 2), Created right (col 11)
  const rowsPerTable = dueTotalRows.length + 2; // +2 for title + header rows
  const verticalGap  = 4;
  const row1Start    = 2;
  const row2Start    = row1Start + rowsPerTable + verticalGap;
  const row3Start    = row2Start + rowsPerTable + verticalGap;
  const dueCol       = 2;
  const createdCol   = 11;

  Logger.log("   ├─ Rendering Due Date tables...");
  _renderStyledTable(summarySheet, row1Start, dueCol,     "Due Date Vintage (TOTAL)",        "#4F46E5", VINTAGE_SUB_HEADERS, dueTotalRows);
  _renderStyledTable(summarySheet, row2Start, dueCol,     "Due Date Vintage (BOUNCE)",       "#4F46E5", VINTAGE_SUB_HEADERS, dueBounceRows);
  _renderStyledTable(summarySheet, row3Start, dueCol,     "Due Date Vintage (PENAL)",        "#4F46E5", VINTAGE_SUB_HEADERS, duePenalRows);

  Logger.log("   ├─ Rendering Created Date tables...");
  _renderStyledTable(summarySheet, row1Start, createdCol, "Created Date Vintage (TOTAL)",    "#E11D48", VINTAGE_SUB_HEADERS, createdTotalRows);
  _renderStyledTable(summarySheet, row2Start, createdCol, "Created Date Vintage (BOUNCE)",   "#E11D48", VINTAGE_SUB_HEADERS, createdBounceRows);
  _renderStyledTable(summarySheet, row3Start, createdCol, "Created Date Vintage (PENAL)",    "#E11D48", VINTAGE_SUB_HEADERS, createdPenalRows);

  // Column widths
  summarySheet.setColumnWidth(1, 30);
  summarySheet.setColumnWidth(2, 110);
  summarySheet.setColumnWidth(3, 85);
  for (let c = 4; c <= 9;  c++) summarySheet.setColumnWidth(c, 115);
  summarySheet.setColumnWidth(10, 40);
  summarySheet.setColumnWidth(11, 110);
  summarySheet.setColumnWidth(12, 85);
  for (let c = 13; c <= 18; c++) summarySheet.setColumnWidth(c, 115);

  Logger.log("   └─ Summary tab written.");
}


/**
 * Generates table row data for one stats object (total, bounce, or penal).
 * Row structure per bucket: Accrued → Paid → Remaining → Recovery %
 */
function _generateTableData(stats) {
  const rows = [];
  const calcPct = (paid, acc) => acc > 0 ? (paid / acc) : 0;

  // Running totals for workable and grand
  let accW = [0,0,0,0,0,0], paidW = [0,0,0,0,0,0];
  let accG = [0,0,0,0,0,0], paidG = [0,0,0,0,0,0];

  const processBucket = (bkt, isWorkable) => {
    const s        = stats[bkt] || { accrued: [0,0,0,0,0], paid: [0,0,0,0,0] };
    const accVals  = s.accrued;
    const paidVals = s.paid;
    const accTot   = accVals.reduce((a, v) => a + v, 0);
    const paidTot  = paidVals.reduce((a, v) => a + v, 0);
    const remVals  = accVals.map((v, i) => v - paidVals[i]);
    const remTot   = accTot - paidTot;
    const pctVals  = accVals.map((v, i) => calcPct(paidVals[i], v));
    const pctTot   = calcPct(paidTot, accTot);

    rows.push([bkt, "Accrued",    ...accVals,  accTot ]);
    rows.push([bkt, "Paid",       ...paidVals, paidTot]);
    rows.push([bkt, "Remaining",  ...remVals,  remTot ]);
    rows.push([bkt, "Recovery %", ...pctVals,  pctTot ]);

    accVals.forEach((v, i)  => { if (isWorkable) accW[i]  += v; accG[i]  += v; });
    paidVals.forEach((v, i) => { if (isWorkable) paidW[i] += v; paidG[i] += v; });
    if (isWorkable) { accW[5]  += accTot;  paidW[5] += paidTot; }
    accG[5]  += accTot; paidG[5] += paidTot;
  };

  VINTAGE_WORKABLE_BUCKETS.forEach(b    => processBucket(b, true));
  const remW = accW.map((v, i) => v - paidW[i]);
  rows.push(["Workable Total", "Accrued",    ...accW.slice(0,5),  accW[5] ]);
  rows.push(["Workable Total", "Paid",       ...paidW.slice(0,5), paidW[5]]);
  rows.push(["Workable Total", "Remaining",  ...remW.slice(0,5),  remW[5] ]);
  rows.push(["Workable Total", "Recovery %", ...accW.slice(0,5).map((v,i) => calcPct(paidW[i],v)), calcPct(paidW[5],accW[5])]);

  VINTAGE_NONWORKABLE_BUCKETS.forEach(b => processBucket(b, false));
  const remG = accG.map((v, i) => v - paidG[i]);
  rows.push(["Grand Total", "Accrued",    ...accG.slice(0,5),  accG[5] ]);
  rows.push(["Grand Total", "Paid",       ...paidG.slice(0,5), paidG[5]]);
  rows.push(["Grand Total", "Remaining",  ...remG.slice(0,5),  remG[5] ]);
  rows.push(["Grand Total", "Recovery %", ...accG.slice(0,5).map((v,i) => calcPct(paidG[i],v)), calcPct(paidG[5],accG[5])]);

  return rows;
}


/**
 * Renders one styled table to the sheet at (startRow, startCol).
 * Applies heatmap to Accrued rows, % format to Recovery rows, ₹ format to Accrued/Paid/Remaining.
 */
function _renderStyledTable(sheet, startRow, startCol, title, titleColor, subHeaders, rows) {
  // Title row
  sheet.getRange(startRow, startCol, 1, 8).merge().setValue(title)
    .setBackground(titleColor).setFontColor("white")
    .setFontWeight("bold").setHorizontalAlignment("center").setFontSize(11);

  // Header row
  sheet.getRange(startRow + 1, startCol, 1, 8).setValues([subHeaders])
    .setBackground("#F8FAFC").setFontColor("#334155")
    .setFontWeight("bold").setHorizontalAlignment("center");

  // Data
  const dataRng = sheet.getRange(startRow + 2, startCol, rows.length, 8);
  dataRng.setValues(rows);

  // Find max accrued value for heatmap scaling (excludes totals)
  let maxAccrued = 0;
  rows.forEach(row => {
    if (row[1] === "Accrued" && row[0] !== "Workable Total" && row[0] !== "Grand Total") {
      for (let j = 2; j < 8; j++) { if (row[j] > maxAccrued) maxAccrued = row[j]; }
    }
  });

  const heatmapColor = (val) => {
    if (!val || val <= 0 || maxAccrued === 0) return null;
    const ratio = Math.min(val / maxAccrued, 1);
    const r = Math.round(255 - ratio * (255 - 252));
    const g = Math.round(255 - ratio * (255 - 165));
    const b = Math.round(255 - ratio * (255 - 165));
    const h = n => n.toString(16).padStart(2,'0');
    return `#${h(r)}${h(g)}${h(b)}`;
  };

  // Build bulk styling arrays
  const backgrounds = [], fontColors = [], fontWeights = [], fontStyles = [], numberFormats = [];

  rows.forEach((row, i) => {
    const bgRow = [], colorRow = [], weightRow = [], styleRow = [], formatRow = [];
    const isAccrued   = row[1] === "Accrued";
    const isPaid      = row[1] === "Paid";
    const isRemaining = row[1] === "Remaining";
    const isPct       = row[1] === "Recovery %";
    const isWorkable  = row[0] === "Workable Total";
    const isGrand     = row[0] === "Grand Total";

    // Groups of 4 rows (Accrued, Paid, Remaining, Recovery%)
    const isShadedGroup = (i % 8 < 4);

    for (let j = 0; j < 8; j++) {
      let bg     = isShadedGroup ? "#F8FAFC" : "#FFFFFF";
      let color  = "#1E293B";
      let weight = "normal";
      let style  = "normal";
      let format = "[$₹-en-IN]#,##,##0";

      // Text format for first 2 cols (BKT + Metric)
      if (j < 2) format = "@";
      // Percentage format for Recovery % rows
      else if (isPct) format = "0.0%";

      // Heatmap on non-total Accrued rows
      if (isAccrued && j >= 2 && !isWorkable && !isGrand && row[j] > 0) {
        bg = heatmapColor(row[j]);
      }

      // Totals styling
      if (isWorkable) {
        bg     = isAccrued ? "#DCFCE7" : isPaid ? "#F0FDF4" : isRemaining ? "#EFF6FF" : "#F4FBF6";
        color  = isAccrued || isPaid || isRemaining ? "#166534" : "#1E40AF";
        weight = "bold";
      } else if (isGrand) {
        bg     = isAccrued ? "#FFE4E6" : isPaid ? "#FFF1F2" : isRemaining ? "#EFF6FF" : "#FFF5F6";
        color  = isAccrued || isPaid || isRemaining ? "#9F1239" : "#1E40AF";
        weight = "bold";
      }

      // Mute secondary metric labels
      if (!isWorkable && !isGrand && j === 1) {
        if (isPaid)      { color = "#475569"; style = "italic"; }
        if (isRemaining) { color = "#3B82F6"; style = "italic"; }
        if (isPct)       { color = "#64748B"; style = "italic"; }
      }
      if (isPct && j >= 2 && !isWorkable && !isGrand) color = "#334155";

      bgRow.push(bg); colorRow.push(color); weightRow.push(weight);
      styleRow.push(style); formatRow.push(format);
    }
    backgrounds.push(bgRow); fontColors.push(colorRow); fontWeights.push(weightRow);
    fontStyles.push(styleRow); numberFormats.push(formatRow);
  });

  // Apply all styling in bulk (6 API calls total regardless of row count)
  dataRng.setBackgrounds(backgrounds);
  dataRng.setFontColors(fontColors);
  dataRng.setFontWeights(fontWeights);
  dataRng.setFontStyles(fontStyles);
  dataRng.setNumberFormats(numberFormats);

  // Row heights, alignment, borders
  const totalRows = rows.length + 2;
  sheet.setRowHeights(startRow, totalRows, 34);
  sheet.getRange(startRow, startCol, totalRows, 8).setVerticalAlignment("middle");
  sheet.getRange(startRow + 2, startCol, rows.length, 2).setHorizontalAlignment("left");
  sheet.getRange(startRow + 2, startCol + 2, rows.length, 6).setHorizontalAlignment("center");

  // Outer border + header border
  sheet.getRange(startRow, startCol, totalRows, 8)
    .setBorder(true, true, true, true, false, false, "#CBD5E1", SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(startRow + 1, startCol, 1, 8)
    .setBorder(null, null, true, null, false, false, "#CBD5E1", SpreadsheetApp.BorderStyle.SOLID);

  // Inner horizontal borders every 4 rows (after Recovery % row of each bucket)
  for (let r = 0; r < rows.length - 1; r += 4) {
    sheet.getRange(startRow + 2 + r + 3, startCol, 1, 8)
      .setBorder(false, false, true, false, false, false, "#E2E8F0", SpreadsheetApp.BorderStyle.SOLID);
  }
}