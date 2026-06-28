/**
 * ==============================================================================
 * 1. MATERIALIZED VIEW GENERATOR: PAYMENT SUMMARY AGGREGATOR (V5 - Long Table)
 * ==============================================================================
 * Reads raw transaction logs and aggregates them into a multi-dimensional 
 * summary table grouped by Lead ID and Charge Type (Total, Bounce, Penal).
 */

function runPaymentSummary(job, startTime, scheduleMode) {
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING PAYMENT SUMMARY AGGREGATOR (${job.name})`);
  Logger.log(`=======================================================`);
  updateJobStatus(job.configRow, "⚙️ Aggregating...");

  const srcSheet = safeOpenById(job.srcId).getSheetByName(job.srcTab);
  const dstSS = safeOpenById(job.dstId);
  let dstSheet = dstSS.getSheetByName(job.dstTab);
  
  if (!dstSheet) {
    dstSheet = dstSS.insertSheet(job.dstTab);
    Logger.log(`✨ Created new Summary Tab: ${job.dstTab}`);
  }

  const srcMaxRow = srcSheet.getLastRow();
  const srcMaxCol = srcSheet.getLastColumn();
  
  if (srcMaxRow < 2) {
    Logger.log("⚠️ No raw payment data found. Aborting.");
    updateJobStatus(job.configRow, "⚠️ Skipped (No Data)");
    return true;
  }

  // --- 1. DYNAMIC HEADER MAPPING ---
  Logger.log("🗺️ Mapping column headers...");
  const headers = srcSheet.getRange(1, 1, 1, srcMaxCol).getValues()[0].map(h => String(h).trim().toLowerCase());
  
  const colLan = headers.indexOf("lan");
  const colAmt = headers.indexOf("total_allocated_amount");
  const colType = headers.indexOf("payment_type");
  const colApp = headers.findIndex(h => h.includes("app payment")); 
  const colCharge = headers.findIndex(h => h.includes("charge_type") || h.includes("charge type")); 
  const colDate = 5; // Column F (Index 5)

  if (colLan === -1 || colAmt === -1 || colType === -1) {
    Logger.log("❌ CRITICAL ERROR: Could not find required headers.");
    updateJobStatus(job.configRow, "❌ Error: Missing Headers");
    return false;
  }

  // --- 2. HASH MAP AGGREGATOR ---
  const BATCH_SIZE = 50000; 
  const summaryMap = new Map();
  let totalRowsRead = 0;

  // Helper to create an empty tracking bucket
  const createSubBucket = () => ({ nach: 0, upi: 0, app: 0, others: 0, total: 0, latestTs: -9999999999999 });

  Logger.log(`🧮 Aggregating up to ${srcMaxRow - 1} rows into RAM...`);

  for (let startRow = 2; startRow <= srcMaxRow; startRow += BATCH_SIZE) {
    const numRows = Math.min(BATCH_SIZE, srcMaxRow - startRow + 1);
    const rawDataChunk = withExponentialBackoff(() => srcSheet.getRange(startRow, 1, numRows, srcMaxCol).getValues());
    
    totalRowsRead += rawDataChunk.length;

    for (let i = 0; i < rawDataChunk.length; i++) {
      const row = rawDataChunk[i];
      const lan = cleanId(row[colLan]);
      if (!lan) continue;

      const amt = toNumber(row[colAmt]) || 0;
      const pType = String(row[colType]).trim();
      const isAppPaid = colApp !== -1 ? String(row[colApp]).trim().toLowerCase() : "";
      const isAppFlagged = (isAppPaid === "yes" || isAppPaid === "true" || isAppPaid === "app paid");
      const chargeType = colCharge !== -1 ? String(row[colCharge]).trim() : "";
      const dateTs = parseTimestampToMs(row[colDate]);

      // Initialize the multi-dimensional bucket for this Lead
      if (!summaryMap.has(lan)) {
        summaryMap.set(lan, {
          overall: createSubBucket(),
          bounce: createSubBucket(),
          penal: createSubBucket()
        });
      }

      const leadData = summaryMap.get(lan);

      // Routing logic packaged as a quick inline function
      const processAmt = (targetBucket) => {
        if (pType === "3" || pType === "19") targetBucket.nach += amt;
        else if (pType === "11") {
          targetBucket.upi += amt; 
          if (isAppFlagged) targetBucket.app += amt; 
        } else {
          targetBucket.others += amt; 
        }
        
        targetBucket.total += amt; 
        if (dateTs > targetBucket.latestTs) targetBucket.latestTs = dateTs;
      };

      // 1. ALWAYS add to the Overall Total row
      processAmt(leadData.overall);

      // 2. Add to Bounce if applicable
      if (chargeType === "2") processAmt(leadData.bounce);

      // 3. Add to Penal if applicable
      if (chargeType === "4") processAmt(leadData.penal);
    }
  }

  // --- 3. BUILD OUTPUT ARRAY (Sparse Generation) ---
  Logger.log(`📋 Compiling final output...`);
  const outputArray = [["Lead ID", "NACH", "UPI", "App", "Others", "Sum", "Latest Date", "Row Type"]];
  const tz = GLOBAL_TZ;
  
  let generatedRows = 0;

  const pushToOutput = (lan, bucket, label) => {
    // 🛡️ SPARSE GENERATION: Only generate Bounce/Penal rows if they actually have money in them
    if (label !== "Total" && bucket.total <= 0) return;

let rawDateNumber = "";
    if (bucket.latestTs !== -9999999999999) {
      // Passes the native Date object. The Advanced API's "USER_ENTERED" option 
      // will automatically convert this into a raw Sheets serial number.
      const localMs = bucket.latestTs + 19800000; 
      rawDateNumber = (localMs / 86400000) + 25569;
      
    }

    outputArray.push([
      lan,
      Math.round(bucket.nach * 100) / 100,
      Math.round(bucket.upi * 100) / 100,
      Math.round(bucket.app * 100) / 100,
      Math.round(bucket.others * 100) / 100,
      Math.round(bucket.total * 100) / 100,
      rawDateNumber,
      label
    ]);
    generatedRows++;
  };

  summaryMap.forEach((leadData, lan) => {
    pushToOutput(lan, leadData.overall, "Total");
    pushToOutput(lan, leadData.bounce, "Bounce");
    pushToOutput(lan, leadData.penal, "Penal");
  });

  Logger.log(`   ├─ Unique Leads Processed: ${summaryMap.size}`);
  Logger.log(`   └─ Total Matrix Rows Generated: ${generatedRows}`);

  // --- 4. ADVANCED API WRITE-BACK ---
  const WRITE_CHUNK = 50000; 
  Logger.log(`📝 Writing payload to Destination...`);
  
  withExponentialBackoff(() => {
    dstSheet.clearContents(); 
    // Expanded to 8 columns (A to H)
    dstSheet.getRange(1, 1, 1, 8).setValues([outputArray[0]]);
    dstSheet.getRange("A1:H1").setFontWeight("bold").setBackground("#f3f3f3");
    SpreadsheetApp.flush();
  });

  const dataOnly = outputArray.slice(1);
  for (let w = 0; w < dataOnly.length; w += WRITE_CHUNK) {
    const chunk = dataOnly.slice(w, w + WRITE_CHUNK);
    const writeStartRow = w + 2; 
    
    // Target range is now A to H
    const targetRange = `${job.dstTab}!A${writeStartRow}:H${writeStartRow + chunk.length - 1}`;
    safeUpdate({ values: chunk }, job.dstId, targetRange, { valueInputOption: "USER_ENTERED" });
  }

  updateJobStatus(job.configRow, "✅ Success");
  Logger.log(`✅ Payment Summary Complete!`);
  
  return true; 
}