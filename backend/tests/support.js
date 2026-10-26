'use strict';

const {
  buildSheetModel,
  recordsForWorkbook
} = require('../src/sheetModel');

const SHEET_META = [
  { title: 'Brands', index: 0, sheetId: 101 },
  { title: 'Creators', index: 1, sheetId: 102 },
  { title: 'Outreach', index: 2, sheetId: 103 },
  { title: 'Campaigns', index: 3, sheetId: 104 },
  { title: 'Tasks', index: 4, sheetId: 105 }
];

const VALUES = {
  Brands: [
    ['Brand Name', 'Category', 'Budget', 'Requirements', 'Location', 'Language', 'Brand Email', 'Notes'],
    ['Acme Beauty', 'Beauty', '50000', '10k followers, Hindi content', 'Mumbai', 'Hindi', 'brand@acme.example', 'Prefers reels'],
    ['Trail Gear', 'Travel', '30000', '5k followers', 'Delhi', 'English', 'hello@trail.example', '']
  ],
  Creators: [
    ['Creator Name', 'Platform', 'Category', 'Followers', 'Rate', 'Location', 'Language', 'Availability', 'Creator Email', 'Status'],
    ['Riya Sharma', 'Instagram', 'Beauty', '25000', '20000', 'Mumbai', 'Hindi', 'Available', 'riya@creator.example', 'Active'],
    ['Aman Travels', 'YouTube', 'Travel', '12000', '28000', 'Delhi', 'English', 'Available', 'aman@creator.example', 'Active'],
    ['Neha Fitness', 'Instagram', 'Fitness', '40000', '35000', 'Pune', 'Hindi', 'Booked', 'neha@creator.example', 'Active']
  ],
  Outreach: [
    ['Brand', 'Creator', 'Email', 'Outreach Status', 'Follow Up Date', 'Last Contact', 'Gmail Thread ID'],
    ['Acme Beauty', 'Riya Sharma', 'riya@creator.example', 'Reply received', '2026-10-30', '2026-10-24', 'thread-acme-1'],
    ['Trail Gear', 'Aman Travels', 'aman@creator.example', 'Waiting for reply', '2026-10-20', '2026-10-10', 'thread-trail-1']
  ],
  Campaigns: [
    ['Campaign Name', 'Brand', 'Budget', 'Deadline', 'Status', 'Activity', 'Date'],
    ['Acme Diwali Reels', 'Acme Beauty', '50000', '2026-11-05', 'In progress', 'Draft shared', '2026-10-24']
  ],
  Tasks: [
    ['Task', 'Due Date', 'Status', 'Notes'],
    ['Send Acme follow-up', '2026-10-26', 'Pending', 'Await rate confirmation']
  ]
};

function buildWorkbook() {
  const sheets = SHEET_META.map((meta) => {
    const values = VALUES[meta.title] || [];
    return buildSheetModel(meta, {
      range: `'${meta.title}'!A1:ZZ5000`,
      values
    });
  });
  return {
    spreadsheetId: '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8',
    title: 'SK Collab Agency Test Fixture',
    sheets,
    headers: sheets.map((sheet) => ({
      title: sheet.title,
      role: sheet.role,
      headers: sheet.headers,
      headerRowNumber: sheet.headerRowNumber,
      recordCount: sheet.recordCount
    })),
    records: recordsForWorkbook({ sheets }),
    fetchedAt: Date.now(),
    fetchedAtIso: new Date().toISOString()
  };
}

function fakeStore(options) {
  const opts = options || {};
  const tokens = opts.tokens === undefined
    ? {
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        scope:
          'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/gmail.readonly ' +
          'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send',
        expiry_date: Date.now() + 3600000,
        accountEmail: 'owner@example.com'
      }
    : opts.tokens;
  let meta = Object.assign(
    {
      gmailEmail: 'owner@example.com',
      spreadsheetTitle: 'SK Collab Agency Test Fixture',
      spreadsheetVerifiedAt: new Date().toISOString()
    },
    opts.meta || {}
  );
  const sent = new Map();
  return {
    getTokens() {
      return tokens;
    },
    setTokens(next) {
      return next;
    },
    clearTokens() {},
    getMeta() {
      return meta;
    },
    updateMeta(patch) {
      meta = Object.assign(meta, patch || {});
      return meta;
    },
    getSentRecord(hash) {
      return sent.get(hash) || null;
    },
    setSentRecord(hash, record) {
      sent.set(hash, record);
    }
  };
}

function fakeGoogle(workbook) {
  const calls = {
    sheetsAppend: [],
    sheetsBatchUpdate: [],
    gmailCreateDraft: [],
    gmailSend: [],
    gmailListMessages: []
  };
  return {
    calls,
    grantedScopes() {
      return [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.send'
      ];
    },
    async sheetsMetadata() {
      return {
        spreadsheetId: workbook.spreadsheetId,
        properties: { title: workbook.title },
        sheets: workbook.sheets.map((sheet) => ({ properties: { title: sheet.title, sheetId: sheet.sheetId, index: sheet.index } }))
      };
    },
    async sheetsBatchGet(ranges) {
      return {
        valueRanges: ranges.map((range) => {
          const title = range.replace(/^'/, '').replace(/'.*$/, '');
          const sheet = workbook.sheets.find((item) => item.title === title);
          const values = sheet
            ? [sheet.headers].concat(sheet.dataRows.map((row) => row.values))
            : [];
          return { range, values };
        })
      };
    },
    async sheetsAppend(range, values) {
      calls.sheetsAppend.push({ range, values });
      return { updates: { updatedRange: range, updatedRows: 1 } };
    },
    async sheetsBatchUpdate(data) {
      calls.sheetsBatchUpdate.push(data);
      return { totalUpdatedCells: data.length };
    },
    async gmailListMessages(query, maxResults) {
      calls.gmailListMessages.push({ query, maxResults });
      return { resultSizeEstimate: 0, messages: [] };
    },
    async gmailGetMessage(id) {
      return {
        id,
        threadId: id,
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'Brand <brand@example.com>' },
            { name: 'To', value: 'owner@example.com' },
            { name: 'Subject', value: 'Campaign reply' },
            { name: 'Date', value: 'Fri, 24 Oct 2026 10:00:00 +0530' }
          ]
        },
        snippet: 'Please share creator rate.'
      };
    },
    async gmailGetThread(id) {
      return {
        id,
        messages: [
          {
            id: 'm1',
            threadId: id,
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Brand <brand@example.com>' },
                { name: 'To', value: 'owner@example.com' },
                { name: 'Subject', value: 'Campaign reply' }
              ],
              body: { data: Buffer.from('Please share creator rate.').toString('base64url') }
            }
          }
        ]
      };
    },
    async gmailCreateDraft(raw) {
      calls.gmailCreateDraft.push(raw);
      return { id: 'draft-1', message: { id: 'msg-1', threadId: 'thread-1' } };
    },
    async gmailListDrafts() {
      return { drafts: [] };
    },
    async gmailGetDraft() {
      return { id: 'draft-1', message: { id: 'msg-1', threadId: 'thread-1', payload: { headers: [] } } };
    },
    async gmailSend(raw, threadId) {
      calls.gmailSend.push({ raw, threadId });
      return { id: 'sent-1', threadId: 'thread-1', labelIds: ['SENT'] };
    },
    async gmailProfile() {
      return { emailAddress: 'owner@example.com', messagesTotal: 10, threadsTotal: 5, historyId: '1' };
    }
  };
}

function fakeContext(overrides) {
  const workbook = (overrides && overrides.workbook) || buildWorkbook();
  const config = Object.assign(
    {
      version: 'test',
      spreadsheetId: workbook.spreadsheetId,
      requiredSpreadsheetId: workbook.spreadsheetId,
      enableSheetWrite: true,
      enableGmailWrite: true,
      scopes: [],
      credentials: { type: 'web', compatibleWithBackend: true, message: '' },
      appDeepLink: 'skassistant://oauth/callback'
    },
    (overrides && overrides.config) || {}
  );
  const store = (overrides && overrides.store) || fakeStore();
  const google = (overrides && overrides.google) || fakeGoogle(workbook);
  const ai = (overrides && overrides.ai) || {
    isConfigured() {
      return false;
    },
    async summarizeReplies() {
      return {
        available: false,
        summary: null,
        reason: 'AI not configured in test'
      };
    }
  };
  return {
    config,
    store,
    google,
    ai,
    workbook: {
      async load() {
        return workbook;
      },
      invalidate() {}
    },
    approvals: null
  };
}

module.exports = { buildWorkbook, fakeStore, fakeGoogle, fakeContext, SHEET_META, VALUES };
