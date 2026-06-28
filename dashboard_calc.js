/**
 * ==============================================================================
 * 🎯 ALLOCATION ENGINE V2
 * ==============================================================================
 * Computes team allocation labels for Base_data (col K) and
 * P&B Charges Collection sheet (cols H, I, J).
 *
 * ALLOCATION LABELS (match dashboard row labels exactly):
 *   SME Team
 *   0 Bkt Active Inhouse
 *   0 Bkt Closed Inhouse
 *   1+ Inhouse
 *   Field Team
 *   0 Bkt Active DPD Zero
 *   0 Bkt Closed DPD Zero
 *   1+ DPD Zero
 *   0 Bkt Active Knowl
 *   0 Bkt Closed Knowl
 *   1+ Knowl
 *   Closed Unallocated
 *   0 Bkt Unallocated
 *   1+ Unallocated
 *   Not classified  (payments sheet only — lead not in base data)
 *
 * CONFLICT RESOLUTION:
 *   Base data:    first-match-wins (Inhouse > Field > DPD Zero > Knowl)
 *   Payments:     date-based — if payment date falls within agency allocation
 *                 window (allocDate → unallocDate), override base allocation
 *                 with agency label.
 *
 * ImpRng_Allocations column map:
 *   A  = 0 Bkt Inhouse Lead IDs
 *   C  = 1+ Inhouse Lead IDs
 *   E  = Field Team Lead IDs
 *   G  = Knowl Lead IDs
 *   H  = Knowl Allocation Date
 *   I  = Knowl Unallocation Date (blank = still active)
 *   K  = DPD Zero Lead IDs
 *   L  = DPD Zero Allocation Date
 *   M  = DPD Zero Unallocation Date (blank = still active)
 * ==============================================================================
 */


// ─── SHARED: Build all sets + conflict map from ImpRng_Allocations ───────────

/**
 * Reads ImpRng_Allocations and returns:
 *   sets:        { inhouse0bkt, inhouse1plus, field, knowl, dpdZero }
 *   conflictMap: Map<leadId, { agency, allocDateMs, unallocDateMs|null }>
 *                Only leads present in BOTH an inhouse set AND an agency set.
 *                If a lead conflicts with both Knowl and DPD Zero, DPD Zero wins
 *                (more recent allocation assumed — adjust if needed).
 */
function _buildAllocationSets(srcId, srcTab) {
  const srcSheet  = safeOpenById(srcId).getSheetByName(srcTab);
  const lastRow   = srcSheet.getLastRow();

  const sets = {
    inhouse0bkt:  new Set(),
    inhouse1plus: new Set(),
    field:        new Set(),
    knowl:        new Set(),
    dpdZero:      new Set()
  };

  // conflictMap: leadId → { agency, allocDateMs, unallocDateMs }
  const conflictMap = new Map();

  if (lastRow < 2) return { sets, conflictMap };

  // Read all 13 cols (A-M) in one REST call
  const raw = safeGet(srcId, `${srcTab}!A2:M${lastRow}`);

  // ── PASS 1: Build all sets ────────────────────────────────────────────────
  // Must complete before conflict detection so set membership is fully known
  // regardless of row order in the sheet.
  for (const r of raw) {
    const id0bkt  = cleanId(r[0]);  // Col A
    const id1plus = cleanId(r[2]);  // Col C
    const idField = cleanId(r[4]);  // Col E
    const idKnowl = cleanId(r[6]);  // Col G
    const idDpd   = cleanId(r[10]); // Col K

    if (id0bkt)  sets.inhouse0bkt.add(id0bkt);
    if (id1plus) sets.inhouse1plus.add(id1plus);
    if (idField) sets.field.add(idField);
    if (idKnowl) sets.knowl.add(idKnowl);
    if (idDpd)   sets.dpdZero.add(idDpd);
  }

  // ── PASS 2: Build conflict map ────────────────────────────────────────────
  // Now that all sets are complete, check intersections correctly.
  // DPD Zero overwrites Knowl if a lead conflicts with both.
  for (const r of raw) {
    const idKnowl          = cleanId(r[6]);
    const knowlAllocDate   = r[7]  ? parseTimestampToMs(r[7])  : 0;
    const knowlUnallocDate = r[8]  ? parseTimestampToMs(r[8])  : null;
    const idDpd            = cleanId(r[10]);
    const dpdAllocDate     = r[11] ? parseTimestampToMs(r[11]) : 0;
    const dpdUnallocDate   = r[12] ? parseTimestampToMs(r[12]) : null;

    if (idKnowl && knowlAllocDate &&
        (sets.inhouse0bkt.has(idKnowl) || sets.inhouse1plus.has(idKnowl))) {
      conflictMap.set(idKnowl, {
        agencyLabel0bktActive: "0 Bkt Active Knowl",
        agencyLabel0bktClosed: "0 Bkt Closed Knowl",
        agencyLabel1plus:      "1+ Knowl",
        allocDateMs:           knowlAllocDate,
        unallocDateMs:         knowlUnallocDate
      });
    }

    if (idDpd && dpdAllocDate &&
        (sets.inhouse0bkt.has(idDpd) || sets.inhouse1plus.has(idDpd))) {
      // DPD Zero overwrites Knowl conflict for the same lead
      conflictMap.set(idDpd, {
        agencyLabel0bktActive: "0 Bkt Active DPD Zero",
        agencyLabel0bktClosed: "0 Bkt Closed DPD Zero",
        agencyLabel1plus:      "1+ DPD Zero",
        allocDateMs:           dpdAllocDate,
        unallocDateMs:         dpdUnallocDate
      });
    }
  }

  Logger.log(`✅ Sets Built -> 0Bkt:${sets.inhouse0bkt.size} 1+:${sets.inhouse1plus.size} Field:${sets.field.size} Knowl:${sets.knowl.size} DPD:${sets.dpdZero.size} Conflicts:${conflictMap.size}`);
  return { sets, conflictMap };
}


// ─── BASE DATA ALLOCATION ─────────────────────────────────────────────────────

/**
 * Computes the base allocation label for a single lead.
 * First-match-wins: Inhouse > Field > DPD Zero > Knowl > Unallocated
 *
 * @param {string} id       - cleaned lead ID
 * @param {string} status   - "Active" | "Closed" | ...
 * @param {string} prod     - product type
 * @param {string} bucket   - DPD bucket e.g. "(1) 0", "(2) 0-30", "Closed"
 * @param {Object} sets     - the five allocation sets
 * @returns {string}        - allocation label
 */
function _computeBaseAllocation(id, status, prod, bucket, sets) {
  const is0bkt   = bucket === "(1) 0";
  const isClosed = status === "Closed";
  const isActive = status === "Active";

  // 1. SME always wins
  if (prod === "SME") return "SME Team";

  // 2. Inhouse 0-bkt (active and closed share the same set)
  if (sets.inhouse0bkt.has(id)) {
    if (isClosed) return "0 Bkt Closed Inhouse";
    if (is0bkt && isActive) return "0 Bkt Active Inhouse";
  }

  // 3. Inhouse 1+
  if (!is0bkt && isActive && sets.inhouse1plus.has(id)) return "1+ Inhouse";

  // 4. Field Team
  if (!is0bkt && isActive && sets.field.has(id)) return "Field Team";

  // 5. DPD Zero
  if (sets.dpdZero.has(id)) {
    if (isClosed) return "0 Bkt Closed DPD Zero";
    if (is0bkt && isActive) return "0 Bkt Active DPD Zero";
    if (!is0bkt && isActive) return "1+ DPD Zero";
  }

  // 6. Knowl
  if (sets.knowl.has(id)) {
    if (isClosed) return "0 Bkt Closed Knowl";
    if (is0bkt && isActive) return "0 Bkt Active Knowl";
    if (!is0bkt && isActive) return "1+ Knowl";
  }

  // 7. Unallocated
  if (isClosed) return "Closed Self Paid";
  if (is0bkt && isActive) return "0 Bkt Self Paid";
  if (!is0bkt && isActive) return "1+ Self Paid";

  return "Self Paid"; // fallback
}


/**
 * Resolves payment-sheet allocation using base data label + conflict map.
 * If payment date falls within agency window → override with agency label.
 *
 * @param {string} baseLabel      - allocation from base data (col K)
 * @param {string} bucket         - DPD bucket
 * @param {string} status         - lead status
 * @param {number} pmtDateMs      - payment date in ms
 * @param {Object} conflict       - conflict entry from conflictMap (or null)
 * @returns {string}              - final payment allocation label
 */
function _resolvePaymentAllocation(baseLabel, bucket, status, pmtDateMs, conflict) {
  if (!conflict || !pmtDateMs || pmtDateMs <= 0) return baseLabel;

  const is0bkt   = bucket === "(1) 0";
  const isClosed = status === "Closed";
  const isActive = status === "Active";

  const withinWindow = pmtDateMs >= conflict.allocDateMs &&
    (!conflict.unallocDateMs || pmtDateMs <= conflict.unallocDateMs);

  if (!withinWindow) return baseLabel;

  // Payment falls within agency window — use agency label
  if (isClosed) return conflict.agencyLabel0bktClosed;
  if (is0bkt && isActive) return conflict.agencyLabel0bktActive;
  if (!is0bkt && isActive) return conflict.agencyLabel1plus;

  return baseLabel; // fallback
}


// ─── FUNCTION 1: BASE DATA ALLOCATION ENGINE ─────────────────────────────────

function runAllocationUpdate(job, startTime, scheduleMode) {
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING ALLOCATION ENGINE V2 (${job.name})`);
  Logger.log(`=======================================================`);
  updateJobStatus(job.configRow, "⚙️ Loading Allocations...");

  // --- 1. BUILD SETS ---
  const { sets } = _buildAllocationSets(job.srcId, job.srcTab);

  // --- 2. PREPARE DESTINATION ---
  const dstSS    = safeOpenById(job.dstId);
  const dstSheet = dstSS.getSheetByName(job.dstTab);
  const dstLastRow = dstSheet.getLastRow();

  if (dstLastRow < 2) {
    Logger.log("⚠️ Base_data is empty. Skipping.");
    updateJobStatus(job.configRow, "⚠️ Skipped (Destination Empty)");
    return true;
  }

  const BATCH    = getOptimalBatchSize(dstLastRow, job.dstTab).batch;
  const props    = PropertiesService.getScriptProperties();
  const stateKey = `RD_${job.name}`;
  let startRow   = parseInt(props.getProperty(stateKey)) || 2;

  // Audit counters
  const tally = {};
  const inc   = (label) => { tally[label] = (tally[label] || 0) + 1; };

  updateJobStatus(job.configRow, "⚙️ Computing Allocations...");

  // --- 3. BATCHED PROCESS ---
  while (startRow <= dstLastRow) {
    if (checkAndSetRelay(startTime, job, scheduleMode, props)) return false;

    const numRows  = Math.min(BATCH, dstLastRow - startRow + 1);
    const rawBase  = safeGet(job.dstId, `${job.dstTab}!A${startRow}:H${startRow + numRows - 1}`);
    const outputArray = [];

    for (let i = 0; i < rawBase.length; i++) {
      const row    = rawBase[i];
      const id     = cleanId(row[0]);
      const status = String(row[3] || "").trim(); // Col D
      const prod   = String(row[5] || "").trim(); // Col F
      const bucket = String(row[7] || "").trim(); // Col H

      if (!id) { outputArray.push([""]); continue; }

      const label = _computeBaseAllocation(id, status, prod, bucket, sets);
      inc(label);
      outputArray.push([label]);

      if (startRow === 2 && i < 3) {
        Logger.log(`🔍 [AUDIT Row ${startRow + i}] ID:${id} Status:${status} Prod:${prod} Bkt:${bucket} → ${label}`);
      }
    }

    // --- 4. WRITE TO COL K ---
    if (outputArray.length > 0) {
      const blockIdx  = Math.floor((startRow - 2) / BATCH);
      const hashResult = checkHashState(outputArray, job.name, blockIdx, props);
      if (hashResult !== true) {
        safeUpdate({ values: outputArray }, job.dstId,
          `${job.dstTab}!K${startRow}:K${startRow + outputArray.length - 1}`,
          { valueInputOption: "USER_ENTERED" });
        props.setProperty(`H_${job.name}_B${blockIdx}`, hashResult);
        Logger.log(` ├─ Wrote rows ${startRow}–${startRow + numRows - 1}`);
      }
    }

    startRow += numRows;
    props.setProperty(stateKey, startRow.toString());
  }

  // --- 5. AUDIT REPORT ---
  Logger.log(`📊 ======== ALLOCATION SUMMARY ========`);
  Object.entries(tally).sort((a,b) => b[1]-a[1]).forEach(([label, count]) => {
    Logger.log(`   ├─ ${label.padEnd(30)}: ${count.toLocaleString('en-IN')}`);
  });
  Logger.log(`📊 =====================================`);

  cleanUpJobProperties(job.name, Math.floor((dstLastRow - 2) / BATCH));
  props.deleteProperty(stateKey);
  updateJobStatus(job.configRow, "✅ Success");
  Logger.log(`✅ Allocation Engine Complete for ${dstLastRow - 1} rows.`);
  return true;
}


// ─── FUNCTION 2: PAYMENTS ALLOCATION ENGINE ──────────────────────────────────

function runDashCBCPaymentsCalculations(job, startTime, scheduleMode) {
  Logger.log(`=======================================================`);
  Logger.log(`🚀 STARTING P&B CHARGES ENGINE V2 (${job.name})`);
  Logger.log(`=======================================================`);
  updateJobStatus(job.configRow, "⚙️ Loading Lookup Maps...");

  const ss = safeOpenById(job.dstId);

  // --- 1. BASE DATA MAP (Lead ID → { status, prod, team }) ---
  const baseLastRow = ss.getSheetByName("Base_Data")
    ? ss.getSheetByName("Base_Data").getLastRow() : 0;
  const baseMap = baseLastRow > 1
    ? buildFastMap(job.dstId, `Base_Data!A2:K${baseLastRow}`, 0, (r) => ({
        status: String(r[3] || "").trim() || "Not found",
        prod:   String(r[5] || "").trim() || "Not found in Master",
        team:   String(r[10] || "").trim() || "Not Allocated any Team",
        bucket: String(r[7] || "").trim()
      }))
    : new Map();

  // --- 2. CONFLICT MAP (from ImpRng_Allocations on dashboard sheet) ---
  const allocSheet = ss.getSheetByName("ImpRng_Allocations");
  const allocSrcId  = job.dstId; // Allocations are on the same dashboard sheet
  const { conflictMap } = allocSheet
    ? _buildAllocationSets(allocSrcId, "ImpRng_Allocations")
    : { conflictMap: new Map() };

  Logger.log(`✅ Maps built → Base: ${baseMap.size} | Conflicts: ${conflictMap.size}`);

  // --- 3. PREPARE DESTINATION ---
  const dstSheet   = ss.getSheetByName(job.dstTab);
  const dstLastRow = dstSheet.getLastRow();

  if (dstLastRow < 2) {
    Logger.log("⚠️ Destination empty. Skipping.");
    updateJobStatus(job.configRow, "⚠️ Skipped (Destination Empty)");
    return true;
  }

  const BATCH    = getOptimalBatchSize(dstLastRow, job.dstTab).batch;
  const props    = PropertiesService.getScriptProperties();
  const stateKey = `RD_${job.name}`;
  let startRow   = parseInt(props.getProperty(stateKey)) || 2;

  // Audit counters
  const tally = {};
  const inc   = (label) => { tally[label] = (tally[label] || 0) + 1; };

  let tallyStatusFound = 0, tallyStatusFallback = 0;
  let tallyProdFound   = 0, tallyProdNotFound   = 0;
  let tallyConflictOverride = 0;

  updateJobStatus(job.configRow, "⚙️ Computing H, I, J...");

  // --- 4. BATCHED PROCESS ---
  while (startRow <= dstLastRow) {
    if (checkAndSetRelay(startTime, job, scheduleMode, props)) return false;

    const numRows = Math.min(BATCH, dstLastRow - startRow + 1);
    const rawDst  = safeGet(job.dstId, `${job.dstTab}!A${startRow}:G${startRow + numRows - 1}`);
    const outputArray = [];

    for (let i = 0; i < rawDst.length; i++) {
      const row = rawDst[i];
      const id  = cleanId(row[0]);

      if (!id) {
        outputArray.push(["Awaiting Lead ID", "Awaiting Lead ID", "Awaiting Lead ID"]);
        continue;
      }

      // ── Team (Col H) ──────────────────────────────────────────────────────
      let finalTeam;

      if (!baseMap.has(id)) {
        if (id.startsWith("SME")) {
        finalTeam = "SME Team";
        } else if (id.startsWith("LAP")) {
          finalTeam = "LAP Team";
        } else {
          finalTeam = "Self Paid";
        }
      } else {
        const bData = baseMap.get(id);

  // Parse payment date (col G = index 6)
  let pmtDateMs = 0;
  if (row[6] instanceof Date) {
    pmtDateMs = row[6].getTime();
  } else if (row[6]) {
    const raw = String(row[6]).trim();
    if (raw.includes("-") && /[a-zA-Z]{3}/.test(raw)) {
      pmtDateMs = new Date(raw).getTime() || 0;
    } else {
      pmtDateMs = parseTimestampToMs(raw) || 0;
    }
  }

  // Start with base allocation
  finalTeam = bData.team;

  // Apply conflict override if payment date falls in agency window
  const conflict = conflictMap.get(id);
  if (conflict) {
    const overrideLabel = _resolvePaymentAllocation(
      bData.team, bData.bucket, bData.status, pmtDateMs, conflict
    );
    if (overrideLabel !== bData.team) {
      finalTeam = overrideLabel;
      tallyConflictOverride++;
    }
  }
}

      inc(finalTeam);

      // ── Status (Col I) ────────────────────────────────────────────────────
      const bData      = baseMap.get(id);
      let finalStatus  = bData ? bData.status : "Not found";
      if (finalStatus === "Not found") { finalStatus = "Active"; tallyStatusFallback++; }
      else tallyStatusFound++;

      // ── Product (Col J) ───────────────────────────────────────────────────
      let finalProd = bData ? bData.prod : "Not found in Master";
      if (finalProd === "Not found in Master") tallyProdNotFound++;
      else tallyProdFound++;

      if (startRow === 2 && i < 3) {
      Logger.log(`🔍 [AUDIT Row ${startRow + i}] rawId:${row[0]} cleanId:${id} inBaseMap:${baseMap.has(id)} → Team:${finalTeam}`);
      }

      outputArray.push([finalTeam, finalStatus, finalProd]);
    }

    // --- 5. WRITE H, I, J ---
    if (outputArray.length > 0) {
      const blockIdx   = Math.floor((startRow - 2) / BATCH);
      const hashResult = checkHashState(outputArray, job.name, blockIdx, props);
      if (hashResult !== true) {
        safeUpdate({ values: outputArray }, job.dstId,
          `${job.dstTab}!H${startRow}:J${startRow + outputArray.length - 1}`,
          { valueInputOption: "USER_ENTERED" });
        props.setProperty(`H_${job.name}_B${blockIdx}`, hashResult);
        Logger.log(` ├─ Wrote rows ${startRow}–${startRow + numRows - 1}`);
      }
    }

    startRow += numRows;
    props.setProperty(stateKey, startRow.toString());
  }

  // --- 6. AUDIT REPORT ---
  Logger.log(`📊 ======== P&B CHARGES SUMMARY ========`);
  Logger.log(`   [TEAM ALLOCATION]`);
  Object.entries(tally).sort((a,b) => b[1]-a[1]).forEach(([label, count]) => {
    Logger.log(`   ├─ ${label.padEnd(30)}: ${count.toLocaleString('en-IN')}`);
  });
  Logger.log(`   ├─ Conflict overrides         : ${tallyConflictOverride.toLocaleString('en-IN')}`);
  Logger.log(`   [STATUS]`);
  Logger.log(`   ├─ Matched                    : ${tallyStatusFound.toLocaleString('en-IN')}`);
  Logger.log(`   └─ Defaulted Active           : ${tallyStatusFallback.toLocaleString('en-IN')}`);
  Logger.log(`   [PRODUCT]`);
  Logger.log(`   ├─ Matched                    : ${tallyProdFound.toLocaleString('en-IN')}`);
  Logger.log(`   └─ Not found in Master        : ${tallyProdNotFound.toLocaleString('en-IN')}`);
  Logger.log(`📊 =======================================`);

  cleanUpJobProperties(job.name, Math.floor((dstLastRow - 2) / BATCH));
  props.deleteProperty(stateKey);
  updateJobStatus(job.configRow, "✅ Success");
  return true;
}