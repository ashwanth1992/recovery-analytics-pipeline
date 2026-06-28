/**
 * ==============================================================================
 * 🔄 DEDICATED ENGINE: BASE DATA CONDITIONAL UPDATER (Audited & Hashed)
 * ==============================================================================
 */
function runBaseDataUpdate(job, startTime, scheduleMode) {
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING BASE DATA UPDATE (${job.name})`);
  Logger.log(`=======================================================`);
  updateJobStatus(job.configRow, "⚙️ Loading Maps...");

  const ss = safeOpenById(job.srcId);
  const baseSheet = ss.getSheetByName(job.srcTab);
  const lastRow = baseSheet.getLastRow();

  if (lastRow < 2) {
    Logger.log("⚠️ Base_Data is empty. Aborting.");
    updateJobStatus(job.configRow, "⚠️ Skipped (Empty)");
    return true;
  }

  // --- 1. BUILD SURGICAL RAM MAPS ---
  const buildMap = (tabName, keyIdx, valIdx) => {
    const map = new Map();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return map;
    
    const maxRow = sheet.getLastRow();
    if (maxRow < 2) return map;
    
    const maxCol = Math.max(keyIdx, valIdx) + 1;
    const data = safeGet(job.srcId, `${tabName}!A2:${columnToLetter(maxCol)}${maxRow}`);
    
    for (let r of data) {
      const k = cleanId(r[keyIdx]);
      if (k) map.set(k, r[valIdx] === undefined ? "" : r[valIdx]);
    }
    return map;
  };

  const mapSME = buildMap("ImpRng_SME", 0, 1);       // Col A to Col B
  const mapPL = buildMap("ImpRng_PL", 0, 1);         // Col A to Col B
  const mapPB = buildMap("ImpRng_P&B", 0, 3);        // Col A to Col D
  // 🚀 UPDATED: Now points to Index 5 (Column F) for the Sum Total
  const mapCBC = buildMap("ImpRng_CBC_Payments", 0, 5); 

  Logger.log(`✅ Loaded into RAM -> SME: ${mapSME.size}, PL: ${mapPL.size}, P&B: ${mapPB.size}, CBC: ${mapCBC.size}`);

  // --- 2. STATE & GEARBOX SETUP ---
  const props = PropertiesService.getScriptProperties();
  const stateKeys = { read: `RD_${job.name}` };
  
  if (job.forceReset) props.deleteProperty(stateKeys.read);
  
  let readRow = parseInt(props.getProperty(stateKeys.read)) || 2;
  
  // ⚙️ GEARBOX ACTIVATED
  const config = getOptimalBatchSize(lastRow, job.srcTab); 
  const BATCH = config.batch;
  
  const HARD_STOP = MAX_EXECUTION_TIME_MS - 120000;

  // 📊 AUDIT TRACKERS
  let tallyClosed = 0;
  let tallyActiveSME = 0;
  let tallyActivePL = 0;
  let tallyNotFound = 0;
  let tallyChargesFound = 0;
  let tallyCollectionsFound = 0;

  updateJobStatus(job.configRow, "⚙️ Processing Rows...");

  // --- 3. BATCHED READ & IN-MEMORY COMPUTE ---
  while (readRow <= lastRow) {
    if (Date.now() - startTime > HARD_STOP) {
      props.setProperty("ACTIVE_RELAY", JSON.stringify({ 
        pipeline: scheduleMode, id: job.name, timestamp: Date.now(), count: 0 
      }));
      Logger.log(`⏳ [RELAY] Base Data Update yielded at row ${readRow}.`);
      updateJobStatus(job.configRow, "⏳ Waiting for relay trigger");
      return false; 
    }

    const numRows = Math.min(BATCH, lastRow - readRow + 1);
    const rawInputs = safeGet(job.srcId, `${job.srcTab}!A${readRow}:G${readRow + numRows - 1}`);
    const outputArray = [];

    for (let i = 0; i < rawInputs.length; i++) {
      const row = rawInputs[i];
      const leadId = cleanId(row[0]); 
      
      let finalStatus = "Not found";
      let finalCharge = 0;
      let finalCollected = 0;

      if (leadId) {
        // --- LOGIC 1: Paid Status (Col T) with Audit Logging ---
        const statusType = String(row[4] || "").trim(); // Col E
        const productType = String(row[6] || "").trim(); // Col G

        if (statusType.toLowerCase() === "closed") {
          finalStatus = "Closed";
          tallyClosed++;
        } else if (statusType.toLowerCase() === "active") {
          if (productType.toUpperCase() === "SME") {
            finalStatus = mapSME.has(leadId) ? mapSME.get(leadId) : "Not found";
            finalStatus !== "Not found" ? tallyActiveSME++ : tallyNotFound++;
          } else if (productType.toUpperCase() === "PL") {
            finalStatus = mapPL.has(leadId) ? mapPL.get(leadId) : "Not found";
            finalStatus !== "Not found" ? tallyActivePL++ : tallyNotFound++;
          } else {
            tallyNotFound++;
          }
        } else {
          tallyNotFound++;
        }

        // --- LOGIC 2: Charges & Collected (Col U & V) ---
        finalCharge = mapPB.has(leadId) ? (toNumber(mapPB.get(leadId)) || 0) : 0;
        finalCollected = mapCBC.has(leadId) ? (toNumber(mapCBC.get(leadId)) || 0) : 0;
        
        if (finalCharge > 0) tallyChargesFound++;
        if (finalCollected > 0) tallyCollectionsFound++;
      }

      // 🔍 DIAGNOSTIC WINDOW
      if (readRow === 2 && i < 3) {
        Logger.log(`🔍 [AUDIT Row ${readRow + i}] ID: ${leadId} | StatusType: ${String(row[4]||"")} | Prod: ${String(row[6]||"")} | -> Verdict: [Status: ${finalStatus}] [Charge: ${finalCharge}] [Collected: ${finalCollected}]`);
      }

      outputArray.push([finalStatus, finalCharge, finalCollected]);
    }

    // --- 4. SURGICAL WRITE-BACK (Refactored Hash Logic) ---
    if (outputArray.length > 0) {
      const blockIdx = Math.floor((readRow - 2) / BATCH);
      const hashResult = checkHashState(outputArray, job.name, blockIdx, props);

      if (hashResult !== true) {
        const targetRange = `${job.srcTab}!T${readRow}:V${readRow + outputArray.length - 1}`;
        safeUpdate({ values: outputArray }, job.srcId, targetRange, { valueInputOption: "USER_ENTERED" });
        props.setProperty(`H_${job.name}_B${blockIdx}`, hashResult);
        Logger.log(` ├─ Processed and Wrote rows ${readRow} to ${readRow + numRows - 1}.`);
      }
    }

    readRow += numRows;
    props.setProperty(stateKeys.read, readRow.toString());
  }

  // --- 5. FINAL AUDIT REPORT ---
  Logger.log(`📊 ========================================`);
  Logger.log(`📊 BASE DATA ENGINE SUMMARY`);
  Logger.log(`📊 ========================================`);
  Logger.log(`   ├─ Forced "Closed"        : ${tallyClosed}`);
  Logger.log(`   ├─ Active SME Matched     : ${tallyActiveSME}`);
  Logger.log(`   ├─ Active PL Matched      : ${tallyActivePL}`);
  Logger.log(`   ├─ Status "Not Found"     : ${tallyNotFound}`);
  Logger.log(`   ├─ Leads with Charges     : ${tallyChargesFound}`);
  Logger.log(`   └─ Leads with Collections : ${tallyCollectionsFound}`);
  Logger.log(`📊 ========================================`);

  // --- 6. CLEANUP ---
  const maxBlockIdx = Math.floor((lastRow - 2) / BATCH); 
  cleanUpJobProperties(job.name, maxBlockIdx);
  props.deleteProperty(stateKeys.read);
  updateJobStatus(job.configRow, "✅ Success");
  Logger.log(`✅ Base Data Update Complete! All ${lastRow - 1} rows processed.`);
  
  return true;
}