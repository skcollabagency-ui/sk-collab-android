'use strict';

const { buildSheetModel, recordsForWorkbook } = require('./sheetModel');

function quoteSheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function createWorkbookService(config, google, store) {
  let cache = null;
  const cacheTtlMs = 30000;

  async function load(options) {
    const opts = options || {};
    if (!opts.refresh && cache && Date.now() - cache.fetchedAt < cacheTtlMs) {
      return cache;
    }

    const metadata = await google.sheetsMetadata();
    if (!metadata || metadata.spreadsheetId !== config.spreadsheetId) {
      throw new Error(
        'Google returned a different spreadsheet than the verified SK Collab Agency spreadsheet ID.'
      );
    }
    const sheetProperties = ((metadata.sheets || []).map((item) => item.properties || {}))
      .filter((item) => item.title)
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

    const ranges = sheetProperties.map(
      (sheet) => `${quoteSheet(sheet.title)}!A1:ZZ5000`
    );
    const valueRanges = [];
    for (let i = 0; i < ranges.length; i += 20) {
      const chunk = ranges.slice(i, i + 20);
      const result = await google.sheetsBatchGet(chunk);
      valueRanges.push(...(result.valueRanges || []));
    }

    const sheets = sheetProperties.map((sheet, index) =>
      buildSheetModel(sheet, valueRanges[index] || { values: [] })
    );
    const workbook = {
      spreadsheetId: metadata.spreadsheetId,
      title: (metadata.properties && metadata.properties.title) || 'Untitled spreadsheet',
      sheets,
      fetchedAt: Date.now(),
      fetchedAtIso: new Date().toISOString(),
      headers: sheets.map((sheet) => ({
        title: sheet.title,
        role: sheet.role,
        headers: sheet.headers,
        headerRowNumber: sheet.headerRowNumber,
        recordCount: sheet.recordCount
      })),
      records: recordsForWorkbook({ sheets })
    };

    cache = workbook;
    if (store) {
      store.updateMeta({
        spreadsheetVerifiedAt: workbook.fetchedAtIso,
        spreadsheetTitle: workbook.title,
        spreadsheetLastError: '',
        lastSyncAt: workbook.fetchedAtIso,
        lastSyncError: ''
      });
    }
    return workbook;
  }

  function invalidate() {
    cache = null;
  }

  return { load, invalidate };
}

module.exports = { createWorkbookService, quoteSheet };
