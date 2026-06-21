/**
 * ==============================================================================
 * PART 1: LOOKUP JOIN ENGINE (Audited & Rounded)
 * ==============================================================================
 */
function runLookupJoin(job, startTime, scheduleMode) {
  const props = PropertiesService.getScriptProperties();

  if (checkAndSetRelay(startTime, job, scheduleMode, props)) return false;

  Logger.log(`🔗 [${job.name}] Building join map from ${job.srcTab}...`);
  const srcLastRow = safeOpenById(job.srcId).getSheetByName(job.srcTab).getLastRow();
  const srcData = safeGet(job.srcId, `${job.srcTab}!A1:D${srcLastRow}`);

  const joinMap = new Map();
  for (let i = 1; i < srcData.length; i++) { 
    const key = cleanId(srcData[i][0]); 
    if (key) joinMap.set(key, [ srcData[i][1] ?? "", srcData[i][2] ?? "", srcData[i][3] ?? "" ]);
  }
  Logger.log(`✅ [${job.name}] Join map built (${joinMap.size} keys).`);

  const dstSheet = safeOpenById(job.dstId).getSheetByName(job.dstTab);
  const dstLastRow = dstSheet.getLastRow();

  if (dstLastRow <= 1) {
    Logger.log(`⚠️ [${job.name}] Destination is empty. Skipping.`);
    updateJobStatus(job.configRow, "⚠️ Skipped (Destination Empty)");
    return true;
  }

  const config = getOptimalBatchSize(dstLastRow, job.dstTab);
  const BATCH = config.batch;
  const SAFE_BATCH_LIMIT = config.limit;  
  const NOT_FOUND = "Lead not in Master Data";
  const AWAITING = "Awaiting Lead ID";

  // 📊 AUDIT TRACKERS
  let tallyMatched = 0; let tallyNotFound = 0; let tallyAwaiting = 0;

  for (let startRow = 2; startRow <= dstLastRow; startRow += BATCH) {
    if (checkAndSetRelay(startTime, job, scheduleMode, props)) return false;

    const numRows = Math.min(BATCH, dstLastRow - startRow + 1);
    const ids = safeGet(job.dstId, `${job.dstTab}!A${startRow}:A${startRow + numRows - 1}`);

    const output = ids.map((row, i) => {
      const id = cleanId(row[0]);
      let res;
      
      if (!id) { 
        tallyAwaiting++; 
        res = [AWAITING, AWAITING, AWAITING, AWAITING]; 
      } else {
        const match = joinMap.get(id);
        if (match) { 
          tallyMatched++; 
          const bounceCount = match[0];
          const bounceCharges = Math.round(toNumber(String(match[1]).replace(/,/g, '')) || 0);
          const lateCharges = Math.round(toNumber(String(match[2]).replace(/,/g, '')) || 0);
          const totalSum = bounceCharges + lateCharges;
          
          res = [bounceCount, bounceCharges, lateCharges, totalSum]; 
        } else { 
          tallyNotFound++; 
          res = [NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND]; 
        }
      }

      // 🔍 DIAGNOSTIC WINDOW
      if (startRow === 2 && i < 3) {
        Logger.log(`🔍 [AUDIT Row ${startRow + i}] ID: ${id} | Bounce: ${res[0]} | Charges: ${res[1]} | Late: ${res[2]} | Total (L): ${res[3]}`);
      }
      return res;
    });

    const blockIdx = Math.floor((startRow - 2) / BATCH);
    const hashResult = checkHashState(output, job.name, blockIdx, props);

    if (hashResult !== true) {
      safeBatchUpdate(job.dstId, [{ range: `'${job.dstTab}'!I${startRow}:L${startRow + numRows - 1}`, values: output }]);
      SpreadsheetApp.flush(); 
      props.setProperty(`H_${job.name}_B${blockIdx}`, hashResult);
      Logger.log(`✅ [${job.name}] Block ${blockIdx}: Joined ${output.length} rows.`);
    }
  }

  // --- FINAL AUDIT REPORT ---
  Logger.log(`📊 ==== LOOKUP JOIN SUMMARY ====`);
  Logger.log(`   ├─ Matched Leads   : ${tallyMatched}`);
  Logger.log(`   ├─ Not Found Leads : ${tallyNotFound}`);
  Logger.log(`   └─ Awaiting ID     : ${tallyAwaiting}`);
  Logger.log(`📊 =============================`);

  const maxBlockIdx = Math.floor((dstLastRow - 2) / BATCH);
  cleanUpJobProperties(job.name, maxBlockIdx);
  updateJobStatus(job.configRow, "✅ Join Complete");
  return true;
}



/**
 * ==============================================================================
 * PART 2: DISCOUNT CALCULATOR (Advanced API Edition)
 * ==============================================================================
 */

function calculatediscountamt(PENAL_ID) {
  // We no longer need to heavily instantiate the sheets!
  const targetSheetName = "2. PENAL DATA";
  const waiverSheetName = "Closed_Waiver_Approved";

  // Use the standard AppScript just to get the max rows efficiently
  const targetSheet = safeOpenById(PENAL_ID).getSheetByName(targetSheetName);
  const waiverSheet = safeOpenById(PENAL_ID).getSheetByName(waiverSheetName);
  
  if (!targetSheet || !waiverSheet) { Logger.log("❌ Error: Could not find Penal Data or Waiver sheets."); return; }

  const targetMaxRow = targetSheet.getLastRow();
  const config = getOptimalBatchSize(targetMaxRow, targetSheetName);
  const BATCH = config.batch;
  const SAFE_BATCH_LIMIT = config.limit;

  updateModuleStatus("R2", "⏳ Discount: Calculating...");
  const waiverMaxRow = waiverSheet.getLastRow();
  const waiverMap = new Map();

  // 🚀 ADVANCED API: Reading Waiver Data
  if (waiverMaxRow > 1) {
    const waiverData = safeGet(PENAL_ID, `${waiverSheetName}!A2:C${waiverMaxRow}`);
    for (let i = 0; i < waiverData.length; i++) {
      const lid = cleanId(waiverData[i][0]);
      if (lid) waiverMap.set(lid, toNumber(String(waiverData[i][2] || "0").replace(/,/g, '')) || 0);
    }
  }

  // 🚀 ADVANCED API: Reading Matrix Data
  const matrix = safeGet(PENAL_ID, `${waiverSheetName}!F2:H6`);
  
  const rowThresholds = [0, 1001, 5001, 10001, 25001]; 
  const colThresholds = [0, 7, 13];

  let tallyPaid = 0; let tallyNA = 0; let tallyDiscount = 0;
  
  const props = PropertiesService.getScriptProperties(); 
  let maxDiscountBlock = -1;

  Logger.log("🔍 Calculating Discounts in batches...");

  for (let startRow = 2; startRow <= targetMaxRow; startRow += BATCH) {
    const numRows = Math.min(BATCH, targetMaxRow - startRow + 1);
    
    // 🚀 ADVANCED API: Batched Read (Cols A to AH is 34 columns)
    const targetDataChunk = safeGet(PENAL_ID, `${targetSheetName}!A${startRow}:AH${startRow + numRows - 1}`);

    const outputChunk = [];
    for (let i = 0; i < targetDataChunk.length; i++) {
      const lid         = cleanId(targetDataChunk[i][0]);
      const totalCharge = toNumber(String(targetDataChunk[i][11] || "0").replace(/,/g, '')) || 0;
      const status      = String(targetDataChunk[i][33] || "").trim().toUpperCase();

      const cMonths = waiverMap.has(lid) ? waiverMap.get(lid) : -99;
      let finalResult = "Not Applicable";

      if (lid === "") { finalResult = ""; } 
      else if (status === "FULL PAID") { finalResult = "Paid"; tallyPaid++; } 
      else if (cMonths === -99 || totalCharge < 100) { finalResult = "Not Applicable"; tallyNA++; } 
      else {
        let rIdx = 0; for (let r = rowThresholds.length - 1; r >= 0; r--) { if (totalCharge >= rowThresholds[r]) { rIdx = r; break; } }
        let cIdx = 0; for (let c = colThresholds.length - 1; c >= 0; c--) { if (cMonths >= colThresholds[c]) { cIdx = c; break; } }
        
        let discountPct = toNumber(String(matrix[rIdx]?.[cIdx] || "0").replace(/,/g, '')) || 0;
        
        // 🛡️ THE SHIELD: If the API pulled '15' instead of '0.15', convert it to a true percentage
        if (discountPct > 1) discountPct = discountPct / 100;
        
        finalResult = Math.round(totalCharge * discountPct);
        tallyDiscount++;
      }
      
      if (startRow === 2 && i < 3) {
        Logger.log(`🔍 [AUDIT Row ${startRow + i}] ID: ${lid} | Charge: ${totalCharge} | cMonths: ${cMonths} | Verdict: -> ${finalResult}`);
      }
      
      outputChunk.push([finalResult]);
    }

    if (outputChunk.length > 0) {
      for (let w = 0; w < outputChunk.length; w += SAFE_BATCH_LIMIT) {
        const smallChunk = outputChunk.slice(w, w + SAFE_BATCH_LIMIT);
        const currentRow = startRow + w;
        const blockIdx = Math.floor(currentRow / SAFE_BATCH_LIMIT);
        
        if (blockIdx > maxDiscountBlock) maxDiscountBlock = blockIdx;
        const hashResult = checkHashState(smallChunk, "Discount_Metrics", blockIdx, props);

        if (hashResult !== true) {
          // 🚀 ADVANCED API: Batched Write (Col 13 is Column M)
          const targetRange = `${targetSheetName}!M${currentRow}:M${currentRow + smallChunk.length - 1}`;
          safeUpdate({ values: smallChunk }, PENAL_ID, targetRange, { valueInputOption: "USER_ENTERED" });
          SpreadsheetApp.flush();
          props.setProperty(`H_Discount_Metrics_B${blockIdx}`, hashResult);
        }
      }
    }
  }

  Logger.log(`📊 ==== DISCOUNT SUMMARY ====`);
  Logger.log(`   ├─ Discounts Applied : ${tallyDiscount}`);
  Logger.log(`   ├─ Already Paid      : ${tallyPaid}`);
  Logger.log(`   └─ Not Applicable    : ${tallyNA}`);
  Logger.log(`📊 ==========================`);

  if (maxDiscountBlock >= 0) cleanUpJobProperties("Discount_Metrics", maxDiscountBlock);
  Logger.log("✅ Discount Calculations Complete.");
  updateModuleStatus("R2", "✅ Discount: Complete");
}

/**
 * ==============================================================================
 * PART 3:🎯 DEDICATED ENGINE: PENAL DATA CONDITIONAL LOOKUP
 * ==============================================================================
 */
function runSumJoin(job, startTime, scheduleMode) {
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING PENAL DATA LOOKUP (${job.name})`);
  Logger.log(`=======================================================`);
  updateJobStatus(job.configRow, "⚙️ Loading Aggregated Data...");

  // --- BUILD LOOKUP MAP FROM SOURCE ---
  const ssSrc = safeOpenById(job.srcId);
  const srcSheet = ssSrc.getSheetByName(job.srcTab);
  const srcLastRow = srcSheet.getLastRow();

  if (srcLastRow < 2) {
    Logger.log("⚠️ Source data is empty. Skipping.");
    updateJobStatus(job.configRow, "⚠️ Skipped (No Source)");
    return true;
  }

  const lookupMap = new Map();
  // 🚀 EXPANDED RANGE: A2:G to capture the new 7-column schema
  const rawSource = safeGet(job.srcId, `${job.srcTab}!A2:G${srcLastRow}`);
  
  for (let r of rawSource) {
    const lan = cleanId(r[0]);
    if (!lan) continue;
    
    // 🚀 NEW COLUMN INDEXES mapping to ImpRng_CBC_Payments
    const nachColl = toNumber(r[1]) || 0;    // Col B (Index 1)
    const totalColl = toNumber(r[5]) || 0;   // Col F (Index 5)
    const dateTs = parseTimestampToMs(r[6]);   // Col G (Index 6)
    
    // Safest calculation: Grand Total minus NACH
    const nonNach = totalColl - nachColl;

    if (!lookupMap.has(lan)) {
      lookupMap.set(lan, { nonNach, totalColl, dateTs });
    } else {
      const existing = lookupMap.get(lan);
      existing.nonNach += nonNach;
      existing.totalColl += totalColl;
      existing.dateTs = Math.max(existing.dateTs, dateTs);
    }
  }
  Logger.log(`✅ Dictionary Built: ${lookupMap.size} unique Lead IDs mapped.`);

  // --- SETUP DESTINATION ---
  const dstSheet = safeOpenById(job.dstId).getSheetByName(job.dstTab);
  const dstLastRow = dstSheet.getLastRow();
  if (dstLastRow < 2) return true;
  const tz = GLOBAL_TZ;

  // --- AUDIT TRACKERS (closure-captured) ---
  let tallySumMatched = 0;
  let tallySumDefault = 0;

  updateJobStatus(job.configRow, "⚙️ Writing Static Values...");

  // --- PROCESS VIA SHARED HELPER ---
  const complete = runBatchedRowProcessor({
    job, startTime, scheduleMode,
    dstLastRow,
    readRange: (sr, n) => `${job.dstTab}!A${sr}:A${sr + n - 1}`,
    writeRange: (sr, n) => `${job.dstTab}!P${sr}:R${sr + n - 1}`,
    transform: (row) => {
      const lan = cleanId(row[0]);
      if (lookupMap.has(lan)) {
        tallySumMatched++;
        const data = lookupMap.get(lan);
        const finalP = Math.round(data.nonNach * 100) / 100;
        const finalQ = Math.round(data.totalColl * 100) / 100;
        const finalR = data.dateTs > -9999999999999
          ? Utilities.formatDate(new Date(data.dateTs), tz, "dd-MM-yyyy")
          : "Not Found";
        return [finalP, finalQ, finalR];
      } else {
        tallySumDefault++;
        return [0, 0, "Not Found"];
      }
    },
    auditFirstN: (sr, i, raw, out) => {
      Logger.log(`🔍 [AUDIT Row ${sr + i}] ID: ${cleanId(raw[0])} | NonNach(P): ${out[0]} | Tot(Q): ${out[1]} | Date(R): ${out[2]}`);
    }
  });

  if (!complete) return false;

  // --- FINAL AUDIT REPORT ---
  Logger.log(`📊 ==== PENAL DATA LOOKUP SUMMARY ====`);
  Logger.log(`   ├─ Found & Calculated  : ${tallySumMatched}`);
  Logger.log(`   └─ Default (Zeroed)    : ${tallySumDefault}`);
  Logger.log(`📊 ===================================`);

  updateJobStatus(job.configRow, "✅ Success");
  Logger.log(`✅ Static Lookup Complete for ${dstLastRow - 1} rows.`);
  return true;
}

