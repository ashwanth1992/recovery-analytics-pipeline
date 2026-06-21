/**
 * ==============================================================================
 * 🌙 NIGHTLY BACKUP: API-Driven CSV Zip & Email (Memory Safe)
 * ==============================================================================
 */

function sendCombinedSheetsCsvZip() {
  Logger.log('--- Starting Nightly CSV Backup (API Native Export) ---');

  const SHEETS_TO_EXPORT = [
    { spreadsheetId: 'YOUR_SOURCE_SPREADSHEET_ID', sheetName: 'Base_data', friendlyName: 'Daily Base' } // Replace with your source spreadsheet ID
  ];

  const tz = GLOBAL_TZ;
  const nowStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  const zipName = `combined_export_${nowStr.replace(/[: ]/g, '_')}.zip`;
  
  const blobs = [];
  const usedNames = [];
  const token = ScriptApp.getOAuthToken(); // Get permissions to download the file

  for (let item of SHEETS_TO_EXPORT) {
    try {
      const src = SpreadsheetApp.openById(item.spreadsheetId);
      const sheet = src.getSheetByName(item.sheetName);
      if (!sheet) {
        Logger.log(`⚠️ Sheet not found: ${item.sheetName}`);
        continue;
      }

      const safeName = (item.friendlyName || sheet.getName()).replace(/[:\\\/\?\*\[\]]/g, '_').substring(0, 100);
      const gid = sheet.getSheetId(); 
      
      // ⚡ THE FIX: Use Google's native backend export to bypass memory limits
      const exportUrl = `https://docs.google.com/spreadsheets/d/${item.spreadsheetId}/export?format=csv&gid=${gid}`;
      
      Logger.log(`Downloading CSV directly from Google Servers: ${safeName}...`);
      const response = UrlFetchApp.fetch(exportUrl, {
        headers: { 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true
      });

      if (response.getResponseCode() !== 200) {
        throw new Error(`Export failed with code ${response.getResponseCode()}`);
      }

      // Grab the finished CSV file and name it
      const csvBlob = response.getBlob().setName(safeName + '.csv');
      blobs.push(csvBlob);
      usedNames.push(safeName);
      Logger.log(`✅ Successfully grabbed: ${safeName}`);

    } catch (e) {
      Logger.log(`❌ Error processing ${item.sheetName}: ${e.message}`);
    }
  }

  if (blobs.length === 0) {
    Logger.log('⚠️ No sheets were processed. Aborting backup.');
    return;
  }

  Logger.log('Zipping files...');
  const zipBlob = Utilities.zip(blobs, zipName);
  const zipBytes = zipBlob.getBytes().length;
  
  const summary = `Combined export run at: ${nowStr}\nIncluded tabs:\n` + usedNames.map(n => `- ${n}`).join('\n');
  const summaryBlob = Utilities.newBlob(summary, 'text/plain', `summary.txt`);

  const recipient = getAlertEmail(); 

  if (zipBytes <= 20 * 1024 * 1024) { 
    MailApp.sendEmail({
      to: recipient,
      subject: `Nightly CSV Backup — ${nowStr}`,
      body: `Attached: CSV zip containing ${blobs.length} tab(s).`,
      attachments: [zipBlob, summaryBlob]
    });
    Logger.log('📧 Email sent with Zip attachment.');
  } else { 
    const uploaded = DriveApp.createFile(zipBlob);
    uploaded.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    MailApp.sendEmail({
      to: recipient,
      subject: `Nightly CSV Backup (Drive Link) — ${nowStr}`,
      body: `The backup ZIP is too large to attach (~${Math.round(zipBytes/1024/1024)}MB). Download it here: ${uploaded.getUrl()}`,
      attachments: [summaryBlob]
    });
    Logger.log('📧 Email sent with Drive link.');
  }
}