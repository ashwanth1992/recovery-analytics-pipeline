/**
 * ==============================================================================
 * EXECUTIVE VINTAGE DASHBOARD BACKEND
 * ==============================================================================
 */

const VIEW2_ID = 'YOUR_VINTAGE_VIEW2_SHEET_ID';
const VIEW3_ID = 'YOUR_VINTAGE_VIEW3_SHEET_ID';

function doGet(e) {
  // Check the URL for a parameter (e.g., ?app=control)
  const app = (e.parameter && e.parameter.app) ? e.parameter.app : 'vintage';
  
  if (app === 'control') {
    // Serve the Pipeline Control Center
    return HtmlService.createHtmlOutputFromFile('ControlCenter') // Make sure this matches your Control Center HTML filename exactly
      .setTitle('FinanceOrg · Pipeline Control Center')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  
  // Serve the Executive Vintage Dashboard as the default
  return HtmlService.createHtmlOutputFromFile('VintageViews') // Make sure this matches your Vintage Dashboard HTML filename exactly
    .setTitle('Executive Recovery Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Fetches the master JSON for the Heatmap Grid
 * Executes in ~1-2 seconds by reading just the Summary tabs.
 */
function getWebDashboardData() {
  const masterData = {
    "View 2": parseSummaryTab(VIEW2_ID),
    "View 3": parseSummaryTab(VIEW3_ID)
  };
  return masterData;
}

function parseSummaryTab(ssId) {
  // Read the entire summary sheet in one fast REST call
  const rawData = safeGet(ssId, 'Summary!A1:R300');
  
  const out = {
    "Due Date": { "Total": [], "Bounce": [], "Penal": [] },
    "Created Date": { "Total": [], "Bounce": [], "Penal": [] }
  };

  const validBuckets = [
    "Closed", "(1) 0", "(2) 0-30", "(3) 31-60", "(4) 61-90", 
    "Workable Total", 
    "(5) 91-120", "(6) 121-150", "(7) 151-180", "(8+) 180+", 
    "Grand Total"
  ];

  function extractTable(titleSubstr, colOffset, targetArray) {
    let startRow = -1;
    
    // Find table header
    for (let r = 0; r < rawData.length; r++) {
      let cellVal = String((rawData[r] || [])[colOffset] || "");
      if (cellVal.includes(titleSubstr) && cellVal.includes("Vintage")) {
        startRow = r + 2; 
        break;
      }
    }
    if (startRow === -1) return;

    // Parse blocks of 4 rows (Accrued, Paid, Remaining, Recovery %)
    for (let r = startRow; r < rawData.length - 3; r++) {
      let bkt = String((rawData[r] || [])[colOffset] || "").trim();
      
      if (validBuckets.includes(bkt)) {
        const getVals = (rowIdx) => {
          let arr = [];
          for (let i = 0; i < 6; i++) {
            let v = rawData[rowIdx][colOffset + 2 + i];
            
            // 🔥 THE FIX: Strip out the Rupee symbol, commas, and any random spaces
            let cleanV = String(v).replace(/[₹$,\s]/g, '').trim();
            
            if (cleanV.includes('%')) {
              arr.push(parseFloat(cleanV) / 100);
            } else {
              arr.push(parseFloat(cleanV) || 0);
            }
          }
          return arr;
        };

        targetArray.push({
          name: bkt,
          accrued: getVals(r),
          paid: getVals(r + 1),
          remaining: getVals(r + 2),
          recoveryPct: getVals(r + 3)
        });
        
        r += 3; // Skip to the end of this bucket block
      }
      
      if (bkt === "Grand Total") break;
    }
  }

  // Due Date (Left Side)
  extractTable("TOTAL", 1, out["Due Date"]["Total"]);
  extractTable("BOUNCE", 1, out["Due Date"]["Bounce"]);
  extractTable("PENAL", 1, out["Due Date"]["Penal"]);

  // Created Date (Right Side)
  extractTable("TOTAL", 10, out["Created Date"]["Total"]);
  extractTable("BOUNCE", 10, out["Created Date"]["Bounce"]);
  extractTable("PENAL", 10, out["Created Date"]["Penal"]);

  return out;
}

/**
 * Tier 2 Drilldown: In-Memory Join & Filter
 * Reads the raw 260k row sheets via REST, filters, joins paid/accrued, and sorts.
 */

/**
 * Tier 2 Drilldown: In-Memory Join & Filter
 * Reads the raw 260k row sheets via REST chunks, filters, joins paid/accrued, and sorts.
 */
function getVintageDrilldown(viewName, dateType, chargeCategory, dpdBucket, vintageIdx) {
  try {
    const ssId = viewName === "View 2" ? VIEW2_ID : VIEW3_ID;
    const cleanDateType = dateType.replace(" Date", ""); 
    const accTabName = `Accured Vintage_${cleanDateType} Wise`;
    const paidTabName = `Paid Vintage_${cleanDateType} Wise`;
    
    // 1. Get the actual last row to avoid pulling millions of empty cells
    const sheet = SpreadsheetApp.openById(ssId).getSheetByName(accTabName);
    if (!sheet) throw new Error(`Could not find tab: ${accTabName}`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    // Chunk size fallback (uses your getOptimalBatchSize if available globally)
    const chunkSize = typeof getOptimalBatchSize === 'function' ? getOptimalBatchSize(lastRow, accTabName).limit : 40000;

    // 2. Fetch Accrued Data (Cols A-J) in safe chunks
    const accData = [];
    for (let r = 1; r <= lastRow; r += chunkSize) {
      let end = Math.min(r + chunkSize - 1, lastRow);
      let chunk = safeGet(ssId, `${accTabName}!A${r}:J${end}`);
      if (chunk && chunk.length > 0) accData.push(...chunk);
    }

    // 3. Map Paid Data
    const paidMap = new Map();
    if (viewName === "View 3") {
      // View 3 Paid is on the same sheet (Cols L-Q)
      const v3PaidData = [];
      for (let r = 1; r <= lastRow; r += chunkSize) {
        let end = Math.min(r + chunkSize - 1, lastRow);
        let chunk = safeGet(ssId, `${accTabName}!L${r}:Q${end}`);
        if (chunk && chunk.length > 0) v3PaidData.push(...chunk);
      }

      for (let i = 1; i < accData.length; i++) {
        if (v3PaidData[i]) {
          const id = cleanId(accData[i][0]) + "_" + String(accData[i][1]).trim();
          let p = 0;
          if (vintageIdx === 5) { // Overall Total
            p = (parseFloat(v3PaidData[i][0])||0) + (parseFloat(v3PaidData[i][1])||0) + (parseFloat(v3PaidData[i][2])||0) + (parseFloat(v3PaidData[i][3])||0) + (parseFloat(v3PaidData[i][4])||0);
          } else {
            p = parseFloat(v3PaidData[i][vintageIdx]) || 0;
          }
          paidMap.set(id, p);
        }
      }
    } else {
      // View 2 Paid is on a separate sheet
      const paidSheet = SpreadsheetApp.openById(ssId).getSheetByName(paidTabName);
      if (paidSheet) {
        const pLastRow = paidSheet.getLastRow();
        const pChunkSize = typeof getOptimalBatchSize === 'function' ? getOptimalBatchSize(pLastRow, paidTabName).limit : 40000;
        const paidData = [];

        for (let r = 1; r <= pLastRow; r += pChunkSize) {
          let end = Math.min(r + pChunkSize - 1, pLastRow);
          let chunk = safeGet(ssId, `${paidTabName}!A${r}:H${end}`);
          if (chunk && chunk.length > 0) paidData.push(...chunk);
        }

        for (let i = 1; i < paidData.length; i++) {
          if (!paidData[i]) continue;
          const id = cleanId(paidData[i][0]) + "_" + String(paidData[i][1]).trim();
          let p = 0;
          if (vintageIdx === 5) {
            p = (parseFloat(paidData[i][3])||0) + (parseFloat(paidData[i][4])||0) + (parseFloat(paidData[i][5])||0) + (parseFloat(paidData[i][6])||0) + (parseFloat(paidData[i][7])||0);
          } else {
            p = parseFloat(paidData[i][3 + vintageIdx]) || 0;
          }
          paidMap.set(id, p);
        }
      }
    }

    // 4. Filter & Join Logic
    const results = [];
    
    for (let i = 1; i < accData.length; i++) {
      const row = accData[i] || [];
      const leadId = cleanId(row[0]);
      if (!leadId) continue; // Skip blank rows
      
      const category = String(row[1] || "").trim();
      const loanType = String(row[8] || "").trim();
      const rowBucket = String(row[9] || "").trim();

      // Bucket & Category Filters
      if (dpdBucket === "Workable Total") {
        if (!["Closed", "(1) 0", "(2) 0-30", "(3) 31-60", "(4) 61-90"].includes(rowBucket)) continue;
      } else if (dpdBucket === "Non-Workable Total") {
        if (!["(5) 91-120", "(6) 121-150", "(7) 151-180", "(8+) 180+"].includes(rowBucket)) continue;
      } else if (dpdBucket !== "Grand Total") {
        // If it's a specific bucket (Not a total row), require an exact match
        if (rowBucket !== dpdBucket) continue;
      }
      // Note: If dpdBucket === "Grand Total", it skips bucket filtering entirely and includes everything!
      
      if (chargeCategory !== "Total" && category !== chargeCategory) continue;

      // Extract Accrued Amt
      let accAmt = 0;
      if (vintageIdx === 5) {
        accAmt = (parseFloat(row[3])||0) + (parseFloat(row[4])||0) + (parseFloat(row[5])||0) + (parseFloat(row[6])||0) + (parseFloat(row[7])||0);
      } else {
        accAmt = parseFloat(row[3 + vintageIdx]) || 0;
      }

      // Skip 0 accrued
      if (accAmt <= 0) continue;

      const key = leadId + "_" + category;
      const paidAmt = paidMap.get(key) || 0;
      const remainingAmt = accAmt - paidAmt;

      results.push({
        leadId: leadId,
        loanType: loanType,
        accrued: accAmt,
        paid: paidAmt,
        remaining: remainingAmt
      });
    }

    // Sort by largest remaining debt first and cap at 2500 for UI speed
    results.sort((a, b) => b.remaining - a.remaining);
    return results.slice(0, 2500); 

  } catch (e) {
    // Pass the actual error string back to the UI failure handler
    throw new Error(e.message); 
  }
}