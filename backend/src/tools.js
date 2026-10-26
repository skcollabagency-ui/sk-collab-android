'use strict';

const crypto = require('crypto');
const {
  recordsByRole,
  recordsForWorkbook,
  searchRecords,
  buildWriteRow,
  recordEmail,
  recordName,
  normalize,
  parseNumber,
  parseDate,
  resolveFieldName
} = require('./sheetModel');
const { quoteSheet } = require('./workbook');
const {
  buildMimeMessage,
  normalizeAddress,
  normalizeAddressList,
  threadSummary,
  messageSummary,
  threadToText
} = require('./gmailUtil');
const { OAuthRequiredError } = require('./google');

const SHEET_READ_FULL = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET_READ_ONLY = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.status = 400;
    this.details = details || null;
  }
}

const toolDefinitions = [
  {
    name: 'get_spreadsheet_status',
    description:
      'Report whether the existing SK Collab Agency spreadsheet is configured and whether the Google account has read/write permission. Does not modify the spreadsheet.',
    risk: 'read',
    requiresApproval: false,
    access: 'status',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'If true, make a live Google Sheets metadata request.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_worksheets',
    description:
      'Read the actual worksheet names, detected roles, header row, column headers, and record counts from the existing spreadsheet.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_sheet_headers',
    description:
      'Get real column headers for one worksheet or all worksheets. Use this before deciding which fields can be read or written.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        worksheet: { type: 'string', description: 'Worksheet title. Omit to return all worksheets.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_brands',
    description:
      'Search real brand/client records in the spreadsheet. Returns matched rows with actual values and sheet row references.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Brand name, category, email, or any text to match. Empty returns recent records.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_creators',
    description:
      'Search real creator/influencer records. Returns actual rate, availability, category, platform, and contact data when present.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Creator name, category, platform, email, or any text to match.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_campaigns',
    description: 'Read real campaign records, including budget, requirements, deadlines, and status when those columns exist.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional campaign name or text filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'find_creator_brand_matches',
    description:
      'Compare real brand requirements with real creator records using mapped fields (category, platform, location, language, rate/budget, followers, availability). Never invents creator data.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name to match.' },
        worksheet: { type: 'string', description: 'Optional brand worksheet title if names are duplicated.' },
        limit: { type: 'integer', minimum: 1, maximum: 25 }
      },
      required: ['brand'],
      additionalProperties: false
    }
  },
  {
    name: 'get_outreach_status',
    description: 'Read outreach records and their actual status/follow-up fields. Optionally filter by brand, creator, email, or status.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text filter.' },
        status: { type: 'string', description: 'Optional status filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_pending_followups',
    description:
      'Read spreadsheet records that are pending or due for follow-up based on real follow-up dates/status columns. Does not change anything.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        daysAhead: { type: 'integer', minimum: 0, maximum: 365, description: 'Include follow-ups due within this many days. Default 7.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'add_brand',
    description:
      'Append a real brand record to the mapped Brands worksheet. Requires explicit approval. Only writes columns that already exist; refuses if a supplied field has no safe column.',
    risk: 'write',
    requiresApproval: true,
    access: 'sheets-write',
    parameters: {
      type: 'object',
      properties: {
        worksheet: { type: 'string', description: 'Optional worksheet title when multiple candidates exist.' },
        fields: {
          type: 'object',
          description: 'Field values keyed by actual business names, e.g. {"brandName":"...","email":"...","category":"..."}'
        }
      },
      required: ['fields'],
      additionalProperties: true
    }
  },
  {
    name: 'add_creator',
    description:
      'Append a real creator record to the mapped Creators worksheet. Requires explicit approval. Refuses to write unknown fields or add columns silently.',
    risk: 'write',
    requiresApproval: true,
    access: 'sheets-write',
    parameters: {
      type: 'object',
      properties: {
        worksheet: { type: 'string', description: 'Optional worksheet title when multiple candidates exist.' },
        fields: {
          type: 'object',
          description: 'Field values keyed by actual business names, e.g. {"creatorName":"...","platform":"Instagram","followers":"10000","rate":"..."}'
        }
      },
      required: ['fields'],
      additionalProperties: true
    }
  },
  {
    name: 'update_outreach_status',
    description:
      'Update the outreach status cell for exactly one matched row. Requires explicit approval. Refuses ambiguous matches or missing status columns.',
    risk: 'write',
    requiresApproval: true,
    access: 'sheets-write',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Brand/creator/email/campaign key to identify the row.' },
        status: { type: 'string', description: 'New outreach status, based on the real conversation.' },
        worksheet: { type: 'string', description: 'Optional worksheet title.' },
        rowNumber: { type: 'integer', description: 'Optional exact spreadsheet row number.' }
      },
      required: ['status'],
      additionalProperties: false
    }
  },
  {
    name: 'update_deal_status',
    description:
      'Update the deal status cell for exactly one matched row. Requires explicit approval. Never accepts a deal or commits terms automatically.',
    risk: 'write',
    requiresApproval: true,
    access: 'sheets-write',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Brand/creator/campaign key to identify the row.' },
        status: { type: 'string', description: 'New deal status, based only on confirmed conversation facts.' },
        worksheet: { type: 'string', description: 'Optional worksheet title.' },
        rowNumber: { type: 'integer', description: 'Optional exact spreadsheet row number.' }
      },
      required: ['status'],
      additionalProperties: false
    }
  },
  {
    name: 'log_campaign_activity',
    description:
      'Update the activity/log column and optional date column on one campaign row. Requires explicit approval and refuses if those columns do not exist.',
    risk: 'write',
    requiresApproval: true,
    access: 'sheets-write',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Campaign/brand/creator key to identify the row.' },
        activity: { type: 'string', description: 'Factual activity summary, e.g. "Draft saved to Gmail".' },
        date: { type: 'string', description: 'Optional activity date.' },
        worksheet: { type: 'string', description: 'Optional worksheet title.' },
        rowNumber: { type: 'integer', description: 'Optional exact spreadsheet row number.' }
      },
      required: ['activity'],
      additionalProperties: false
    }
  },
  {
    name: 'generate_agency_report',
    description:
      'Generate a factual agency report from the spreadsheet: worksheet counts, mapped roles, pending follow-ups, and status summaries. Does not send messages.',
    risk: 'read',
    requiresApproval: false,
    access: 'sheets-read',
    parameters: {
      type: 'object',
      properties: {
        includePendingFollowups: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_gmail_status',
    description: 'Report Gmail connection, authorized account, granted scopes, and whether read/draft/send capabilities are enabled.',
    risk: 'read',
    requiresApproval: false,
    access: 'status',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'search_emails',
    description:
      'Search authorized Gmail messages using Gmail query syntax. Returns real metadata and snippets; use get_email_thread for full bodies.',
    risk: 'read',
    requiresApproval: false,
    access: 'gmail-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:brand@example.com newer_than:14d".' },
        maxResults: { type: 'integer', minimum: 1, maximum: 25 }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'get_email_thread',
    description: 'Read one authorized Gmail thread, including real message bodies, for business context or reply drafting.',
    risk: 'read',
    requiresApproval: false,
    access: 'gmail-read',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string' }
      },
      required: ['threadId'],
      additionalProperties: false
    }
  },
  {
    name: 'summarize_business_replies',
    description:
      'Fetch real brand/creator reply threads and summarize them. Uses the backend AI if configured; otherwise returns real message text for the app AI to summarize. Never invents replies.',
    risk: 'read',
    requiresApproval: false,
    access: 'gmail-read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional Gmail query. Default: recent inbox replies.' },
        maxThreads: { type: 'integer', minimum: 1, maximum: 10 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'create_email_draft',
    description:
      'Create a Gmail draft without sending it. Use verified recipient/subject/body. Refuses likely duplicate outreach unless allowDuplicate is explicitly true.',
    risk: 'draft',
    requiresApproval: false,
    access: 'gmail-draft',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        threadId: { type: 'string' },
        allowDuplicate: { type: 'boolean' }
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'list_drafts',
    description: 'List saved Gmail drafts with real recipients and subjects.',
    risk: 'read',
    requiresApproval: false,
    access: 'gmail-draft',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 25 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'send_approved_email',
    description:
      'Send exactly one approved email after explicit user approval. Shows full recipient/subject/body in the approval request. Checks duplicates and idempotency.',
    risk: 'send',
    requiresApproval: true,
    access: 'gmail-send',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        threadId: { type: 'string' },
        allowDuplicate: { type: 'boolean' }
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'identify_pending_replies',
    description:
      'Find unread inbox replies that likely need a business response, correlate senders with spreadsheet brand/creator records where possible, and update nothing.',
    risk: 'read',
    requiresApproval: false,
    access: 'gmail-read',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 25 },
        days: { type: 'integer', minimum: 1, maximum: 90 }
      },
      additionalProperties: false
    }
  }
];

const DEFINITIONS_BY_NAME = {};
for (const definition of toolDefinitions) DEFINITIONS_BY_NAME[definition.name] = definition;

function hasAnyScope(scopes, accepted) {
  return accepted.some((scope) => scopes.includes(scope));
}

function availabilityFor(definition, context) {
  if (definition.access === 'status') {
    return { available: true, reason: '' };
  }
  const config = context.config;
  const tokens = context.store.getTokens();
  if (!tokens) {
    return { available: false, reason: 'Google authorization required. Connect the Google account first.' };
  }
  if (!config.credentials || config.credentials.type === 'none' || !config.credentials.compatibleWithBackend) {
    return {
      available: false,
      reason:
        config.credentials && config.credentials.message
          ? config.credentials.message
          : 'Google OAuth client credentials are not configured on the backend.'
    };
  }
  const scopes = context.google.grantedScopes();
  if (definition.access === 'sheets-read') {
    if (!hasAnyScope(scopes, [SHEET_READ_FULL, SHEET_READ_ONLY])) {
      return { available: false, reason: 'Google Sheets read permission has not been granted.' };
    }
    return { available: true, reason: '' };
  }
  if (definition.access === 'sheets-write') {
    if (!config.enableSheetWrite) {
      return { available: false, reason: 'Google Sheets writes are disabled by backend configuration.' };
    }
    if (!scopes.includes(SHEET_READ_FULL)) {
      return { available: false, reason: 'Google Sheets write permission has not been granted.' };
    }
    return { available: true, reason: '' };
  }
  if (definition.access === 'gmail-read') {
    if (!hasAnyScope(scopes, [GMAIL_READ, 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'])) {
      return { available: false, reason: 'Gmail read permission has not been granted.' };
    }
    return { available: true, reason: '' };
  }
  if (definition.access === 'gmail-draft') {
    if (!config.enableGmailWrite) {
      return { available: false, reason: 'Gmail draft/send writes are disabled by backend configuration.' };
    }
    if (!scopes.includes(GMAIL_COMPOSE)) {
      return { available: false, reason: 'Gmail draft permission has not been granted.' };
    }
    return { available: true, reason: '' };
  }
  if (definition.access === 'gmail-send') {
    if (!config.enableGmailWrite) {
      return { available: false, reason: 'Gmail draft/send writes are disabled by backend configuration.' };
    }
    if (!hasAnyScope(scopes, [GMAIL_SEND, GMAIL_COMPOSE])) {
      return { available: false, reason: 'Gmail send permission has not been granted.' };
    }
    return { available: true, reason: '' };
  }
  return { available: false, reason: 'Unknown tool access requirement.' };
}

function listTools(context) {
  return toolDefinitions.map((definition) => {
    const availability = availabilityFor(definition, context);
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      risk: definition.risk,
      requiresApproval: definition.requiresApproval,
      access: definition.access,
      available: availability.available,
      availabilityReason: availability.reason
    };
  });
}

function ensureAvailable(definition, context) {
  const availability = availabilityFor(definition, context);
  if (!availability.available) {
    const error = new ToolError('TOOL_UNAVAILABLE', availability.reason);
    error.status = definition.access === 'status' ? 500 : 403;
    throw error;
  }
}

function compactRecord(record) {
  return {
    sheetTitle: record.sheetTitle,
    sheetRole: record.sheetRole,
    rowNumber: record.rowNumber,
    name: recordName(record.mapped),
    mapped: record.mapped,
    values: record.values
  };
}

function selectSheet(workbook, role, worksheet, nameField) {
  if (worksheet) {
    const normalized = normalize(worksheet);
    const matches = workbook.sheets.filter((sheet) => normalize(sheet.title) === normalized);
    if (matches.length !== 1) {
      throw new ToolError(
        'WORKSHEET_NOT_FOUND',
        `Worksheet "${worksheet}" was not found.`,
        { worksheets: workbook.sheets.map((sheet) => sheet.title) }
      );
    }
    return matches[0];
  }
  let candidates = workbook.sheets.filter((sheet) => sheet.role === role);
  if (!candidates.length && nameField) {
    candidates = workbook.sheets.filter((sheet) => sheet.fields[nameField] !== undefined);
  }
  if (!candidates.length) {
    throw new ToolError(
      'WORKSHEET_NOT_FOUND',
      `No worksheet safely mapped to "${role}" was found. No changes were made.`,
      { worksheets: workbook.sheets.map((sheet) => sheet.title) }
    );
  }
  if (candidates.length > 1) {
    throw new ToolError(
      'AMBIGUOUS_WORKSHEET',
      `More than one worksheet matches "${role}". Specify the exact worksheet title.`,
      { candidates: candidates.map((sheet) => sheet.title) }
    );
  }
  return candidates[0];
}

function columnLetter(index) {
  let number = Number(index) + 1;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function extractFields(args) {
  const copy = Object.assign({}, args || {});
  delete copy.worksheet;
  delete copy.fields;
  delete copy.rowNumber;
  delete copy.sheetTitle;
  delete copy.allowDuplicate;
  delete copy.query;
  delete copy.status;
  delete copy.date;
  delete copy.activity;
  const input = Object.assign({}, args && args.fields ? args.fields : {}, copy);
  return input;
}

function addRecordPreparation(context, role, nameField, args) {
  return context.workbook.load().then((workbook) => {
    const sheet = selectSheet(workbook, role, args.worksheet, nameField);
    const input = extractFields(args);
    const built = buildWriteRow(sheet, input, { nameField });
    if (!Object.keys(built.inputFields).length) {
      throw new ToolError('MISSING_FIELDS', 'No recognized record fields were supplied.');
    }
    if (built.missingColumns.length) {
      throw new ToolError(
        'MISSING_COLUMN',
        `The worksheet "${sheet.title}" has no safe column for: ${built.missingColumns.join(', ')}. ` +
          'No columns were added and no data was written. Propose the missing header(s) to the user first.',
        {
          worksheet: sheet.title,
          missingFields: built.missingColumns,
          actualHeaders: sheet.headers,
          proposedHeaders: built.missingColumns
        }
      );
    }
    return { workbook, sheet, built, input };
  });
}

async function addRecord(context, role, nameField, args) {
  const prepared = await addRecordPreparation(context, role, nameField, args);
  const { sheet, built } = prepared;
  const lastColumn = columnLetter(Math.max(0, sheet.headers.length - 1));
  const range = `${quoteSheet(sheet.title)}!A${sheet.headerRowNumber}:${lastColumn}${sheet.headerRowNumber}`;
  const result = await context.google.sheetsAppend(range, [built.values]);
  return {
    spreadsheetTitle: prepared.workbook.title,
    worksheet: sheet.title,
    appendedRange: result && result.updates ? result.updates.updatedRange : range,
    updatedRows: result && result.updates ? result.updates.updatedRows : 1,
    writtenFields: built.mappedFields,
    recordPreview: built.values
      .map((value, index) => (value === '' ? null : `${sheet.headers[index]}: ${value}`))
      .filter(Boolean)
  };
}

async function previewAddRecord(context, role, nameField, args) {
  const prepared = await addRecordPreparation(context, role, nameField, args);
  const { sheet, built } = prepared;
  return {
    title: `Append ${role === 'brands' ? 'brand' : 'creator'} record`,
    worksheet: sheet.title,
    summary: 'A new row will be appended without changing headers, formulas, or existing records.',
    fields: built.values
      .map((value, index) => ({ column: sheet.headers[index], value }))
      .filter((item) => item.value !== ''),
    ignoredFields: Object.keys(built.unknownFields || {}),
    warnings: built.unknownFields && Object.keys(built.unknownFields).length
      ? ['Some supplied fields are not valid business fields and were not written: ' + Object.keys(built.unknownFields).join(', ')]
      : []
  };
}

function findRecord(workbook, roles, args) {
  let records = recordsByRole(workbook, roles);
  if (!records.length) {
    records = recordsForWorkbook(workbook);
  }
  if (args.sheetTitle) {
    records = records.filter(
      (record) => normalize(record.sheetTitle) === normalize(args.sheetTitle)
    );
  }
  if (args.rowNumber) {
    records = records.filter((record) => Number(record.rowNumber) === Number(args.rowNumber));
  }
  const query =
    args.query ||
    args.name ||
    args.brand ||
    args.creator ||
    args.campaign ||
    args.email ||
    '';
  const normalizedQuery = normalize(query);
  if (!normalizedQuery && !args.rowNumber) {
    throw new ToolError(
      'ROW_KEY_REQUIRED',
      'A brand/creator/campaign/email key or an exact worksheet row number is required to identify one row.'
    );
  }
  if (normalizedQuery) {
    const exact = records.filter((record) => {
      const mapped = record.mapped;
      const candidates = [
        recordName(mapped),
        mapped.brandName,
        mapped.creatorName,
        mapped.campaignName,
        mapped.email,
        mapped.brandEmail,
        mapped.creatorEmail
      ]
        .filter(Boolean)
        .map(normalize);
      return candidates.includes(normalizedQuery);
    });
    if (exact.length === 1) return exact[0];
    records = records.filter((record) => {
      const haystack = normalize(
        Object.keys(record.values)
          .map((key) => record.values[key])
          .join(' ')
      );
      return haystack.includes(normalizedQuery);
    });
  }
  if (!records.length) {
    throw new ToolError('RECORD_NOT_FOUND', 'No matching spreadsheet row was found.');
  }
  if (records.length > 1) {
    throw new ToolError(
      'AMBIGUOUS_RECORD',
      'More than one spreadsheet row matches. Provide an exact row number or worksheet title.',
      {
        candidates: records.slice(0, 10).map((record) => ({
          worksheet: record.sheetTitle,
          rowNumber: record.rowNumber,
          name: recordName(record.mapped),
          email: recordEmail(record.mapped)
        }))
      }
    );
  }
  return records[0];
}

function sheetForRecord(workbook, record) {
  return workbook.sheets.find(
    (sheet) =>
      normalize(sheet.title) === normalize(record.sheetTitle) &&
      sheet.rowNumber === undefined
  );
}

function statusColumn(sheet, preferred) {
  if (sheet.fields[preferred] !== undefined) return sheet.fields[preferred];
  if (sheet.role === 'outreach' && sheet.fields.status !== undefined) return sheet.fields.status;
  if (sheet.role === 'deals' && sheet.fields.status !== undefined) return sheet.fields.status;
  return undefined;
}

function updatePreparation(context, preferredStatusField, args) {
  return context.workbook.load().then((workbook) => {
    const lookup = Object.assign({}, args, {
      sheetTitle: args.worksheet || args.sheetTitle
    });
    const record = findRecord(
      workbook,
      preferredStatusField === 'dealStatus'
        ? ['deals', 'campaigns', 'outreach']
        : ['outreach', 'deals', 'campaigns'],
      lookup
    );
    const sheet = workbook.sheets.find(
      (item) => normalize(item.title) === normalize(record.sheetTitle)
    );
    if (!sheet) throw new ToolError('WORKSHEET_NOT_FOUND', 'Matched worksheet disappeared from the workbook model.');
    const index = statusColumn(sheet, preferredStatusField);
    if (index === undefined) {
      throw new ToolError(
        'MISSING_COLUMN',
        `Worksheet "${sheet.title}" has no safe status column for this update. No data was written.`,
        {
          worksheet: sheet.title,
          actualHeaders: sheet.headers,
          proposedHeader: preferredStatusField === 'dealStatus' ? 'Deal Status' : 'Outreach Status'
        }
      );
    }
    const oldValue = String(record.values[sheet.headers[index]] || '');
    return {
      workbook,
      record,
      sheet,
      columnIndex: index,
      columnHeader: sheet.headers[index],
      oldValue,
      newValue: String(args.status || '').trim()
    };
  });
}

function updatePreview(prepared, label) {
  return {
    title: label,
    worksheet: prepared.sheet.title,
    rowNumber: prepared.record.rowNumber,
    recordName: recordName(prepared.record.mapped),
    column: prepared.columnHeader,
    currentValue: prepared.oldValue,
    newValue: prepared.newValue,
    summary: 'Only this status cell will be updated. Headers, formulas, and other cells are preserved.'
  };
}

async function applyUpdate(context, prepared) {
  const cellRange = `${quoteSheet(prepared.sheet.title)}!${columnLetter(prepared.columnIndex)}${prepared.record.rowNumber}`;
  await context.google.sheetsBatchUpdate([
    { range: cellRange, values: [[prepared.newValue]] }
  ]);
  context.workbook.invalidate();
  return {
    worksheet: prepared.sheet.title,
    rowNumber: prepared.record.rowNumber,
    column: prepared.columnHeader,
    oldValue: prepared.oldValue,
    newValue: prepared.newValue,
    range: cellRange
  };
}

async function logActivityPreparation(context, args) {
  const workbook = await context.workbook.load();
  const lookup = Object.assign({}, args, {
    sheetTitle: args.worksheet || args.sheetTitle
  });
  const record = findRecord(workbook, ['campaigns', 'outreach', 'deals'], lookup);
  const sheet = workbook.sheets.find(
    (item) => normalize(item.title) === normalize(record.sheetTitle)
  );
  if (!sheet) throw new ToolError('WORKSHEET_NOT_FOUND', 'Matched worksheet was not found.');
  const activityIndex = sheet.fields.activity;
  if (activityIndex === undefined) {
    throw new ToolError(
      'MISSING_COLUMN',
      `Worksheet "${sheet.title}" has no activity/log column. No data was written.`,
      { worksheet: sheet.title, actualHeaders: sheet.headers, proposedHeader: 'Activity' }
    );
  }
  const dateIndex = sheet.fields.date !== undefined ? sheet.fields.date : sheet.fields.deadline;
  return { workbook, record, sheet, activityIndex, dateIndex };
}

async function applyLogActivity(context, prepared, args) {
  const updates = [
    {
      range: `${quoteSheet(prepared.sheet.title)}!${columnLetter(prepared.activityIndex)}${prepared.record.rowNumber}`,
      values: [[String(args.activity)]]
    }
  ];
  if (prepared.dateIndex !== undefined && args.date) {
    updates.push({
      range: `${quoteSheet(prepared.sheet.title)}!${columnLetter(prepared.dateIndex)}${prepared.record.rowNumber}`,
      values: [[String(args.date)]]
    });
  }
  await context.google.sheetsBatchUpdate(updates);
  context.workbook.invalidate();
  return {
    worksheet: prepared.sheet.title,
    rowNumber: prepared.record.rowNumber,
    activity: String(args.activity),
    date: args.date || '',
    updatedColumns: updates.map((item) => item.range)
  };
}

function pendingFollowups(workbook, daysAhead, limit) {
  const now = new Date();
  const horizon = new Date(now.getTime() + Number(daysAhead || 7) * 24 * 60 * 60 * 1000);
  const records = recordsForWorkbook(workbook);
  const pending = [];
  for (const record of records) {
    const mapped = record.mapped;
    const followDate = parseDate(mapped.followUpDate);
    const lastContact = parseDate(mapped.lastContact);
    const dueDate = parseDate(mapped.deadline);
    const statusText = normalize(
      [mapped.status, mapped.outreachStatus, mapped.dealStatus, mapped.task].filter(Boolean).join(' ')
    );
    const statusPending = /(pending|follow up|followup|waiting|awaiting|due|open|not sent|no reply)/.test(statusText);
    let reason = '';
    if (followDate && followDate <= horizon) reason = 'follow-up date due';
    else if (dueDate && dueDate <= horizon) reason = 'deadline due';
    else if (statusPending) reason = 'status marked pending';
    else if (lastContact && now.getTime() - lastContact.getTime() > 7 * 24 * 60 * 60 * 1000) {
      reason = 'no recent contact recorded';
    }
    if (!reason) continue;
    const relevantDate = followDate || dueDate || lastContact;
    const daysUntil = relevantDate
      ? Math.ceil((relevantDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    pending.push({
      worksheet: record.sheetTitle,
      rowNumber: record.rowNumber,
      name: recordName(mapped),
      email: recordEmail(mapped),
      status: mapped.outreachStatus || mapped.dealStatus || mapped.status || '',
      followUpDate: mapped.followUpDate || mapped.deadline || '',
      lastContact: mapped.lastContact || '',
      task: mapped.task || '',
      reason,
      daysUntil
    });
  }
  pending.sort((a, b) => {
    const av = a.daysUntil === null ? 9999 : a.daysUntil;
    const bv = b.daysUntil === null ? 9999 : b.daysUntil;
    return av - bv;
  });
  return pending.slice(0, Math.max(1, Math.min(Number(limit || 50), 100)));
}

function statusCounts(records) {
  const counts = {};
  for (const record of records) {
    const status =
      record.mapped.dealStatus ||
      record.mapped.outreachStatus ||
      record.mapped.status ||
      record.mapped.paymentStatus ||
      'unmapped';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function scoreCreator(brand, creator) {
  let score = 0;
  const reasons = [];
  const gaps = [];
  const brandCategory = normalize(brand.category);
  const creatorCategory = normalize(creator.category);
  if (brandCategory && creatorCategory) {
    if (brandCategory === creatorCategory) {
      score += 40;
      reasons.push('category matches');
    } else if (
      brandCategory.split(' ').some((token) => token.length > 3 && creatorCategory.includes(token))
    ) {
      score += 25;
      reasons.push('category partially matches');
    } else {
      gaps.push('category differs');
    }
  }
  const brandPlatform = normalize(brand.platform);
  const creatorPlatform = normalize(creator.platform || creator.handle);
  if (brandPlatform && creatorPlatform) {
    if (creatorPlatform.includes(brandPlatform) || brandPlatform.includes(creatorPlatform)) {
      score += 20;
      reasons.push('platform matches');
    } else {
      gaps.push('platform differs');
    }
  }
  const brandLocation = normalize(brand.location);
  const creatorLocation = normalize(creator.location);
  if (brandLocation && creatorLocation) {
    if (brandLocation === creatorLocation || creatorLocation.includes(brandLocation)) {
      score += 15;
      reasons.push('location matches');
    } else {
      gaps.push('location differs');
    }
  }
  const brandLanguage = normalize(brand.language);
  const creatorLanguage = normalize(creator.language);
  if (brandLanguage && creatorLanguage) {
    if (
      brandLanguage === creatorLanguage ||
      brandLanguage.split(' ').some((token) => creatorLanguage.includes(token))
    ) {
      score += 10;
      reasons.push('language matches');
    }
  }
  const budget = parseNumber(brand.budget || brand.amount);
  const rate = parseNumber(creator.rate);
  if (budget && rate) {
    if (rate.value <= budget.value) {
      score += 30;
      reasons.push('creator rate is within the stated budget');
    } else {
      gaps.push('creator rate is above the stated budget');
    }
  } else if (budget && !rate) {
    gaps.push('creator rate missing');
  }
  const requirements = String(brand.requirements || '');
  const minFollowersMatch = requirements.match(/(\d+(?:\.\d+)?)\s*([km])?\s*(?:followers|subs|subscribers)/i);
  if (minFollowersMatch) {
    const number = Number(minFollowersMatch[1]) * (minFollowersMatch[2] ? (minFollowersMatch[2].toLowerCase() === 'm' ? 1000000 : 1000) : 1);
    const followers = parseNumber(creator.followers);
    if (followers && followers.value >= number) {
      score += 20;
      reasons.push('meets stated follower requirement');
    } else if (followers) {
      gaps.push('followers below stated requirement');
    } else {
      gaps.push('creator follower count missing');
    }
  }
  const availability = normalize(creator.availability);
  if (availability && /(not available|unavailable|busy|booked)/.test(availability)) {
    score -= 40;
    gaps.push('creator marked unavailable');
  } else if (/(available|open|free)/.test(availability)) {
    score += 5;
    reasons.push('creator marked available');
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, gaps };
}

async function gmailSearchSummaries(context, query, maxResults) {
  const listed = await context.google.gmailListMessages(query, maxResults);
  const ids = ((listed.messages || []).map((item) => item.id)).filter(Boolean);
  const messages = [];
  for (const id of ids) {
    const message = await context.google.gmailGetMessage(id, 'metadata');
    messages.push(messageSummary(message));
  }
  return { listed, messages };
}

function normalizeSubject(value) {
  return normalize(String(value || '').replace(/^(re|fwd):\s*/gi, ''));
}

async function checkRecentOutreach(context, recipients, subject) {
  let email = '';
  try {
    const parsed = normalizeAddress(recipients);
    const match = parsed.match(/<([^>]+)>/);
    email = match ? match[1] : parsed;
  } catch (_) {
    return { checked: false, duplicate: false, reason: 'Recipient address could not be parsed.' };
  }
  const scopes = context.google.grantedScopes();
  if (!hasAnyScope(scopes, [GMAIL_READ, 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'])) {
    return { checked: false, duplicate: false, reason: 'Gmail read permission is not granted; only local idempotency was checked.' };
  }
  try {
    const listed = await context.google.gmailListMessages(`to:${email} from:me newer_than:30d`, 10);
    const subjectKey = normalizeSubject(subject);
    const duplicates = [];
    for (const item of listed.messages || []) {
      const message = await context.google.gmailGetMessage(item.id, 'metadata');
      const summary = messageSummary(message);
      if (normalizeSubject(summary.subject) === subjectKey) {
        duplicates.push({
          messageId: summary.id,
          threadId: summary.threadId,
          date: summary.date,
          subject: summary.subject
        });
      }
    }
    return { checked: true, duplicate: duplicates.length > 0, duplicates, recipient: email };
  } catch (error) {
    return { checked: false, duplicate: false, reason: `Duplicate check failed: ${error.message}` };
  }
}

function sentHash(parsed) {
  return crypto
    .createHash('sha256')
    .update(
      [
        normalize(parsed.to),
        normalize(parsed.subject),
        String(parsed.body || '').trim()
      ].join('\n')
    )
    .digest('hex');
}

function buildSendPreview(context, args) {
  const parsed = buildMimeMessage(args);
  const hash = sentHash(parsed);
  const existing = context.store.getSentRecord(hash);
  return {
    preview: {
      title: 'Send email',
      from: context.store.getMeta().gmailEmail || (context.store.getTokens() || {}).accountEmail || 'authorized Gmail account',
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      body: parsed.body,
      threadId: args.threadId || '',
      idempotencyHash: hash.slice(0, 16) + '...',
      warning: 'This will send a real email after the exact confirmation phrase is entered.'
    },
    parsed,
    hash,
    existing
  };
}

function gmailConnectionStatus(context) {
  const tokens = context.store.getTokens();
  const meta = context.store.getMeta();
  const scopes = context.google.grantedScopes();
  return {
    connected: Boolean(tokens && (tokens.access_token || tokens.refresh_token)),
    account: meta.gmailEmail || (tokens && tokens.accountEmail) || '',
    scopesGranted: scopes,
    capabilities: {
      read: hasAnyScope(scopes, [GMAIL_READ, 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']),
      draft: Boolean(context.config.enableGmailWrite && scopes.includes(GMAIL_COMPOSE)),
      send: Boolean(
        context.config.enableGmailWrite &&
          hasAnyScope(scopes, [GMAIL_SEND, GMAIL_COMPOSE])
      )
    },
    writeEnabledByConfig: context.config.enableGmailWrite,
    lastTestAt: meta.gmailTestedAt || '',
    lastError: meta.gmailLastError || ''
  };
}

function spreadsheetConnectionStatus(context) {
  const tokens = context.store.getTokens();
  const meta = context.store.getMeta();
  const scopes = context.google.grantedScopes();
  return {
    connected: Boolean(tokens && (tokens.access_token || tokens.refresh_token)),
    spreadsheetId: context.config.spreadsheetId,
    title: meta.spreadsheetTitle || '',
    verifiedAt: meta.spreadsheetVerifiedAt || '',
    lastSyncAt: meta.lastSyncAt || '',
    lastError: meta.spreadsheetLastError || meta.lastSyncError || '',
    capabilities: {
      read: hasAnyScope(scopes, [SHEET_READ_FULL, SHEET_READ_ONLY]),
      write: Boolean(context.config.enableSheetWrite && scopes.includes(SHEET_READ_FULL))
    },
    writeEnabledByConfig: context.config.enableSheetWrite
  };
}

const handlers = {
  async get_spreadsheet_status(context, args) {
    const status = spreadsheetConnectionStatus(context);
    if (args && args.probe && status.connected) {
      try {
        const metadata = await context.google.sheetsMetadata();
        status.probe = {
          ok: true,
          title: metadata.properties ? metadata.properties.title : '',
          spreadsheetId: metadata.spreadsheetId,
          worksheetCount: (metadata.sheets || []).length
        };
        context.store.updateMeta({
          spreadsheetTitle: status.probe.title,
          spreadsheetVerifiedAt: new Date().toISOString(),
          spreadsheetLastError: ''
        });
      } catch (error) {
        status.probe = { ok: false, error: error.message };
        context.store.updateMeta({ spreadsheetLastError: error.message });
      }
    }
    return status;
  },

  async list_worksheets(context) {
    const workbook = await context.workbook.load();
    return {
      spreadsheetTitle: workbook.title,
      spreadsheetId: workbook.spreadsheetId,
      fetchedAt: workbook.fetchedAtIso,
      worksheets: workbook.headers
    };
  },

  async get_sheet_headers(context, args) {
    const workbook = await context.workbook.load();
    const requested = args && args.worksheet ? normalize(args.worksheet) : '';
    const rows = requested
      ? workbook.headers.filter((item) => normalize(item.title) === requested)
      : workbook.headers;
    if (requested && !rows.length) {
      throw new ToolError('WORKSHEET_NOT_FOUND', `Worksheet "${args.worksheet}" was not found.`);
    }
    return { spreadsheetTitle: workbook.title, worksheets: rows };
  },

  async search_brands(context, args) {
    const workbook = await context.workbook.load();
    let records = recordsByRole(workbook, ['brands', 'brand requirements']);
    if (!records.length) {
      records = recordsForWorkbook(workbook).filter((record) => record.mapped.brandName);
    }
    const result = searchRecords(records, args.query || '', args.limit || 25);
    return {
      spreadsheetTitle: workbook.title,
      query: args.query || '',
      totalMatches: result.total,
      records: result.matches.map(compactRecord)
    };
  },

  async search_creators(context, args) {
    const workbook = await context.workbook.load();
    let records = recordsByRole(workbook, ['creators']);
    if (!records.length) {
      records = recordsForWorkbook(workbook).filter((record) => record.mapped.creatorName);
    }
    const result = searchRecords(records, args.query || '', args.limit || 25);
    return {
      spreadsheetTitle: workbook.title,
      query: args.query || '',
      totalMatches: result.total,
      records: result.matches.map(compactRecord)
    };
  },

  async get_campaigns(context, args) {
    const workbook = await context.workbook.load();
    const records = recordsByRole(workbook, ['campaigns']);
    const result = searchRecords(records, args.query || '', args.limit || 25);
    return {
      spreadsheetTitle: workbook.title,
      query: args.query || '',
      totalMatches: result.total,
      records: result.matches.map(compactRecord)
    };
  },

  async find_creator_brand_matches(context, args) {
    const workbook = await context.workbook.load();
    const brands = recordsForWorkbook(workbook).filter((record) => record.mapped.brandName);
    const brandMatches = searchRecords(brands, args.brand, 25).matches;
    if (!brandMatches.length) {
      throw new ToolError('RECORD_NOT_FOUND', `No brand matched "${args.brand}".`);
    }
    const brandKey = normalize(args.brand);
    let brand = brandMatches.find((record) => normalize(record.mapped.brandName) === brandKey);
    if (!brand) brand = brandMatches[0];
    let creators = recordsByRole(workbook, ['creators']);
    if (!creators.length) {
      creators = recordsForWorkbook(workbook).filter((record) => record.mapped.creatorName);
    }
    if (!creators.length) {
      throw new ToolError('RECORD_NOT_FOUND', 'No mapped creator records were found.');
    }
    const scored = creators.map((record) => {
      const scoring = scoreCreator(brand.mapped, record.mapped);
      return {
        score: scoring.score,
        reasons: scoring.reasons,
        gaps: scoring.gaps,
        creator: compactRecord(record)
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const limit = Math.max(1, Math.min(Number(args.limit || 10), 25));
    return {
      spreadsheetTitle: workbook.title,
      brand: compactRecord(brand),
      criteriaUsed: {
        category: brand.mapped.category || '',
        platform: brand.mapped.platform || '',
        location: brand.mapped.location || '',
        language: brand.mapped.language || '',
        budget: brand.mapped.budget || brand.mapped.amount || '',
        requirements: brand.mapped.requirements || ''
      },
      scoringNote:
        'Scores use only mapped spreadsheet values. Missing values are reported as gaps; no creator details were invented.',
      candidates: scored.slice(0, limit)
    };
  },

  async get_outreach_status(context, args) {
    const workbook = await context.workbook.load();
    let records = recordsByRole(workbook, ['outreach', 'deals']);
    if (!records.length) records = recordsForWorkbook(workbook);
    if (args.status) {
      const needle = normalize(args.status);
      records = records.filter((record) => {
        const text = normalize(
          [record.mapped.outreachStatus, record.mapped.dealStatus, record.mapped.status]
            .filter(Boolean)
            .join(' ')
        );
        return text.includes(needle);
      });
    }
    const result = searchRecords(records, args.query || '', args.limit || 25);
    return {
      spreadsheetTitle: workbook.title,
      totalMatches: result.total,
      records: result.matches.map(compactRecord)
    };
  },

  async get_pending_followups(context, args) {
    const workbook = await context.workbook.load();
    const items = pendingFollowups(workbook, args.daysAhead === undefined ? 7 : args.daysAhead, args.limit || 50);
    return {
      spreadsheetTitle: workbook.title,
      asOf: new Date().toISOString(),
      pendingCount: items.length,
      pendingFollowups: items
    };
  },

  async add_brand(context, args) {
    return addRecord(context, 'brands', 'brandName', args);
  },

  async add_creator(context, args) {
    return addRecord(context, 'creators', 'creatorName', args);
  },

  async update_outreach_status(context, args) {
    if (!String(args.status || '').trim()) {
      throw new ToolError('MISSING_FIELDS', 'New outreach status is required.');
    }
    const prepared = await updatePreparation(context, 'outreachStatus', args);
    return applyUpdate(context, prepared);
  },

  async update_deal_status(context, args) {
    if (!String(args.status || '').trim()) {
      throw new ToolError('MISSING_FIELDS', 'New deal status is required.');
    }
    const prepared = await updatePreparation(context, 'dealStatus', args);
    return applyUpdate(context, prepared);
  },

  async log_campaign_activity(context, args) {
    const prepared = await logActivityPreparation(context, args);
    return applyLogActivity(context, prepared, args);
  },

  async generate_agency_report(context, args) {
    const workbook = await context.workbook.load();
    const allRecords = recordsForWorkbook(workbook);
    const byRole = {};
    for (const sheet of workbook.sheets) {
      byRole[sheet.role] = byRole[sheet.role] || {
        worksheets: [],
        recordCount: 0,
        statusCounts: {}
      };
      byRole[sheet.role].worksheets.push(sheet.title);
      const records = sheet.dataRows.map((rowInfo) => {
        const mapped = {};
        for (const field of Object.keys(sheet.fields)) {
          const value = String(rowInfo.values[sheet.fields[field]] || '').trim();
          if (value) mapped[field] = value;
        }
        return { mapped };
      });
      byRole[sheet.role].recordCount += records.length;
      const counts = statusCounts(records);
      for (const key of Object.keys(counts)) {
        byRole[sheet.role].statusCounts[key] =
          (byRole[sheet.role].statusCounts[key] || 0) + counts[key];
      }
    }
    const includePending = !args || args.includePendingFollowups !== false;
    return {
      spreadsheetTitle: workbook.title,
      generatedAt: new Date().toISOString(),
      totalRecords: allRecords.length,
      worksheets: workbook.headers,
      byRole,
      pendingFollowups: includePending ? pendingFollowups(workbook, 7, 50) : [],
      note: 'This report contains spreadsheet facts only. Gmail pending replies are reported by identify_pending_replies.'
    };
  },

  async get_gmail_status(context) {
    return gmailConnectionStatus(context);
  },

  async search_emails(context, args) {
    if (!args.query || !String(args.query).trim()) {
      throw new ToolError('MISSING_FIELDS', 'A Gmail search query is required.');
    }
    const result = await gmailSearchSummaries(
      context,
      String(args.query),
      args.maxResults || 10
    );
    return {
      query: args.query,
      resultSizeEstimate: result.listed.resultSizeEstimate || result.messages.length,
      messages: result.messages
    };
  },

  async get_email_thread(context, args) {
    const thread = await context.google.gmailGetThread(args.threadId);
    return threadSummary(thread, { includeMessages: true });
  },

  async summarize_business_replies(context, args) {
    const days = 7;
    const query = args.query || `newer_than:${days}d -from:me`;
    const listed = await context.google.gmailListMessages(query, 20);
    const threadIds = Array.from(
      new Set((listed.messages || []).map((item) => item.threadId || item.id).filter(Boolean))
    ).slice(0, Math.max(1, Math.min(Number(args.maxThreads || 5), 10)));
    const threads = [];
    for (const threadId of threadIds) {
      const thread = await context.google.gmailGetThread(threadId);
      threads.push(threadSummary(thread, { includeMessages: true }));
    }
    let contextText = 'Spreadsheet brand/creator names are not loaded for this summary.';
    try {
      const workbook = await context.workbook.load();
      const names = recordsForWorkbook(workbook)
        .map((record) => recordName(record.mapped))
        .filter(Boolean)
        .slice(0, 80);
      contextText = `Known spreadsheet names (for correlation only): ${names.join(', ')}`;
    } catch (_) {
      // Gmail summaries can still run without spreadsheet access.
    }
    const aiResult = await context.ai.summarizeReplies(threads, contextText);
    return {
      query,
      threadCount: threads.length,
      ai: aiResult,
      threads,
      instruction: aiResult.available
        ? 'Use the ai.summary as a draft summary, but verify against the real thread text.'
        : 'Backend AI is unavailable. Summarize only the real thread text above using the app AI; never invent a reply.',
      threadText: threads.map((thread) => `Thread ${thread.id}\n${threadToText(thread)}`).join('\n\n===\n\n')
    };
  },

  async create_email_draft(context, args) {
    const parsed = buildMimeMessage(args);
    if (!args.allowDuplicate) {
      const duplicate = await checkRecentOutreach(context, parsed.to, parsed.subject);
      if (duplicate.duplicate) {
        throw new ToolError(
          'DUPLICATE_OUTREACH',
          'A similar email to this recipient was already sent in the last 30 days. No draft was created.',
          duplicate
        );
      }
    }
    const draft = await context.google.gmailCreateDraft(parsed.rawBase64Url);
    return {
      created: true,
      draftId: draft.id,
      messageId: draft.message ? draft.message.id : '',
      threadId: draft.message ? draft.message.threadId : '',
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      sent: false,
      note: 'Draft saved in Gmail. Nothing was sent.'
    };
  },

  async list_drafts(context, args) {
    const listed = await context.google.gmailListDrafts(args.maxResults || 10);
    const drafts = [];
    for (const item of (listed.drafts || []).slice(0, 10)) {
      try {
        const draft = await context.google.gmailGetDraft(item.id);
        const summary = messageSummary(draft.message || {});
        drafts.push({
          draftId: draft.id,
          messageId: summary.id,
          threadId: summary.threadId,
          to: summary.to,
          subject: summary.subject,
          date: summary.date,
          snippet: summary.snippet
        });
      } catch (_) {
        drafts.push({ draftId: item.id, error: 'Draft metadata could not be read.' });
      }
    }
    return { draftCount: drafts.length, drafts };
  },

  async send_approved_email(context, args) {
    const built = buildSendPreview(context, args);
    if (built.existing) {
      throw new ToolError(
        'DUPLICATE_SEND',
        'This exact email was already sent by SK Assistant. It was not sent again.',
        built.existing
      );
    }
    if (!args.allowDuplicate) {
      const duplicate = await checkRecentOutreach(context, built.parsed.to, built.parsed.subject);
      if (duplicate.duplicate) {
        throw new ToolError(
          'DUPLICATE_OUTREACH',
          'A similar email to this recipient was already sent in the last 30 days. It was not sent again.',
          duplicate
        );
      }
    }
    const sent = await context.google.gmailSend(built.parsed.rawBase64Url, args.threadId);
    context.store.setSentRecord(built.hash, {
      messageId: sent.id,
      threadId: sent.threadId,
      to: built.parsed.to,
      subject: built.parsed.subject
    });
    return {
      sent: true,
      messageId: sent.id,
      threadId: sent.threadId,
      labelIds: sent.labelIds || [],
      to: built.parsed.to,
      subject: built.parsed.subject,
      sentAt: new Date().toISOString()
    };
  },

  async identify_pending_replies(context, args) {
    const days = Math.max(1, Math.min(Number(args.days || 30), 90));
    const query = `is:unread in:inbox newer_than:${days}d -category:promotions`;
    const result = await gmailSearchSummaries(
      context,
      query,
      args.maxResults || 20
    );
    const seen = new Set();
    const pending = [];
    for (const message of result.messages) {
      const key = message.threadId || message.id;
      if (seen.has(key)) continue;
      seen.add(key);
      let matchedBrand = '';
      let matchedCreator = '';
      try {
        const workbook = await context.workbook.load();
        const records = recordsForWorkbook(workbook);
        const senderText = normalize(`${message.from} ${message.subject} ${message.snippet}`);
        const brandRecord = records.find((record) => {
          const candidate = normalize(
            [record.mapped.brandName, record.mapped.brandEmail, record.mapped.email].filter(Boolean).join(' ')
          );
          if (!candidate) return false;
          if (record.mapped.brandEmail && message.from.toLowerCase().includes(record.mapped.brandEmail.toLowerCase())) {
            return true;
          }
          return senderText.includes(normalize(record.mapped.brandName || ''));
        });
        const creatorRecord = records.find((record) => {
          if (record.mapped.creatorEmail && message.from.toLowerCase().includes(record.mapped.creatorEmail.toLowerCase())) {
            return true;
          }
          return (
            record.mapped.creatorName &&
            senderText.includes(normalize(record.mapped.creatorName))
          );
        });
        if (brandRecord) matchedBrand = brandRecord.mapped.brandName || '';
        if (creatorRecord) matchedCreator = creatorRecord.mapped.creatorName || '';
      } catch (_) {
        // Correlation is optional; pending Gmail replies are still returned.
      }
      pending.push({
        threadId: message.threadId,
        messageId: message.id,
        from: message.from,
        subject: message.subject,
        date: message.date,
        snippet: message.snippet,
        matchedBrand,
        matchedCreator,
        labels: message.labelIds
      });
    }
    return {
      query,
      pendingCount: pending.length,
      pendingReplies: pending,
      note: 'No messages were marked read and no replies were sent.'
    };
  }
};

async function previewTool(context, name, args) {
  const definition = DEFINITIONS_BY_NAME[name];
  if (!definition) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  ensureAvailable(definition, context);
  if (name === 'add_brand') return previewAddRecord(context, 'brands', 'brandName', args);
  if (name === 'add_creator') return previewAddRecord(context, 'creators', 'creatorName', args);
  if (name === 'update_outreach_status') {
    const prepared = await updatePreparation(context, 'outreachStatus', args);
    return updatePreview(prepared, 'Update outreach status');
  }
  if (name === 'update_deal_status') {
    const prepared = await updatePreparation(context, 'dealStatus', args);
    return updatePreview(prepared, 'Update deal status');
  }
  if (name === 'log_campaign_activity') {
    const prepared = await logActivityPreparation(context, args);
    return {
      title: 'Log campaign activity',
      worksheet: prepared.sheet.title,
      rowNumber: prepared.record.rowNumber,
      recordName: recordName(prepared.record.mapped),
      activity: args.activity,
      date: args.date || '',
      columns: [
        prepared.sheet.headers[prepared.activityIndex],
        prepared.dateIndex !== undefined && args.date ? prepared.sheet.headers[prepared.dateIndex] : null
      ].filter(Boolean)
    };
  }
  if (name === 'send_approved_email') {
    const built = buildSendPreview(context, args);
    if (built.existing) {
      const error = new ToolError(
        'DUPLICATE_SEND',
        'This exact email was already sent by SK Assistant. It was not sent again.',
        built.existing
      );
      error.status = 409;
      throw error;
    }
    if (!args.allowDuplicate) {
      const duplicate = await checkRecentOutreach(context, built.parsed.to, built.parsed.subject);
      if (duplicate.duplicate) {
        const error = new ToolError(
          'DUPLICATE_OUTREACH',
          'A similar email to this recipient was already sent in the last 30 days. It was not sent again.',
          duplicate
        );
        error.status = 409;
        throw error;
      }
      built.preview.duplicateCheck = duplicate;
    } else {
      built.preview.warning += ' Duplicate protection was explicitly overridden.';
    }
    return built.preview;
  }
  if (name === 'create_email_draft') {
    const parsed = buildMimeMessage(args);
    return {
      title: 'Create Gmail draft (not sent)',
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      body: parsed.body,
      sent: false
    };
  }
  throw new ToolError('APPROVAL_NOT_SUPPORTED', `${name} does not require approval.`);
}

async function executeTool(context, name, args) {
  const definition = DEFINITIONS_BY_NAME[name];
  if (!definition) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  ensureAvailable(definition, context);
  const handler = handlers[name];
  if (!handler) throw new ToolError('UNKNOWN_TOOL', `No implementation exists for ${name}.`);
  return handler(context, args || {});
}

module.exports = {
  ToolError,
  toolDefinitions,
  listTools,
  availabilityFor,
  previewTool,
  executeTool,
  columnLetter,
  findRecord,
  gmailConnectionStatus,
  spreadsheetConnectionStatus
};
